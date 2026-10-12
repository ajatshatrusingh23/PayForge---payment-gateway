import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Consumer, Kafka, KafkaMessage, logLevel, Message, Partitioners, Producer } from 'kafkajs';
import { config, counter } from '@app/common';
import { ALL_TOPICS, DomainEvent, Topics } from './events';

export const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');

export interface MessagingOptions {
  clientId: string;
  /** Run the transactional-outbox relay in this service (only for services that produce events). */
  outbox?: boolean;
}

export interface EventMeta {
  topic: string;
  partition: number;
  offset: string;
}

export type EventHandler = (event: DomainEvent, meta: EventMeta) => Promise<void>;

const HANDLER_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const consumedEvents = counter('payforge_events_consumed_total', 'Events consumed from Kafka', ['group', 'type', 'outcome'] as const);

/**
 * Thin wrapper around kafkajs.
 *  - Producer is idempotent (no duplicates from producer retries) with acks=all.
 *  - Connection happens in the background so a service starts (and keeps
 *    accepting payments) even while Kafka is down; the outbox buffers events.
 *  - Consumers retry a failing handler with backoff, then park the message on a
 *    dead-letter topic so one poison message cannot block a partition forever.
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Kafka');
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Consumer[] = [];
  private producerReady = false;
  private topicsEnsured = false;
  private stopped = false;

  constructor(@Inject(MESSAGING_OPTIONS) private readonly opts: MessagingOptions) {
    this.kafka = new Kafka({
      clientId: `payforge-${opts.clientId}`,
      brokers: config.kafkaBrokers,
      retry: { initialRetryTime: 300, retries: 5 },
      logLevel: logLevel.ERROR,
      logCreator: () => (entry) => {
        // Several services create the shared topics at startup; "already exists" races are expected.
        const text = `${entry.log.message} ${String(entry.log.error ?? '')}`;
        if (this.stopped || /CreateTopics|already exists/i.test(text)) return;
        this.logger.warn(`[kafkajs] ${entry.log.message}${entry.log.error ? `: ${String(entry.log.error)}` : ''}`);
      },
    });
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  onModuleInit(): void {
    void this.connectProducer();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([this.producer.disconnect(), ...this.consumers.map((c) => c.disconnect())]);
  }

  isReady(): boolean {
    return this.producerReady;
  }

  async publish(topic: string, messages: Message[]): Promise<void> {
    if (!this.producerReady) throw new Error('Kafka producer is not connected');
    await this.producer.send({ topic, acks: -1, messages });
  }

  /** Starts a consumer group in the background. Handlers MUST be idempotent (delivery is at-least-once). */
  subscribe(groupId: string, topics: string[], handler: EventHandler): void {
    void this.runConsumer(groupId, topics, handler);
  }

  private async connectProducer(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureTopics();
        await this.producer.connect();
        this.producerReady = true;
        this.logger.log('Kafka producer connected');
        return;
      } catch (err) {
        this.logger.warn(`Kafka unavailable (${(err as Error).message}); retrying in 3s`);
        await sleep(3_000);
      }
    }
  }

  private async ensureTopics(): Promise<void> {
    if (this.topicsEnsured) return;
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: ALL_TOPICS.map((topic) => ({
          topic,
          numPartitions: parseInt(process.env.KAFKA_PARTITIONS ?? '6', 10),
          replicationFactor: parseInt(process.env.KAFKA_REPLICATION_FACTOR ?? '1', 10),
        })),
      });
      this.topicsEnsured = true;
    } finally {
      await admin.disconnect();
    }
  }

  private async runConsumer(groupId: string, topics: string[], handler: EventHandler): Promise<void> {
    while (!this.stopped) {
      const consumer = this.kafka.consumer({
        groupId: `payforge-${groupId}`,
        sessionTimeout: 30_000,
        heartbeatInterval: 3_000,
        retry: { retries: 10 },
      });
      try {
        await this.ensureTopics();
        await consumer.connect();
        await consumer.subscribe({ topics, fromBeginning: true });
        await consumer.run({
          partitionsConsumedConcurrently: 3,
          eachMessage: ({ topic, partition, message }) => this.handleMessage(groupId, topic, partition, message, handler),
        });
        this.consumers.push(consumer);
        this.logger.log(`Consumer group "${groupId}" subscribed to ${topics.join(', ')}`);
        return;
      } catch (err) {
        this.logger.warn(`Consumer "${groupId}" failed to start (${(err as Error).message}); retrying in 3s`);
        await consumer.disconnect().catch(() => undefined);
        await sleep(3_000);
      }
    }
  }

  private async handleMessage(
    groupId: string,
    topic: string,
    partition: number,
    message: KafkaMessage,
    handler: EventHandler,
  ): Promise<void> {
    if (!message.value) return;
    let event: DomainEvent;
    try {
      event = JSON.parse(message.value.toString()) as DomainEvent;
    } catch {
      this.logger.error(`Unparseable message at ${topic}/${partition}@${message.offset}; sending to DLQ`);
      await this.deadLetter(groupId, topic, message, 'unparseable message');
      return;
    }

    for (let attempt = 1; attempt <= HANDLER_ATTEMPTS; attempt++) {
      try {
        await handler(event, { topic, partition, offset: message.offset });
        consumedEvents.inc({ group: groupId, type: event.type, outcome: 'ok' });
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt === HANDLER_ATTEMPTS) {
          this.logger.error(`Handler ${groupId} failed for ${event.type} ${event.id} after ${attempt} attempts: ${msg}`);
          consumedEvents.inc({ group: groupId, type: event.type, outcome: 'dead_letter' });
          await this.deadLetter(groupId, topic, message, msg);
          return;
        }
        this.logger.warn(`Handler ${groupId} attempt ${attempt} failed for ${event.type} ${event.id}: ${msg}`);
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  private async deadLetter(groupId: string, topic: string, message: KafkaMessage, reason: string): Promise<void> {
    try {
      await this.publish(Topics.deadLetter, [
        {
          key: message.key,
          value: message.value,
          headers: { 'source-topic': topic, 'consumer-group': groupId, error: reason.slice(0, 500) },
        },
      ]);
    } catch (err) {
      this.logger.error(`Could not write to dead-letter topic: ${(err as Error).message}`);
    }
  }
}
