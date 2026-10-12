import { AcquirerLine, PlatformItem, reconcile } from './recon';

const day = { start: new Date('2026-10-10T00:00:00Z'), end: new Date('2026-10-11T00:00:00Z') };
const now = new Date('2026-10-11T02:00:00Z');
const w = { ...day, now, graceMs: 60_000 };

const item = (ref: string, amount: number, at = '2026-10-10T10:00:00Z', status: PlatformItem['recon_status'] = 'unreconciled'): PlatformItem => ({
  id: `si_${ref}`,
  merchant_ref: ref,
  amount,
  recon_status: status,
  occurred_at: new Date(at),
});
const line = (ref: string, amount: number, ingested = '2026-10-11T01:00:00Z', exceptionRaised = false): AcquirerLine => ({
  acquirer_ref: `A_${ref}`,
  merchant_ref: ref,
  amount,
  ingested_at: new Date(ingested),
  exception_raised: exceptionRaised,
});

describe('reconciliation', () => {
  it('matches on merchant_ref and amount', () => {
    const r = reconcile([item('pa_1', 100)], [line('pa_1', 100)], w);
    expect(r.matched).toHaveLength(1);
    expect(r.mismatched).toHaveLength(0);
  });

  it('flags an amount mismatch', () => {
    const r = reconcile([item('pa_1', 100)], [line('pa_1', 99)], w);
    expect(r.mismatched).toHaveLength(1);
  });

  it('flags a payment we captured that the acquirer never reported', () => {
    expect(reconcile([item('pa_1', 100)], [], w).missingInAcquirer).toHaveLength(1);
  });

  it('flags money the acquirer settled that we have no record of', () => {
    expect(reconcile([], [line('pa_9', 100)], w).missingInPlatform).toHaveLength(1);
  });

  it('gives very recent records a grace period (timing differences are not breaks)', () => {
    const fresh = { ...w, now: new Date('2026-10-10T10:00:30Z') };
    const r = reconcile([item('pa_1', 100, '2026-10-10T10:00:00Z')], [line('pa_2', 100, '2026-10-10T10:00:10Z')], fresh);
    expect(r.missingInAcquirer).toHaveLength(0);
    expect(r.missingInPlatform).toHaveLength(0);
  });

  it('only declares items missing for the business day being reconciled', () => {
    expect(reconcile([item('pa_1', 100, '2026-10-08T10:00:00Z')], [], w).missingInAcquirer).toHaveLength(0);
  });

  it('can match an item previously marked missing (the line arrived in a later file)', () => {
    const r = reconcile([item('pa_1', 100, '2026-10-10T10:00:00Z', 'missing_in_acquirer')], [line('pa_1', 100)], w);
    expect(r.matched).toHaveLength(1);
  });

  it('does not raise the same exception twice', () => {
    expect(reconcile([], [line('pa_9', 100, '2026-10-11T01:00:00Z', true)], w).missingInPlatform).toHaveLength(0);
  });
});
