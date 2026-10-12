import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { config, Errors } from '@app/common';

/**
 * SSRF protection. A webhook URL is attacker-controlled input: without this check a
 * merchant could register http://169.254.169.254/ (cloud metadata) or http://localhost:5432
 * and make our servers call internal infrastructure. Checked at registration AND at send
 * time (DNS can change between the two: "DNS rebinding").
 */
export const ALLOW_PRIVATE_URLS = (process.env.WEBHOOK_ALLOW_PRIVATE_URLS ?? String(!config.isProduction)) === 'true';

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

export async function assertSafeWebhookUrl(raw: string, allowPrivate = ALLOW_PRIVATE_URLS): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Errors.invalid('url must be a valid absolute URL', 'url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Errors.invalid('url must use http or https', 'url');
  if (config.isProduction && url.protocol !== 'https:') throw Errors.invalid('url must use https', 'url');
  if (url.username || url.password) throw Errors.invalid('url must not contain credentials', 'url');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addresses.length) throw Errors.invalid('url hostname could not be resolved', 'url');
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      throw Errors.invalid('url must not resolve to a private, loopback or link-local address', 'url');
    }
  }
  return url;
}
