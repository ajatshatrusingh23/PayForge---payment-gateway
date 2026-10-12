'use client';

import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, Empty, ErrorNote, Field, inputClass, Loading, Mono, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiFetch, useApi } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import type { List, RiskAssessment } from '@/lib/types';

interface Rules {
  thresholds: { challenge: number; block: number };
  velocity_window_seconds: number;
  rules: Array<{ id: string; description: string }>;
}
interface BlockEntry {
  id: string;
  type: string;
  value: string;
  reason: string | null;
  created_at: string;
}

export default function RiskPage() {
  const { data: rules } = useApi<Rules>('/v1/risk/rules');
  const { data: assessments } = useApi<List<RiskAssessment>>('/v1/risk/assessments', { refreshInterval: 5_000 });
  const { data: blocklist, mutate } = useApi<List<BlockEntry>>('/v1/risk/blocklist');
  const [form, setForm] = useState({ type: 'email', value: '', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/risk/blocklist', { method: 'POST', body: { ...form, reason: form.reason || undefined } });
      setForm((s) => ({ ...s, value: '', reason: '' }));
      await mutate();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Risk"
        description="Every confirm is scored in real time (velocity windows in Redis, blocklists, amount anomalies). Medium risk is stepped up to OTP, high risk is blocked before reaching any bank."
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Rules" subtitle={rules ? `Score ≥ ${rules.thresholds.challenge} → OTP challenge · ≥ ${rules.thresholds.block} → block` : undefined}>
          {rules ? (
            <ul className="space-y-2 text-sm">
              {rules.rules.map((r) => (
                <li key={r.id}>
                  <Mono className="text-ink">{r.id}</Mono>
                  <div className="text-ink-2">{r.description}</div>
                </li>
              ))}
            </ul>
          ) : (
            <Loading />
          )}
        </Card>

        <Card title="Blocklist" className="lg:col-span-2" padded={false}>
          <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-b border-line p-5">
            <Field label="Type">
              <select className={inputClass} value={form.type} onChange={(e) => { const v = e.target.value; setForm((s) => ({ ...s, type: v })); }}>
                <option value="email">Email</option>
                <option value="ip">IP address</option>
                <option value="vpa">UPI ID</option>
                <option value="fingerprint">Card fingerprint</option>
              </select>
            </Field>
            <div className="min-w-56 flex-1">
              <Field label="Value">
                <input className={inputClass} required value={form.value} onChange={(e) => { const v = e.target.value; setForm((s) => ({ ...s, value: v })); }} placeholder="fraudster@example.com" />
              </Field>
            </div>
            <div className="min-w-40 flex-1">
              <Field label="Reason (optional)">
                <input className={inputClass} value={form.reason} onChange={(e) => { const v = e.target.value; setForm((s) => ({ ...s, reason: v })); }} />
              </Field>
            </div>
            <Button variant="primary" type="submit" loading={busy}>
              Block
            </Button>
            <div className="w-full">
              <ErrorNote error={error} />
            </div>
          </form>
          {blocklist?.data.length ? (
            <Table>
              <tbody>
                {blocklist.data.map((b) => (
                  <tr key={b.id}>
                    <Td className="capitalize text-ink-2">{b.type}</Td>
                    <Td>
                      <Mono className="text-ink">{b.value}</Mono>
                    </Td>
                    <Td className="text-ink-2">{b.reason ?? '—'}</Td>
                    <Td className="text-muted">{ago(b.created_at)}</Td>
                    <Td align="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${b.value}`}
                        onClick={async () => {
                          await apiFetch(`/v1/risk/blocklist/${b.id}`, { method: 'DELETE' });
                          await mutate();
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty title="Nothing blocked">Tip: open a payment and use “Block card” to add its fingerprint.</Empty>
          )}
        </Card>
      </div>

      <Card title="Recent assessments" subtitle="Each decision is stored with the exact rules that fired (explainable risk)" padded={false}>
        {!assessments ? (
          <Loading />
        ) : assessments.data.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Payment</Th>
                <Th>Decision</Th>
                <Th align="right">Score</Th>
                <Th>Signals</Th>
                <Th align="right">Latency</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {assessments.data.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link className="font-mono text-xs text-accent hover:underline" href={`/payments/${a.payment_intent_id}`}>
                      {a.payment_intent_id}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={a.decision} />
                  </Td>
                  <Td align="right" className="font-medium">
                    {a.score}
                  </Td>
                  <Td className="text-ink-2">{a.reasons.length ? a.reasons.map((r) => r.rule).join(', ') : '—'}</Td>
                  <Td align="right" className="text-muted">
                    {a.latency_ms} ms
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{dateTime(a.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No assessments yet" />
        )}
      </Card>
    </>
  );
}
