'use client';

import { ArrowLeft, Ban, CircleCheck, CircleX, Dot, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CopyText, Empty, ErrorNote, Field, inputClass, KeyValue, Loading, Mono, StatusBadge, Table, Td, Th, cx } from '@/components/ui';
import { apiFetch, newIdempotencyKey, useApi } from '@/lib/api';
import { dateTime, humanize, inr, paymentMethodLabel } from '@/lib/format';
import type { Journal, List, PaymentIntent, RiskAssessment, Timeline, WebhookDelivery } from '@/lib/types';

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: pi, mutate } = useApi<PaymentIntent>(`/v1/payment_intents/${id}`, { refreshInterval: 4_000 });
  const { data: timeline, mutate: mutateTimeline } = useApi<Timeline>(`/v1/payment_intents/${id}/timeline`, { refreshInterval: 4_000 });
  const { data: risk } = useApi<List<RiskAssessment>>(`/v1/risk/assessments?payment_intent=${id}`);
  const { data: journals } = useApi<List<Journal>>(`/v1/ledger/journals?reference=${id}`, { refreshInterval: 5_000 });
  const { data: deliveries } = useApi<List<WebhookDelivery>>(`/v1/webhook_deliveries?object_id=${id}`, { refreshInterval: 5_000 });

  if (!pi) return <Loading />;
  const refresh = () => Promise.all([mutate(), mutateTimeline()]);

  return (
    <>
      <Link href="/payments" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Payments
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">{inr(pi.amount)}</h1>
            <StatusBadge status={pi.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <CopyText value={pi.id} />
            <span>{pi.description}</span>
            <span className="text-muted">{dateTime(pi.created_at)}</span>
          </div>
        </div>
        <Actions pi={pi} onDone={refresh} />
      </header>

      {pi.last_payment_error && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          <CircleX className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
          <div>
            <span className="font-medium">{humanize(pi.last_payment_error.decline_code ?? pi.last_payment_error.code)}</span>
            <span className="text-ink-2">: {pi.last_payment_error.message}</span>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Timeline" subtitle="Domain events and every acquirer attempt (failovers, timeouts and retries show up here)">
            <TimelineList timeline={timeline} />
          </Card>

          <Card title="Ledger" subtitle="Double-entry journals posted for this payment. Debits always equal credits." padded={false}>
            {journals?.data.length ? (
              journals.data.map((j) => (
                <div key={j.id} className="border-b border-line last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-3 text-xs text-muted">
                    <span>{j.description}</span>
                    <span>
                      <Mono>{j.id}</Mono> · {dateTime(j.created_at)}
                    </span>
                  </div>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Account</Th>
                        <Th align="right">Debit</Th>
                        <Th align="right">Credit</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {j.lines.map((l, i) => (
                        <tr key={i}>
                          <Td>
                            <Mono>{l.account}</Mono>
                          </Td>
                          <Td align="right">{l.direction === 'debit' ? inr(l.amount) : ''}</Td>
                          <Td align="right">{l.direction === 'credit' ? inr(l.amount) : ''}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ))
            ) : (
              <Empty title="No journals yet">Journals are posted when money moves (capture, refund, payout).</Empty>
            )}
          </Card>

          <Card title="Webhook deliveries" padded={false}>
            {deliveries?.data.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Event</Th>
                    <Th>Status</Th>
                    <Th align="right">Attempts</Th>
                    <Th>Last response</Th>
                    <Th>Created</Th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data.map((d) => (
                    <tr key={d.id}>
                      <Td>
                        <Mono>{d.event_type}</Mono>
                      </Td>
                      <Td>
                        <StatusBadge status={d.status} />
                      </Td>
                      <Td align="right">{d.attempts}</Td>
                      <Td className="text-ink-2">{d.last_response_code ?? d.last_error ?? '—'}</Td>
                      <Td className="text-muted">{dateTime(d.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Empty title="No webhook deliveries">Add an endpoint on the Webhooks page to receive events.</Empty>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <KeyValue
              items={[
                ['Payment method', paymentMethodLabel(pi.payment_method_details)],
                ...(pi.payment_method_details?.card
                  ? ([
                      ['Issuer', `${pi.payment_method_details.card.issuer} (${pi.payment_method_details.card.country})`],
                      ['Funding', pi.payment_method_details.card.funding],
                    ] as Array<[string, React.ReactNode]>)
                  : []),
                ['Customer', pi.customer_email],
                ['Capture', pi.capture_method],
                ['Acquirer', <span key="a" className="capitalize">{pi.acquirer ?? '—'}</span>],
                ['Attempts', pi.attempt_count],
                ['Descriptor', pi.statement_descriptor],
                ...Object.entries(pi.metadata ?? {}).map(([k, v]) => [`metadata.${k}`, <Mono key={k}>{v}</Mono>] as [string, React.ReactNode]),
              ]}
            />
          </Card>

          <Card title="Money">
            <KeyValue
              items={[
                ['Amount', inr(pi.amount)],
                ['Received', inr(pi.amount_received)],
                ['Refunded', inr(pi.amount_refunded)],
                ...(pi.fees
                  ? ([
                      [`Fee (${pi.fees.fee_bps / 100}%)`, `− ${inr(pi.fees.fee)}`],
                      ['GST on fee (18%)', `− ${inr(pi.fees.gst)}`],
                      ['Net to you', <strong key="net">{inr(pi.fees.net)}</strong>],
                    ] as Array<[string, React.ReactNode]>)
                  : []),
              ]}
            />
          </Card>

          <Card title="Risk assessment">
            {risk?.data.length ? (
              <div className="space-y-4">
                {risk.data.map((r) => (
                  <div key={r.id}>
                    <div className="flex items-center justify-between">
                      <StatusBadge status={r.decision} />
                      <span className="text-sm">
                        Score <strong className="tabular">{r.score}</strong>
                        <span className="text-muted"> / 100 · {r.latency_ms} ms</span>
                      </span>
                    </div>
                    {r.reasons.length ? (
                      <ul className="mt-2 space-y-1 text-sm">
                        {r.reasons.map((reason) => (
                          <li key={reason.rule} className="flex justify-between gap-3">
                            <span className="text-ink-2">{reason.message}</span>
                            <span className="tabular text-muted">+{reason.score}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted">No risk signals fired.</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Not assessed yet (assessment runs when the customer confirms).</p>
            )}
          </Card>

          {!!timeline?.refunds.length && (
            <Card title="Refunds" padded={false}>
              <Table>
                <tbody>
                  {timeline.refunds.map((r) => (
                    <tr key={r.id}>
                      <Td className="tabular">{inr(r.amount)}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td className="text-muted">{dateTime(r.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Actions({ pi, onDone }: { pi: PaymentIntent; onDone: () => Promise<unknown> }) {
  const [open, setOpen] = useState<'refund' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refundable = pi.amount_received - pi.amount_refunded;

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      setOpen(null);
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {pi.status === 'authorized' && (
          <Button variant="primary" loading={busy === 'capture'} onClick={() => run('capture', () => apiFetch(`/v1/payment_intents/${pi.id}/capture`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }))}>
            <CircleCheck className="size-4" aria-hidden /> Capture {inr(pi.amount_capturable)}
          </Button>
        )}
        {['captured', 'partially_refunded'].includes(pi.status) && refundable > 0 && (
          <Button onClick={() => setOpen(open ? null : 'refund')}>
            <RotateCcw className="size-4" aria-hidden /> Refund
          </Button>
        )}
        {['created', 'failed', 'requires_action', 'authorized'].includes(pi.status) && (
          <Button variant="danger" loading={busy === 'cancel'} onClick={() => run('cancel', () => apiFetch(`/v1/payment_intents/${pi.id}/cancel`, { method: 'POST', body: {} }))}>
            {pi.status === 'authorized' ? 'Void authorization' : 'Cancel payment'}
          </Button>
        )}
        {pi.payment_method_details?.fingerprint && (
          <Button
            variant="ghost"
            loading={busy === 'block'}
            title="Add this card / UPI ID to your blocklist"
            onClick={() =>
              run('block', () =>
                apiFetch('/v1/risk/blocklist', {
                  method: 'POST',
                  body: { type: 'fingerprint', value: pi.payment_method_details!.fingerprint, reason: `Blocked from ${pi.id}` },
                }),
              )
            }
          >
            <Ban className="size-4" aria-hidden /> Block {pi.payment_method_details.type === 'upi' ? 'UPI ID' : 'card'}
          </Button>
        )}
      </div>
      {open === 'refund' && (
        <form
          className="flex items-end gap-2 rounded-xl border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const paise = amount ? Math.round(Number(amount) * 100) : undefined;
            void run('refund', () =>
              apiFetch('/v1/refunds', { method: 'POST', body: { payment_intent: pi.id, ...(paise ? { amount: paise } : {}) }, idempotencyKey: newIdempotencyKey() }),
            );
          }}
        >
          <Field label={`Amount in ₹ (max ${inr(refundable)})`}>
            <input className={`${inputClass} w-44`} inputMode="decimal" placeholder={(refundable / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Button variant="primary" type="submit" loading={busy === 'refund'}>
            Refund
          </Button>
        </form>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function TimelineList({ timeline }: { timeline?: Timeline }) {
  if (!timeline) return <Loading />;
  type Item = { at: string; key: string; title: React.ReactNode; detail?: React.ReactNode; tone: 'good' | 'bad' | 'neutral' };
  const items: Item[] = [
    ...timeline.events.map((e) => ({
      at: e.created_at,
      key: e.id,
      title: <Mono className="text-ink">{e.type}</Mono>,
      tone: (e.type.endsWith('captured') || e.type.endsWith('succeeded') ? 'good' : e.type.includes('failed') ? 'bad' : 'neutral') as Item['tone'],
    })),
    ...timeline.attempts.map((a) => ({
      at: a.created_at,
      key: a.id,
      title: (
        <span>
          Attempt on <span className="font-medium capitalize">{a.acquirer}</span> · <StatusBadge status={a.status} />
        </span>
      ),
      detail: (
        <span>
          <Mono>{a.id}</Mono>
          {a.latency_ms !== null && <> · {a.latency_ms} ms</>}
          {a.decline_code && <> · {humanize(a.decline_code)}</>}
          {a.error_message && <> · {a.error_message}</>}
        </span>
      ),
      tone: (a.status === 'approved' ? 'good' : ['technical_failure', 'declined', 'not_found'].includes(a.status) ? 'bad' : 'neutral') as Item['tone'],
    })),
  ].sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());

  if (!items.length) return <p className="text-sm text-muted">Nothing yet.</p>;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {items.map((item) => (
        <li key={item.key} className="relative">
          <span
            className={cx(
              'absolute top-1 -left-[25px] size-2.5 rounded-full ring-2 ring-surface',
              item.tone === 'good' ? 'bg-good' : item.tone === 'bad' ? 'bg-critical' : 'bg-muted',
            )}
            aria-hidden
          />
          <div className="text-sm">{item.title}</div>
          {item.detail && <div className="mt-0.5 text-xs text-muted">{item.detail}</div>}
          <div className="mt-0.5 flex items-center text-xs text-muted">
            <Dot className="-ml-1.5 size-4" aria-hidden />
            {dateTime(item.at)}
          </div>
        </li>
      ))}
    </ol>
  );
}
