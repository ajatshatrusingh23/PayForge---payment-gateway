import { NextRequest, NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/lib/server';

const SESSION_MAX_AGE = 12 * 60 * 60; // matches the JWT lifetime

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;

  if (action === 'logout') {
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }
  if (action !== 'login' && action !== 'signup') {
    return NextResponse.json({ error: { message: 'Unknown action' } }, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/merchants/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '' },
      body: await req.text(),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { message: 'PayForge API is unreachable. Is the backend running?' } }, { status: 502 });
  }
  const body = await upstream.json();
  if (!upstream.ok) return NextResponse.json(body, { status: upstream.status });

  // The token goes into an httpOnly cookie and is NOT returned to the browser.
  const { token, ...rest } = body as { token: string } & Record<string, unknown>;
  const res = NextResponse.json(rest, { status: upstream.status });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== 'true',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
