'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorNote, Field, inputClass } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ name: '', business_name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [keys, setKeys] = useState<{ publishable_key: string; secret_key: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const body = mode === 'login' ? { email: form.email, password: form.password } : form;
    const res = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) return setError(json?.error?.message ?? 'Something went wrong');
    if (mode === 'signup') return setKeys(json.api_keys);
    router.replace('/');
  }

  // Functional update: autofill can change several fields in the same tick.
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target;
    setForm((f) => ({ ...f, [k]: value }));
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-xl bg-accent text-lg font-bold text-on-accent">P</span>
          <div>
            <div className="text-lg font-semibold tracking-tight">PayForge</div>
            <div className="text-xs text-muted">Merchant dashboard · test mode</div>
          </div>
        </div>

        {keys ? (
          <div className="space-y-4 rounded-xl border border-line bg-surface p-6">
            <h1 className="text-lg font-semibold">Your account is ready</h1>
            <p className="text-sm text-ink-2">Store your secret key now. For security, it is only shown once.</p>
            <Field label="Publishable key (browser)">
              <code className="block break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{keys.publishable_key}</code>
            </Field>
            <Field label="Secret key (server only)">
              <code className="block break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{keys.secret_key}</code>
            </Field>
            <Button variant="primary" className="w-full" onClick={() => router.replace('/')}>
              Continue to dashboard
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-6">
            <h1 className="text-lg font-semibold">{mode === 'login' ? 'Sign in' : 'Create a merchant account'}</h1>
            {mode === 'signup' && (
              <>
                <Field label="Your name">
                  <input className={inputClass} value={form.name} onChange={set('name')} required autoComplete="name" />
                </Field>
                <Field label="Business name">
                  <input className={inputClass} value={form.business_name} onChange={set('business_name')} required />
                </Field>
              </>
            )}
            <Field label="Email">
              <input className={inputClass} type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
            </Field>
            <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}>
              <input className={inputClass} type="password" value={form.password} onChange={set('password')} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </Field>
            <ErrorNote error={error} />
            <Button variant="primary" type="submit" loading={loading} className="w-full">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <p className="text-center text-sm text-ink-2">
              {mode === 'login' ? 'New to PayForge? ' : 'Already have an account? '}
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
                {mode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </p>
            {mode === 'login' && (
              <p className="rounded-lg bg-surface-2 p-3 text-xs text-ink-2">
                Demo (after <code className="font-mono">npm run seed</code>): <span className="font-mono">demo@chaicart.in</span> / <span className="font-mono">chaicart-demo-123</span>
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
