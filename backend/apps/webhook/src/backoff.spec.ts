import { nextRetryDelayMs } from './backoff';
import { isPrivateAddress } from './url-guard';

describe('webhook retry backoff', () => {
  it('doubles each attempt within the jitter band [d/2, d]', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const d = 5_000 * 2 ** (attempt - 1);
      expect(nextRetryDelayMs(attempt, () => 0, 5_000)).toBe(d / 2);
      expect(nextRetryDelayMs(attempt, () => 1, 5_000)).toBe(d);
    }
  });

  it('is capped', () => {
    expect(nextRetryDelayMs(50, () => 1, 5_000, 60_000)).toBe(60_000);
  });

  it('spreads retries out (jitter) instead of retrying in lock-step', () => {
    const delays = new Set(Array.from({ length: 50 }, () => nextRetryDelayMs(4)));
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'])(
    'treats %s as private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});
