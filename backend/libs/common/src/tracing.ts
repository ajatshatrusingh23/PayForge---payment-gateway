/**
 * OpenTelemetry bootstrap. Import this FIRST in a service's main.ts so the
 * auto-instrumentations can patch http, express, pg, ioredis and kafkajs before
 * they are loaded. One trace then follows a payment from the gateway through
 * payment -> risk -> vault -> bank simulator, and across Kafka into ledger/webhooks.
 *
 * Disabled by default; enable with OTEL_ENABLED=true (needs Jaeger, see infra/).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export function startTracing(serviceName: string): void {
  if (process.env.OTEL_ENABLED !== 'true') return;
  process.env.OTEL_SERVICE_NAME ??= `payforge-${serviceName}`;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  const shutdown = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
