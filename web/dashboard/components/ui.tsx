'use client';

import { Check, CircleAlert, CircleCheck, CircleX, Clock, Copy, Loader2, MinusCircle, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { humanize } from '@/lib/format';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ layout

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, padded = true }: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

/** Stat tile: label, value (auto-compacted by the caller), optional sub-line. */
export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ controls

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; loading?: boolean }) {
  const styles = {
    primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
    secondary: 'bg-surface text-ink border-line hover:bg-surface-2',
    danger: 'bg-surface text-critical border-line hover:bg-surface-2',
    ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-2',
  }[variant];
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles,
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1 text-sm font-medium', o.value === value ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20';

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-critical">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

// ------------------------------------------------------------------ data display

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cx('font-mono text-[12px] text-ink-2', className)}>{children}</code>;
}

export function CopyText({ value, display, className }: { value: string; display?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cx('group inline-flex max-w-full items-center gap-1 font-mono text-[12px] text-ink-2 hover:text-ink', className)}
      title="Copy"
    >
      <span className="truncate">{display ?? value}</span>
      {copied ? <Check className="size-3 shrink-0 text-good" aria-label="Copied" /> : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" aria-hidden />}
    </button>
  );
}

type Tone = 'good' | 'warning' | 'critical' | 'neutral' | 'info';

const STATUS_TONES: Record<string, Tone> = {
  captured: 'good',
  succeeded: 'good',
  approved: 'good',
  matched: 'good',
  paid: 'good',
  allow: 'good',
  closed: 'good',
  authorized: 'info',
  partially_refunded: 'info',
  refunded: 'neutral',
  created: 'neutral',
  canceled: 'neutral',
  voided: 'neutral',
  expired: 'neutral',
  processing: 'warning',
  pending: 'warning',
  requires_action: 'warning',
  requires_otp: 'warning',
  retrying: 'warning',
  unreconciled: 'warning',
  challenge: 'warning',
  half_open: 'warning',
  initiated: 'warning',
  unknown: 'warning',
  failed: 'critical',
  declined: 'critical',
  dead: 'critical',
  mismatch: 'critical',
  missing_in_acquirer: 'critical',
  technical_failure: 'critical',
  not_found: 'critical',
  block: 'critical',
  open: 'critical',
};

const TONE_STYLE: Record<Tone, { icon: LucideIcon; color: string }> = {
  good: { icon: CircleCheck, color: 'text-good' },
  info: { icon: CircleCheck, color: 'text-series-1' },
  warning: { icon: Clock, color: 'text-warning' },
  critical: { icon: CircleX, color: 'text-critical' },
  neutral: { icon: MinusCircle, color: 'text-muted' },
};

/** Status is never color alone: icon + label, in ink, on a quiet chip. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  const { icon: Icon, color } = TONE_STYLE[tone];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2">
      <Icon className={cx('size-3.5', color)} aria-hidden />
      {label ?? humanize(status)}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
    </div>
  );
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={cx('border-b border-line px-4 py-2.5 text-xs font-medium whitespace-nowrap text-muted first:pl-5 last:pr-5', align === 'right' ? 'text-right' : 'text-left')}>
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', className, title }: { children?: React.ReactNode; align?: 'left' | 'right'; className?: string; title?: string }) {
  return (
    <td title={title} className={cx('border-b border-line px-4 py-3 align-middle first:pl-5 last:pr-5', align === 'right' && 'text-right tabular', className)}>
      {children}
    </td>
  );
}

export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-6 gap-y-2.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-2">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
