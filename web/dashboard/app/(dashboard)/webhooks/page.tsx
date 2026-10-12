'use client';

import { Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CopyText, Empty, ErrorNote, Field, inputClass, Loading, Mono, PageHeader, Segmented, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiFetch, useApi } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import type { List, WebhookDelivery, WebhookEndpoint } from '@/lib/types';

type Filter = 'all' | 'succeeded' | 'retrying' | 'dead';

export default function WebhooksPage() {
  const { data: endpoints, mutate: mutateEndpoints } = useApi<List<WebhookEndpoint>>('/v1/webhook_endpoints');
  const [filter, setFilter] = useState<Filter>('all');
  const { data: deliveries, mutate: mutateDeliveries } = useApi<List<WebhookDelivery> & { summary: Record<string, number> }>(
    `/v1/webhook_deliveries?limit=50${filter === 'all' ? '' : `&status=${filter}`}`,
    { refreshInterval: 3_000 },
  );
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<WebhookEndpoint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
      await Promise.all([mutateEndpoints(), mutateDeliveries()]);
    }
  }

  const summary = deliveries?.summary ?? {};

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Events are signed (HMAC-SHA256 with a timestamp), retried with exponential backoff and jitter, dead-lettered after 8 attempts, and replayable."
        actions={
          <Button variant="primary" onClick={() => setShowForm(!showForm)}>
            <Plus className="size-4" aria-hidden /> Add endpoint
          </Button>
        }
      />

      {showForm && (
        <Card title="New endpoint" className="mb-6">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act('create', async () => {
                const ep = await apiFetch<WebhookEndpoint>('/v1/webhook_endpoints', { method: 'POST', body: { url, enabled_events: ['*'] } });
                setCreated(ep);
                setUrl('');
                setShowForm(false);
              });
            }}
          >
            <div className="min-w-80 flex-1">
              <Field label="Endpoint URL" hint="Receives all events. Private/loopback URLs are blocked in production (SSRF protection).">
                <input className={inputClass} type="url" required placeholder="https://example.com/webhooks/payforge" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
            </div>
            <Button variant="primary" type="submit" loading={busy === 'create'} className="mb-5">
              Create
            </Button>
          </form>
        </Card>
      )}

      {created && (
        <div className="mb-6 rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="font-medium">Endpoint created. Verify signatures with this signing secret:</p>
          <CopyText value={created.secret} className="mt-2 text-sm" />
        </div>
      )}
      <ErrorNote error={error} />

      <Card title="Endpoints" padded={false} className="mb-6">
        {!endpoints ? (
          <Loading />
        ) : endpoints.data.length ? (
          <Table>
            <thead>
              <tr>
                <Th>URL</Th>
                <Th>Events</Th>
                <Th>Signing secret</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {endpoints.data.map((ep) => (
                <tr key={ep.id}>
                  <Td>
                    <div className="font-medium">{ep.url}</div>
                    {ep.description && <div className="text-xs text-muted">{ep.description}</div>}
                  </Td>
                  <Td>
                    <Mono>{ep.enabled_events.join(', ')}</Mono>
                  </Td>
                  <Td>
                    <Mono>{ep.secret}</Mono>
                  </Td>
                  <Td className="text-muted">{ago(ep.created_at)}</Td>
                  <Td align="right" className="whitespace-nowrap">
                    <Button size="sm" loading={busy === `test-${ep.id}`} onClick={() => act(`test-${ep.id}`, () => apiFetch(`/v1/webhook_endpoints/${ep.id}/test`, { method: 'POST' }))}>
                      <Send className="size-3.5" aria-hidden /> Send test
                    </Button>{' '}
                    <Button size="sm" variant="ghost" aria-label="Delete endpoint" onClick={() => act(`del-${ep.id}`, () => apiFetch(`/v1/webhook_endpoints/${ep.id}`, { method: 'DELETE' }))}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No endpoints">Add one to start receiving events like payment_intent.captured.</Empty>
        )}
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          label="Delivery status"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'succeeded', label: `Succeeded${summary.succeeded ? ` (${summary.succeeded})` : ''}` },
            { value: 'retrying', label: `Retrying${summary.retrying ? ` (${summary.retrying})` : ''}` },
            { value: 'dead', label: `Dead-lettered${summary.dead ? ` (${summary.dead})` : ''}` },
          ]}
        />
      </div>
      <Card title="Deliveries" subtitle="Live (refreshes every 3s)" padded={false}>
        {!deliveries ? (
          <Loading />
        ) : deliveries.data.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th align="right">Attempts</Th>
                <Th>Last result</Th>
                <Th>Next retry</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {deliveries.data.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Mono className="text-ink">{d.event_type}</Mono>
                    <div className="text-xs text-muted">{d.object_id ?? d.event_id}</div>
                  </Td>
                  <Td>
                    <StatusBadge status={d.status} label={d.status === 'dead' ? 'dead-lettered' : undefined} />
                  </Td>
                  <Td align="right">{d.attempts}</Td>
                  <Td className="max-w-64 truncate text-ink-2" title={d.last_error ?? undefined}>
                    {d.last_response_code ? `HTTP ${d.last_response_code}` : (d.last_error ?? '—')}
                    {d.last_latency_ms !== null && <span className="text-muted"> · {d.last_latency_ms} ms</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{d.status === 'retrying' ? dateTime(d.next_attempt_at) : '—'}</Td>
                  <Td className="whitespace-nowrap text-muted">{ago(d.created_at)}</Td>
                  <Td align="right">
                    <Button size="sm" variant="ghost" loading={busy === d.id} onClick={() => act(d.id, () => apiFetch(`/v1/webhook_deliveries/${d.id}/retry`, { method: 'POST' }))}>
                      <RotateCcw className="size-3.5" aria-hidden /> Replay
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No deliveries" />
        )}
      </Card>
    </>
  );
}
