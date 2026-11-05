'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type Mode = 'signin' | 'signup';

interface SignUpResponse {
  error?: string;
  code?: string;
  verificationRequired?: boolean;
  delivery?: 'sent' | 'failed' | 'unconfigured';
}

export function AuthForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ email: string; delivery: string } | null>(null);
  const [resendForEmail, setResendForEmail] = useState<string | null>(null);
  const [resend, setResend] = useState<{ busy: boolean; message: string | null; error: string | null }>({
    busy: false,
    message: null,
    error: null,
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (mode === 'signup' && password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(mode === 'signin' ? '/api/auth/sign-in' : '/api/auth/sign-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'signin'
            ? { email, password }
            : { name, email, password, confirmPassword },
        ),
      });
      const data = (await response.json().catch(() => ({}))) as SignUpResponse;
      if (!response.ok) {
        setError(data.error ?? `That request failed (HTTP ${response.status}).`);
        setResendForEmail(data.code === 'email_unverified' ? email : null);
        return;
      }
      if (mode === 'signup' && data.verificationRequired) {
        setPending({ email, delivery: data.delivery ?? 'sent' });
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async (address: string) => {
    if (resend.busy) return;
    setResend({ busy: true, message: null, error: null });
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      setResend({
        busy: false,
        message: response.ok ? (data.message ?? 'A new link is on its way.') : null,
        error: response.ok ? null : (data.error ?? 'Could not resend the email.'),
      });
    } catch {
      setResend({ busy: false, message: null, error: 'Could not reach the server.' });
    }
  };

  const switchMode = () => {
    setMode((current) => (current === 'signin' ? 'signup' : 'signin'));
    setError(null);
    setPending(null);
    setResendForEmail(null);
    setResend({ busy: false, message: null, error: null });
    setPassword('');
    setConfirmPassword('');
  };

  if (pending) {
    return (
      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-850/60 p-4">
        <p className="text-sm font-semibold text-white">Check your inbox</p>
        <p className="mt-2 text-xs leading-relaxed text-mist-400">
          We sent a verification link to <span className="text-mist-200">{pending.email}</span>. Open
          it to activate your account, then sign in.
        </p>
        {pending.delivery === 'failed' ? (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2 text-xs text-amber-100">
            The email could not be sent. Try resending it in a moment.
          </p>
        ) : null}

        {resend.message ? <p className="mt-3 text-xs text-emerald-200">{resend.message}</p> : null}
        {resend.error ? <p className="mt-3 text-xs text-rose-200">{resend.error}</p> : null}

        <button
          type="button"
          className="btn-secondary mt-4 w-full text-xs"
          disabled={resend.busy}
          onClick={() => void resendVerification(pending.email)}
        >
          {resend.busy ? 'Sending…' : 'Resend verification email'}
        </button>
        <button type="button" className="btn-ghost mt-2 w-full text-xs" onClick={switchMode}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={submit} className="mt-5 space-y-3.5">
        {mode === 'signup' ? (
          <label className="block">
            <span className="label">Name (optional)</span>
            <input
              className="input mt-2"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              maxLength={80}
            />
          </label>
        ) : null}

        <label className="block">
          <span className="label">Email</span>
          <input
            type="email"
            required
            className="input mt-2"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            maxLength={254}
            placeholder="you@example.com"
          />
        </label>

        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="label">Password</span>
            {mode === 'signin' ? (
              <Link
                href="/forgot-password"
                className="text-[11px] text-mist-400 transition-colors hover:text-white"
              >
                Forgot password?
              </Link>
            ) : null}
          </div>
          <input
            type="password"
            required
            className="input mt-2"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={mode === 'signup' ? 10 : 1}
            maxLength={200}
          />
        </div>

        {mode === 'signup' ? (
          <>
            <label className="block">
              <span className="label">Confirm password</span>
              <input
                type="password"
                required
                className="input mt-2"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={10}
                maxLength={200}
              />
            </label>
            <p className="field-hint">At least 10 characters. We email you a link to verify the address.</p>
          </>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        {resendForEmail ? (
          <div className="rounded-xl border border-ink-700 bg-ink-850/60 p-3">
            <p className="text-[11px] leading-relaxed text-mist-400">
              We can send a fresh verification link to{' '}
              <span className="text-mist-200">{resendForEmail}</span>.
            </p>
            {resend.message ? <p className="mt-2 text-xs text-emerald-200">{resend.message}</p> : null}
            {resend.error ? <p className="mt-2 text-xs text-rose-200">{resend.error}</p> : null}
            <button
              type="button"
              className="btn-secondary mt-3 w-full text-xs"
              disabled={resend.busy}
              onClick={() => void resendVerification(resendForEmail)}
            >
              {resend.busy ? 'Sending…' : 'Resend verification email'}
            </button>
          </div>
        ) : null}

        <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-mist-400">
        {mode === 'signin' ? 'New to AutoClipper?' : 'Already have an account?'}{' '}
        <button
          type="button"
          onClick={switchMode}
          className="text-mist-200 underline decoration-ink-500 underline-offset-4 transition-colors hover:text-white"
        >
          {mode === 'signin' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
