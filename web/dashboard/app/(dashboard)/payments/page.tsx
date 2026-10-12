'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { Button, Card, Empty, inputClass, Loading, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { dateTime, inr, paymentMethodLabel } from '@/lib/format';
import type { List, PaymentIntent } from '@/lib/types';

const STATUSES = ['', 'captured', 'failed', 'pending', 'requires_action', 'authorized', 'partially_refunded', 'refunded', 'canceled', 'expired', 'created'];
const PAGE = 25;

export default function PaymentsPage() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');

  const { data, size, setSize, isLoading, isValidating } = useSWRInfinite<List<PaymentIntent>>(
    (index, previous) => {
      if (previous && !previous.has_more) return null;
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (status) params.set('status', status);
      if (submitted) params.set('q', submitted);
      if (index > 0 && previous) params.set('starting_after', previous.data[previous.data.length - 1].id);
      return `/v1/payment_intents?${params}`;
    },
    (path: string) => apiFetch<List<PaymentIntent>>(path),
    { refreshInterval: 15_000 },
  );
  const rows = data?.flatMap((p) => p.data) ?? [];
  const hasMore = data?.[data.length - 1]?.has_more;

  return (
    <>
      <PageHeader title="Payments" description="Every PaymentIntent, newest first. Click a payment for its full timeline, risk, ledger and webhook trail." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select aria-label="Filter by status" className={`${inputClass} w-48`} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? s.replace(/_/g, ' ') : 'All statuses'}
            </option>
          ))}
        </select>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
          <input className={`${inputClass} w-72 pl-9`} placeholder="Search id, email or description" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search payments" />
        </form>
      </div>

      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : rows.length ? (
          <Table>
            <thead>
              <tr>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
                <Th>Payment method</Th>
                <Th>Description</Th>
                <Th>Customer</Th>
                <Th>Acquirer</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => router.push(`/payments/${p.id}`)}>
                  <Td align="right" className="font-medium">
                    {inr(p.amount)}
                  </Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-ink-2">{paymentMethodLabel(p.payment_method_details)}</Td>
                  <Td className="max-w-56 truncate text-ink-2">{p.description ?? '—'}</Td>
                  <Td className="text-ink-2">{p.customer_email ?? '—'}</Td>
                  <Td className="capitalize text-ink-2">{p.acquirer ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-muted">{dateTime(p.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No payments match">Try a different filter, or create payments from the demo store.</Empty>
        )}
        {hasMore && (
          <div className="border-t border-line p-3 text-center">
            <Button size="sm" onClick={() => setSize(size + 1)} loading={isValidating}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
