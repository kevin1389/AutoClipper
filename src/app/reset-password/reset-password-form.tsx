'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'Could not reset the password.');
        return;
      }
      setDone(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="mt-5">
        <p
          role="status"
          className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-200"
        >
          Your password has been updated, and every other session was signed out.
        </p>
        <Link href="/login?reset=1" className="btn-primary mt-4 w-full justify-center py-3">
          Sign in with the new password
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3.5">
      <label className="block">
        <span className="label">New password</span>
        <input
          type="password"
          required
          className="input mt-2"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={10}
          maxLength={200}
        />
      </label>

      <label className="block">
        <span className="label">Confirm new password</span>
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

      <p className="field-hint">At least 10 characters.</p>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? 'Updating…' : 'Update password'}
      </button>
    </form>
  );
}
