'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BarList, Meter, VolumeChart } from '@/components/charts';
import { Card, Empty, Loading, PageHeader, Segmented, Stat, StatusBadge, Table, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { ago, humanize, inr, inrCompact, paymentMethodLabel, pct } from '@/lib/format';
import type { AnalyticsSummary, List, PaymentIntent } from '@/lib/types';

type Range = '7' | '30' | '90';

export default function OverviewPage() {
  const [range, setRange] = useState<Range>('7');
  const { data, isLoading, isValidating } = useApi<AnalyticsSummary>(`/v1/analytics/summary?days=${range}`, { refreshInterval: 10_000 });
  const { data: recent } = useApi<List<PaymentIntent>>('/v1/payment_intents?limit=6', { refreshInterval: 10_000 });
  const t = data?.totals;

  return (
    <>
      <PageHeader title="Overview" description="Live view of payments flowing through PayForge for your account." />

      {/* Filters: one row above everything they scope. */}
      <div className="mb-6 flex items-center gap-3">
        <Segmented<Range>
          label="Date range"
          value={range}
          onChange={setRange}
          options={[
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
        {isValidating && !isLoading && <span className="text-xs text-muted">Refreshing…</span>}
      </div>

      {isLoading || !t ? (
        <Loading />
      ) : (
        <div className={isValidating ? 'opacity-90 transition-opacity' : ''}>
          {/* Hero figure: exactly one per view. */}
          <section className="mb-6 rounded-xl border border-line bg-surface px-6 py-5">
            <div className="text-sm font-medium text-ink-2">Gross volume · last {range} days</div>
            <div className="mt-1 text-5xl font-semibold tracking-tight">{inr(t.gross_volume)}</div>
            <div className="mt-2 text-sm text-ink-2">
              {t.succeeded.toLocaleString('en-IN')} successful payments · {inr(t.refunded_volume)} refunded · {inr(t.fees)} in fees
            </div>
          </section>

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Success rate" value={pct(t.success_rate)} sub={`${t.succeeded} succeeded / ${t.failed} failed`} />
            <Stat label="Net volume" value={inrCompact(t.net_volume)} sub="After refunds and fees" />
            <Stat label="Average ticket" value={inr(t.average_ticket)} sub="Captured payments" />
            <Stat label="Payment attempts" value={t.attempted.toLocaleString('en-IN')} sub="Confirmed by customers" />
          </div>

          <div className="mb-6 grid gap-6 lg:grid-cols-3">
            <Card title="Daily gross volume" subtitle="Captured amount per day (IST)" className="lg:col-span-2">
              <VolumeChart data={data.daily} />
            </Card>
            <Card title="Payment methods" subtitle="Gross volume and success rate">
              {data.by_method.length ? (
                <BarList
                  rows={data.by_method.map((m) => ({
                    label: m.method === 'upi' ? 'UPI' : 'Cards',
                    value: m.volume,
                    display: inrCompact(m.volume),
                    sub: `${pct(m.success_rate, 0)} success`,
                  }))}
                />
              ) : (
                <Empty title="No payments yet" />
              )}
              {!!data.top_decline_codes.length && (
                <div className="mt-6">
                  <h3 className="mb-2 text-xs font-medium text-muted">Top decline reasons</h3>
                  <ul className="space-y-1.5 text-sm">
                    {data.top_decline_codes.map((d) => (
                      <li key={d.code} className="flex justify-between">
                        <span className="text-ink-2">{humanize(d.code)}</span>
                        <span className="tabular">{d.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Acquirer performance" subtitle="How smart routing is spreading your traffic" padded={false}>
              <Table>
                <thead>
                  <tr>
                    <Th>Acquirer</Th>
                    <Th align="right">Attempts</Th>
                    <Th>Approval rate</Th>
                    <Th align="right">Tech. failures</Th>
                    <Th align="right">Avg latency</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_acquirer.map((a) => {
                    const decided = a.approved + a.declined;
                    return (
                      <tr key={a.acquirer}>
                        <Td className="font-medium capitalize">{a.acquirer}</Td>
                        <Td align="right">{a.attempts}</Td>
                        <Td>{decided ? <Meter value={a.approved / decided} label={`${a.acquirer} approval rate`} /> : '—'}</Td>
                        <Td align="right">{a.technical_failures + a.timeouts}</Td>
                        <Td align="right">{a.avg_latency_ms} ms</Td>
                      </tr>
                    );
                  })}
                  {!data.by_acquirer.length && (
                    <tr>
                      <Td className="text-muted">No attempts yet</Td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card>

            <Card title="Recent payments" actions={<Link href="/payments" className="text-xs font-medium text-accent hover:underline">View all</Link>} padded={false}>
              <Table>
                <tbody>
                  {recent?.data.map((p) => (
                    <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => (window.location.href = `/payments/${p.id}`)}>
                      <Td className="font-medium tabular">{inr(p.amount)}</Td>
                      <Td>
                        <StatusBadge status={p.status} />
                      </Td>
                      <Td className="text-ink-2">{paymentMethodLabel(p.payment_method_details)}</Td>
                      <Td align="right" className="text-muted">
                        {ago(p.created_at)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {recent && !recent.data.length && <Empty title="No payments yet">Run the demo store or `npm run seed -- --with-data`.</Empty>}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
