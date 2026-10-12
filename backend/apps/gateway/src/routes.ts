import { config } from '@app/common';

export type Upstream = keyof typeof config.services;

export interface Route {
  prefix: string;
  upstream: Upstream;
  /** No authentication (signup/login). */
  public?: boolean;
  /** Only a logged-in dashboard session may call it (chaos controls). */
  dashboardOnly?: boolean;
  /** Replace the prefix before forwarding, e.g. /v1/simulator -> /admin. */
  rewrite?: string;
}

/** Public route table: which service owns which part of the API. */
export const ROUTES: Route[] = [
  { prefix: '/v1/merchants/signup', upstream: 'merchant', public: true },
  { prefix: '/v1/merchants/login', upstream: 'merchant', public: true },
  { prefix: '/v1/merchants', upstream: 'merchant' },
  { prefix: '/v1/api_keys', upstream: 'merchant' },
  { prefix: '/v1/payment_intents', upstream: 'payment' },
  { prefix: '/v1/refunds', upstream: 'payment' },
  { prefix: '/v1/analytics', upstream: 'payment' },
  { prefix: '/v1/routing', upstream: 'payment' },
  { prefix: '/v1/payment_methods', upstream: 'vault' },
  { prefix: '/v1/vault', upstream: 'vault' },
  { prefix: '/v1/risk', upstream: 'risk' },
  { prefix: '/v1/balance', upstream: 'ledger' },
  { prefix: '/v1/ledger', upstream: 'ledger' },
  { prefix: '/v1/webhook_endpoints', upstream: 'webhook' },
  { prefix: '/v1/webhook_deliveries', upstream: 'webhook' },
  { prefix: '/v1/payouts', upstream: 'settlement' },
  { prefix: '/v1/settlements', upstream: 'settlement' },
  { prefix: '/v1/reconciliation', upstream: 'settlement' },
  { prefix: '/v1/simulator', upstream: 'bank', rewrite: '/admin', dashboardOnly: true },
].sort((a, b) => b.prefix.length - a.prefix.length) as Route[];

export function matchRoute(path: string): Route | undefined {
  return ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}
