import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/lib/server';

/**
 * Backend-for-frontend proxy. The browser never holds the session token in JavaScript:
 * it lives in an httpOnly, SameSite=Lax cookie, and this route attaches it as a Bearer
 * token when forwarding to the PayForge gateway. (SameSite=Lax also blocks cross-site
 * POSTs from carrying the cookie, which is the CSRF protection.)
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Please log in.' } }, { status: 401 });
  }

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  const idempotencyKey = req.headers.get('idempotency-key');
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'gateway_unreachable', message: 'PayForge API is unreachable.' } }, { status: 502 });
  }

  const response = new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
  if (upstream.status === 401) response.cookies.delete(SESSION_COOKIE);
  return response;
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
