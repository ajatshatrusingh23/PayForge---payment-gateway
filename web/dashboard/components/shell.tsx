'use client';

import { Activity, Code2, CreditCard, LayoutDashboard, LogOut, ShieldAlert, Wallet, Webhook } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useApi } from '@/lib/api';
import type { Merchant } from '@/lib/types';
import { cx, StatusBadge } from './ui';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/payments', label: 'Payments', icon: CreditCard },
  { href: '/balance', label: 'Balance & ledger', icon: Wallet },
  { href: '/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/risk', label: 'Risk', icon: ShieldAlert },
  { href: '/developers', label: 'Developers', icon: Code2 },
  { href: '/ops', label: 'Ops & chaos', icon: Activity },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useApi<Merchant>('/v1/merchants/me');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-sm font-bold text-on-accent">P</span>
          <span className="font-semibold tracking-tight">PayForge</span>
          <span className="ml-auto rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-ink-2">TEST</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium',
                  active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line p-4">
          <div className="truncate text-sm font-medium">{me?.business_name ?? '…'}</div>
          <div className="truncate text-xs text-muted">{me?.email}</div>
          <div className="mt-2 flex items-center justify-between">
            {me && <StatusBadge status={me.kyc_status === 'approved' ? 'approved' : 'pending'} label={`KYC ${me.kyc_status}`} />}
            <button onClick={logout} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" title="Log out" aria-label="Log out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 md:hidden" aria-label="Main">
          {NAV.map(({ href, label }) => (
            <Link key={href} href={href} className={cx('whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm', pathname === href ? 'bg-accent-soft text-accent' : 'text-ink-2')}>
              {label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
