'use client';

import { CircleCheck, CircleX, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Meter } from '@/components/charts';
import { Button, Card, cx, Empty, ErrorNote, Loading, Mono, PageHeader, Segmented, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiFetch, useApi } from '@/lib/api';
import { dateTime, humanize, inr } from '@/lib/format';
import type { AcquirerHealth, List, SimulatorAcquirer } from '@/lib/types';

interface RoutingHealth {
  strategy: 'smart' | 'single';
  exploration_rate: number;
  acquirers: AcquirerHealth[];
}
interface ReconRun {
  id: string;
  acquirer: string;
  business_date: string;
  lines_ingested: number;
  matched: number;
  mismatched: number;
  missing_in_acquirer: number;
  missing_in_platform: number;
  net_settlement: number;
  created_at: string;
}
interface ReconException {
  id: number;
  type: string;
  acquirer: string;
  merchant_ref: string | null;
  platform_amount: number | null;
  acquirer_amount: number | null;
  details: string;
  created_at: string;
}
interface Integrity {
  balanced: boolean;
  total_debits: number;
  total_credits: number;
  journal_count: number;
  line_count: number;
  accounting_equation: { assets_plus_expenses: number; liabilities_plus_revenue: number };
  trial_balance: Array<{ account: string; name: string; type: string; debits: number; credits: number; balance: number }>;
  checked_at: string;
}
interface SettlementRunResult {
  reconciliation: Array<{ acquirer: string; business_date: string; lines_ingested?: number; matched?: number; mismatched?: number; missing_in_acquirer?: number; missing_in_platform?: number; error?: string }>;
  payouts: Array<{ merchant_id: string; status: string; amount?: number; reason?: string; utr?: string }>;
}

const FAILURE_PRESETS = [
  { value: 0, label: '0%' },
  { value: 0.3, label: '30%' },
  { value: 0.8, label: '80%' },
];

export default function OpsPage() {
  const { data: routing, mutate: mutateRouting } = useApi<RoutingHealth>('/v1/routing/health', { refreshInterval: 2_000 });
  const { data: sim, mutate: mutateSim } = useApi<List<SimulatorAcquirer>>('/v1/simulator/acquirers', { refreshInterval: 2_000 });
  const { data: runs, mutate: mutateRuns } = useApi<List<ReconRun>>('/v1/reconciliation/runs');
  const { data: exceptions, mutate: mutateExceptions } = useApi<List<ReconException>>('/v1/reconciliation/exceptions');
  const { data: integrity, mutate: mutateIntegrity } = useApi<Integrity>('/v1/ledger/integrity', { refreshInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastRun, setLastRun] = useState<SettlementRunResult | null>(null);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      await Promise.all([mutateRouting(), mutateSim()]);
    }
  }
  const patch = (code: string, body: Record<string, unknown>) => act(`${code}-${Object.keys(body)[0]}`, () => apiFetch(`/v1/simulator/acquirers/${code}`, { method: 'PATCH', body }));

  return (
    <>
      <PageHeader
        title="Ops & chaos engineering"
        description="Break things on purpose and watch PayForge cope: take an acquirer down and smart routing fails over; corrupt a settlement file and reconciliation catches it; the ledger proves the books still balance."
      />
      <ErrorNote error={error} />

      {/* ------------------------------------------------------------ routing */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Smart routing</h2>
        <div className="flex items-center gap-2">
          {routing && (
            <Segmented<'smart' | 'single'>
              label="Routing strategy"
              value={routing.strategy}
              onChange={(strategy) => act('strategy', () => apiFetch('/v1/routing/strategy', { method: 'POST', body: { strategy } }))}
              options={[
                { value: 'smart', label: 'Smart (health-scored + failover)' },
                { value: 'single', label: 'Naive (single acquirer)' },
              ]}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => act('reset', () => apiFetch('/v1/routing/reset', { method: 'POST' }))} loading={busy === 'reset'}>
            <RotateCcw className="size-3.5" aria-hidden /> Reset stats
          </Button>
        </div>
      </div>

      {!routing || !sim ? (
        <Loading />
      ) : (
        <div className="mb-10 grid gap-4 lg:grid-cols-3">
          {routing.acquirers.map((a) => {
            const s = sim.data.find((x) => x.code === a.code)!;
            return (
              <section key={a.code} className={cx('rounded-xl border bg-surface', s.down ? 'border-critical/50' : 'border-line')}>
                <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
                  <div>
                    <div className="font-semibold">{a.name}</div>
                    <div className="text-xs text-muted">
                      <Mono>{a.code}</Mono> · costs {a.cost_bps / 100}% per txn
                    </div>
                  </div>
                  <StatusBadge status={a.circuit} label={`circuit ${a.circuit.replace('_', '-')}`} />
                </header>
                <div className="space-y-3 px-5 py-4 text-sm">
                  {Object.entries(a.methods).map(([method, m]) => (
                    <div key={method} className="grid grid-cols-[48px_1fr_auto] items-center gap-3">
                      <span className="text-xs font-medium uppercase text-ink-2">{method}</span>
                      <Meter value={m.success_rate} label={`${a.name} ${method} success rate`} />
                      <span className="text-xs tabular text-muted">
                        {m.samples ? `${m.avg_latency_ms} ms · n=${m.samples}` : 'no recent traffic (prior)'} · score {m.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  <div className="text-xs text-muted">
                    {s.stats.requests} requests · {s.stats.technical_failures} technical failures · {s.stats.rejected_while_down} rejected while down
                  </div>
                </div>
                <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
                  <Button size="sm" variant={s.down ? 'primary' : 'danger'} loading={busy === `${a.code}-down`} onClick={() => patch(a.code, { down: !s.down })}>
                    {s.down ? 'Restore' : 'Take down'}
                  </Button>
                  <span className="ml-1 text-xs text-muted">Failure rate</span>
                  {FAILURE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => patch(a.code, { technical_failure_rate: p.value })}
                      className={cx(
                        'rounded-md border px-2 py-0.5 text-xs',
                        Math.abs(s.technical_failure_rate - p.value) < 0.001 ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                  {s.technical_failure_rate > 0 && !FAILURE_PRESETS.some((p) => Math.abs(s.technical_failure_rate - p.value) < 0.001) && (
                    <span className="text-xs text-muted">({(s.technical_failure_rate * 100).toFixed(1)}%)</span>
                  )}
                </footer>
              </section>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------------------ settlement */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Settlement & reconciliation</h2>
        <div className="flex flex-wrap items-center gap-2">
          {sim && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => act('discrepancy', () => Promise.all(sim.data.map((s) => apiFetch(`/v1/simulator/acquirers/${s.code}`, { method: 'PATCH', body: { inject_discrepancy: true } }))))}
            >
              Corrupt next settlement files
            </Button>
          )}
          <Button
            variant="primary"
            loading={busy === 'settle'}
            onClick={() =>
              act('settle', async () => {
                setLastRun(await apiFetch<SettlementRunResult>('/v1/settlements/run', { method: 'POST' }));
                await Promise.all([mutateRuns(), mutateExceptions(), mutateIntegrity()]);
              })
            }
          >
            <Play className="size-4" aria-hidden /> Run reconciliation & payouts now
          </Button>
        </div>
      </div>

      {lastRun && (
        <div className="mb-4 rounded-xl border border-line bg-surface px-5 py-3 text-sm">
          <span className="font-medium">Last run: </span>
          {lastRun.reconciliation.reduce((s, r) => s + (r.matched ?? 0), 0)} matched,{' '}
          {lastRun.reconciliation.reduce((s, r) => s + (r.mismatched ?? 0) + (r.missing_in_acquirer ?? 0) + (r.missing_in_platform ?? 0), 0)} exceptions ·{' '}
          {lastRun.payouts.filter((p) => p.status === 'paid').length} payout(s) sent
          {lastRun.payouts
            .filter((p) => p.status !== 'paid')
            .map((p) => (
              <span key={p.merchant_id} className="text-muted">
                {' '}
                · {humanize(p.status)} ({p.reason})
              </span>
            ))}
        </div>
      )}

      <div className="mb-10 grid gap-6 xl:grid-cols-5">
        <Card title="Reconciliation runs" subtitle="Acquirer settlement files matched line-by-line against our records" padded={false} className="xl:col-span-3">
          {runs?.data.some((r) => r.lines_ingested || r.mismatched + r.missing_in_acquirer + r.missing_in_platform) ? (
            <Table>
              <thead>
                <tr>
                  <Th>Acquirer</Th>
                  <Th>Date</Th>
                  <Th align="right">New lines</Th>
                  <Th align="right">Matched</Th>
                  <Th align="right">Exceptions</Th>
                  <Th align="right">Net settled</Th>
                  <Th>Run</Th>
                </tr>
              </thead>
              <tbody>
                {runs!.data
                  .filter((r) => r.lines_ingested || r.mismatched + r.missing_in_acquirer + r.missing_in_platform)
                  .slice(0, 12)
                  .map((r) => {
                  const ex = r.mismatched + r.missing_in_acquirer + r.missing_in_platform;
                  return (
                    <tr key={r.id}>
                      <Td className="capitalize">{r.acquirer}</Td>
                      <Td className="text-ink-2">{r.business_date.slice(0, 10)}</Td>
                      <Td align="right">{r.lines_ingested}</Td>
                      <Td align="right">{r.matched}</Td>
                      <Td align="right">
                        {ex ? (
                          <span className="inline-flex items-center gap-1">
                            <CircleX className="size-3.5 text-critical" aria-hidden />
                            {ex}
                          </span>
                        ) : (
                          0
                        )}
                      </Td>
                      <Td align="right">{inr(r.net_settlement)}</Td>
                      <Td className="whitespace-nowrap text-muted">{new Date(r.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</Td>
                    </tr>
                  );
                  })}
              </tbody>
            </Table>
          ) : (
            <Empty title="No runs yet">Click “Run reconciliation & payouts now”.</Empty>
          )}
        </Card>

        <Card title="Exceptions" subtitle="Breaks that hold payouts until resolved" padded={false} className="xl:col-span-2">
          {exceptions?.data.length ? (
            <ul className="divide-y divide-line">
              {exceptions.data.slice(0, 8).map((e) => (
                <li key={e.id} className="px-5 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status="mismatch" label={humanize(e.type)} />
                    <span className="text-xs text-muted capitalize">
                      {e.acquirer} · {dateTime(e.created_at)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-ink-2">{e.details}</p>
                  {e.merchant_ref && (
                    <p className="mt-1 text-xs text-muted">
                      ref <Mono>{e.merchant_ref}</Mono>
                      {e.platform_amount !== null && <> · ours {inr(e.platform_amount)}</>}
                      {e.acquirer_amount !== null && <> · acquirer {inr(e.acquirer_amount)}</>}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No exceptions">Every settled transaction matched. Try “Corrupt next settlement files”.</Empty>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------------ ledger */}
      <h2 className="mb-3 text-lg font-semibold">Ledger integrity</h2>
      {!integrity ? (
        <Loading />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Invariants">
            <div className="flex items-center gap-2 text-base font-semibold">
              {integrity.balanced ? <CircleCheck className="size-5 text-good" aria-hidden /> : <CircleX className="size-5 text-critical" aria-hidden />}
              {integrity.balanced ? 'Books balance' : 'Books DO NOT balance'}
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-2">Total debits</dt>
                <dd className="tabular">{inr(integrity.total_debits)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Total credits</dt>
                <dd className="tabular">{inr(integrity.total_credits)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Assets + expenses</dt>
                <dd className="tabular">{inr(integrity.accounting_equation.assets_plus_expenses)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Liabilities + revenue</dt>
                <dd className="tabular">{inr(integrity.accounting_equation.liabilities_plus_revenue)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Journals / lines</dt>
                <dd className="tabular">
                  {integrity.journal_count} / {integrity.line_count}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-muted">
              Enforced in Postgres: a deferred constraint trigger rejects any unbalanced journal at commit, and UPDATE/DELETE on ledger rows is blocked. Checked {dateTime(integrity.checked_at)}.
            </p>
          </Card>
          <Card title="Trial balance" padded={false} className="lg:col-span-2">
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Type</Th>
                  <Th align="right">Debits</Th>
                  <Th align="right">Credits</Th>
                  <Th align="right">Balance</Th>
                </tr>
              </thead>
              <tbody>
                {integrity.trial_balance.map((t) => (
                  <tr key={t.account}>
                    <Td>
                      <div>{t.name}</div>
                      <Mono>{t.account}</Mono>
                    </Td>
                    <Td className="capitalize text-ink-2">{t.type}</Td>
                    <Td align="right">{inr(t.debits)}</Td>
                    <Td align="right">{inr(t.credits)}</Td>
                    <Td align="right" className="font-medium">
                      {inr(t.balance)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
