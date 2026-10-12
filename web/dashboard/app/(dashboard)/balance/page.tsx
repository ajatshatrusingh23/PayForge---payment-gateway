'use client';

import { Card, Empty, Loading, Mono, PageHeader, Stat, StatusBadge, Table, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { dateTime, humanize, inr } from '@/lib/format';
import type { Journal, List } from '@/lib/types';

interface Balance {
  available: number;
  account: string;
  lifetime: { net_earnings: number; refunded: number; paid_out: number };
}
interface SettlementSummary {
  pending_reconciliation: number;
  ready_for_payout: number;
  on_hold: number;
  paid_out: number;
}
interface Payout {
  id: string;
  amount: number;
  status: string;
  item_count: number;
  utr: string;
  destination: { account_holder_name: string; account_number_last4: string; ifsc: string } | null;
  paid_at: string;
}

export default function BalancePage() {
  const { data: balance } = useApi<Balance>('/v1/balance', { refreshInterval: 5_000 });
  const { data: summary } = useApi<SettlementSummary>('/v1/settlements/summary', { refreshInterval: 5_000 });
  const { data: payouts } = useApi<List<Payout>>('/v1/payouts', { refreshInterval: 10_000 });
  const { data: journals } = useApi<List<Journal>>('/v1/ledger/journals?limit=20', { refreshInterval: 5_000 });

  return (
    <>
      <PageHeader
        title="Balance & ledger"
        description="Your balance is derived from an append-only double-entry ledger. Funds are paid out only after the acquirer's settlement file reconciles with our records (T+1)."
      />

      {!balance || !summary ? (
        <Loading />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Ledger balance (owed to you)" value={inr(balance.available)} sub={<Mono>{balance.account}</Mono>} />
            <Stat label="Ready for payout" value={inr(summary.ready_for_payout)} sub="Reconciled, paid in the next run" />
            <Stat label="Awaiting reconciliation" value={inr(summary.pending_reconciliation)} sub="Not yet in an acquirer file" />
            <Stat label="On hold" value={inr(summary.on_hold)} sub="Reconciliation exceptions" />
          </div>
          <p className="-mt-2 mb-6 text-xs text-muted">
            Lifetime: {inr(balance.lifetime.net_earnings)} earned (net of fees) · {inr(balance.lifetime.refunded)} refunded · {inr(balance.lifetime.paid_out)} paid out
          </p>
        </>
      )}

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Payouts" subtitle="Bank transfers to your settlement account" padded={false} className="xl:col-span-2">
          {payouts?.data.length ? (
            <Table>
              <thead>
                <tr>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                  <Th>UTR</Th>
                  <Th>Paid</Th>
                </tr>
              </thead>
              <tbody>
                {payouts.data.map((p) => (
                  <tr key={p.id}>
                    <Td align="right" className="font-medium">
                      {inr(p.amount)}
                      <div className="text-xs font-normal text-muted">{p.item_count} items</div>
                    </Td>
                    <Td>
                      <StatusBadge status={p.status} />
                    </Td>
                    <Td>
                      <Mono>{p.utr}</Mono>
                      {p.destination && <div className="text-xs text-muted">to ••{p.destination.account_number_last4} · {p.destination.ifsc}</div>}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{dateTime(p.paid_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty title="No payouts yet">Run settlement from the Ops page (demo) or wait for the nightly run.</Empty>
          )}
        </Card>

        <Card title="Journal entries" subtitle="Every money movement as balanced debit/credit lines" padded={false} className="xl:col-span-3">
          {journals?.data.length ? (
            <div className="max-h-[680px] overflow-y-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Event</Th>
                  <Th>Account</Th>
                  <Th align="right">Debit</Th>
                  <Th align="right">Credit</Th>
                </tr>
              </thead>
              <tbody>
                {journals.data.map((j) =>
                  j.lines.map((l, i) => (
                    <tr key={`${j.id}-${i}`} className={i === j.lines.length - 1 ? '[&>td]:border-b-line' : '[&>td]:border-b-transparent'}>
                      <Td className="align-top">
                        {i === 0 && (
                          <>
                            <div className="font-medium">{humanize(j.event_type.split('.').pop() ?? j.event_type)}</div>
                            <div className="text-xs text-muted">
                              <Mono>{j.reference_id}</Mono>
                            </div>
                          </>
                        )}
                      </Td>
                      <Td>
                        <Mono>{l.account}</Mono>
                      </Td>
                      <Td align="right">{l.direction === 'debit' ? inr(l.amount) : ''}</Td>
                      <Td align="right">{l.direction === 'credit' ? inr(l.amount) : ''}</Td>
                    </tr>
                  )),
                )}
              </tbody>
            </Table>
            </div>
          ) : (
            <Empty title="No journal entries yet" />
          )}
        </Card>
      </div>
    </>
  );
}
