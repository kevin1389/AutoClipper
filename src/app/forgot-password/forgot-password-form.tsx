'use client';

import { useState, type FormEvent } from 'react';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!response.ok) {
        setError(data.error ?? 'Could not request a reset link.');
        return;
      }
      setMessage(
        data.message ?? 'If an account exists for that email, a password reset link has been sent.',
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-3.5">
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

      {message ? (
        <p
          role="status"
          className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-200"
        >
          {message}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
