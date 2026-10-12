/** ₹1,23,456.78 from paise. */
export function inr(paise: number | null | undefined, opts: { decimals?: boolean } = {}): string {
  const value = (paise ?? 0) / 100;
  return value.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: opts.decimals === false ? 0 : 2,
    maximumFractionDigits: opts.decimals === false ? 0 : 2,
  });
}

/** Indian compact notation for axes and tiles: ₹950, ₹12.4K, ₹3.2L, ₹1.1Cr. */
export function inrCompact(paise: number): string {
  const r = paise / 100;
  const abs = Math.abs(r);
  if (abs >= 1e7) return `₹${trim(r / 1e7)}Cr`;
  if (abs >= 1e5) return `₹${trim(r / 1e5)}L`;
  if (abs >= 1e3) return `₹${trim(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}

const trim = (n: number) => (Math.round(n * 10) / 10).toString();

export function pct(ratio: number | null | undefined, digits = 1): string {
  return ratio === null || ratio === undefined ? '—' : `${(ratio * 100).toFixed(digits)}%`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const humanize = (s: string) => s.replace(/_/g, ' ');

export function paymentMethodLabel(details: { type: string; card?: { brand: string; last4: string }; upi?: { vpa: string } } | null): string {
  if (!details) return '—';
  if (details.type === 'upi') return `UPI · ${details.upi?.vpa ?? ''}`;
  return `${(details.card?.brand ?? 'card').toUpperCase()} •••• ${details.card?.last4 ?? ''}`;
}
