'use client';

import { KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CopyText, ErrorNote, Field, inputClass, KeyValue, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import { apiFetch, useApi } from '@/lib/api';
import { ago } from '@/lib/format';
import type { List, Merchant } from '@/lib/types';

interface ApiKey {
  id: string;
  type: 'secret' | 'publishable';
  key: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_used_at: string | null;
}

const TEST_CARDS: Array<[string, string]> = [
  ['4111 1111 1111 1111', 'Visa: succeeds'],
  ['5555 5555 5555 4444', 'Mastercard: succeeds'],
  ['6522 0000 0000 0006', 'RuPay: succeeds'],
  ['4000 0000 0000 3220', 'OTP required (123456)'],
  ['4000 0000 0000 0002', 'Declined (do_not_honor)'],
  ['4000 0000 0000 9995', 'Insufficient funds'],
  ['4000 0000 0000 0119', 'Acquirer timeout, resolved by status check'],
  ['4000 0007 6000 0002', 'International card (raises risk score)'],
  ['success@pfbank', 'UPI: approved after ~3s'],
  ['fail@pfbank', 'UPI: customer declines'],
];

export default function DevelopersPage() {
  const { data: keys, mutate } = useApi<List<ApiKey>>('/v1/api_keys');
  const { data: me, mutate: mutateMe } = useApi<Merchant>('/v1/merchants/me');
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [kyc, setKyc] = useState({ pan: '', account_holder_name: '', bank_account_number: '', ifsc: '' });

  async function roll() {
    if (!confirm('Roll your secret key? The current key stops working immediately.')) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ secret_key: string }>('/v1/api_keys/roll', { method: 'POST' });
      setNewSecret(res.secret_key);
      await mutate();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitKyc(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/v1/merchants/me/kyc', { method: 'POST', body: { ...kyc, pan: kyc.pan.toUpperCase(), ifsc: kyc.ifsc.toUpperCase() } });
      await mutateMe();
    } catch (err) {
      setError(err);
    }
  }

  const pk = keys?.data.find((k) => k.type === 'publishable' && k.status === 'active')?.key ?? 'pk_test_...';

  return (
    <>
      <PageHeader title="Developers" description="API keys, account verification and everything you need to integrate PayForge." />
      <ErrorNote error={error} />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="API keys"
          subtitle="Secret keys are stored only as SHA-256 hashes; rolling revokes the old key instantly (gateway cache is evicted)."
          actions={
            <Button size="sm" onClick={roll} loading={busy}>
              <RefreshCw className="size-3.5" aria-hidden /> Roll secret key
            </Button>
          }
          padded={false}
        >
          {newSecret && (
            <div className="border-b border-line bg-surface-2 px-5 py-3 text-sm">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <KeyRound className="size-4" aria-hidden /> New secret key (shown once)
              </div>
              <CopyText value={newSecret} className="text-sm" />
            </div>
          )}
          <Table>
            <tbody>
              {keys?.data.map((k) => (
                <tr key={k.id}>
                  <Td className="capitalize">{k.type}</Td>
                  <Td className="max-w-72">{k.type === 'publishable' ? <CopyText value={k.key} /> : <code className="font-mono text-xs text-ink-2">{k.key}</code>}</Td>
                  <Td>
                    <StatusBadge status={k.status === 'active' ? 'approved' : 'canceled'} label={k.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{k.last_used_at ? `used ${ago(k.last_used_at)}` : 'never used'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Account verification (KYC)" subtitle="Payouts are held until KYC is approved (mock verification in test mode).">
          {me?.kyc_status === 'approved' ? (
            <KeyValue
              items={[
                ['Status', <StatusBadge key="s" status="approved" label="Approved" />],
                ['PAN', me.pan],
                ['Settlement account', me.settlement_account ? `${me.settlement_account.account_holder_name} · ••${me.settlement_account.account_number_last4} · ${me.settlement_account.ifsc}` : '—'],
                ['Pricing', `${(me.pricing.fee_bps / 100).toFixed(2)}% + 18% GST on the fee`],
              ]}
            />
          ) : (
            <form onSubmit={submitKyc} className="grid gap-3 sm:grid-cols-2">
              <Field label="PAN">
                <input className={inputClass} required placeholder="ABCDE1234F" value={kyc.pan} onChange={(e) => { const v = e.target.value; setKyc((s) => ({ ...s, pan: v })); }} />
              </Field>
              <Field label="Account holder">
                <input className={inputClass} required value={kyc.account_holder_name} onChange={(e) => { const v = e.target.value; setKyc((s) => ({ ...s, account_holder_name: v })); }} />
              </Field>
              <Field label="Bank account number">
                <input className={inputClass} required inputMode="numeric" value={kyc.bank_account_number} onChange={(e) => { const v = e.target.value; setKyc((s) => ({ ...s, bank_account_number: v })); }} />
              </Field>
              <Field label="IFSC">
                <input className={inputClass} required placeholder="HDFC0001234" value={kyc.ifsc} onChange={(e) => { const v = e.target.value; setKyc((s) => ({ ...s, ifsc: v })); }} />
              </Field>
              <Button variant="primary" type="submit" className="sm:col-span-2">
                Submit for verification
              </Button>
            </form>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Quickstart">
          <ol className="space-y-4 text-sm">
            <li>
              <p className="mb-1.5 font-medium">1. Create a PaymentIntent on your server (secret key)</p>
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed">{`curl http://localhost:8080/v1/payment_intents \\
  -u sk_test_YOUR_SECRET_KEY: \\
  -H "Idempotency-Key: order_1234" \\
  -d '{"amount": 49900, "currency": "INR",
       "description": "Order #1234"}' \\
  -H "content-type: application/json"`}</pre>
            </li>
            <li>
              <p className="mb-1.5 font-medium">2. Open the hosted checkout in the browser (publishable key)</p>
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed">{`<script src="/sdk/payforge.js"></script>
<script>
  const payforge = PayForge('${pk}');
  payforge.open({
    clientSecret,   // from step 1
    onSuccess: (r) => showThankYou(r.paymentIntentId),
  });
</script>`}</pre>
            </li>
            <li>
              <p className="mb-1.5 font-medium">3. Fulfil the order from the signed webhook</p>
              <p className="text-ink-2">
                Verify <code className="font-mono text-xs">PayForge-Signature: t=…,v1=…</code> as HMAC-SHA256 of <code className="font-mono text-xs">{'`${t}.${rawBody}`'}</code> with your endpoint secret,
                reject timestamps older than 5 minutes, and de-duplicate on the event id.
              </p>
            </li>
          </ol>
        </Card>

        <Card title="Test cards & UPI IDs" subtitle="Any future expiry and any 3-digit CVC" padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Number / UPI ID</Th>
                <Th>Behaviour</Th>
              </tr>
            </thead>
            <tbody>
              {TEST_CARDS.map(([n, d]) => (
                <tr key={n}>
                  <Td>
                    <CopyText value={n.replace(/ /g, '')} display={n} />
                  </Td>
                  <Td className="text-ink-2">{d}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
