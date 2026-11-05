import { redirect } from 'next/navigation';
import { AuthForm } from './auth-form';
import { AuthPage } from '@/components/auth-page';
import { getCurrentUser } from '@/lib/auth';
import { googleAvailability } from '@/lib/google';
import { safeNextPath } from '@/lib/safe-next';

export const dynamic = 'force-dynamic';

const AUTH_ERRORS: Record<string, string> = {
  verify_invalid: 'That verification link is invalid, expired or already used. Request a new one below.',
  google_not_configured: 'Google sign-in is not configured for this deployment. Use your email instead.',
  google_state: 'That Google sign-in attempt expired. Please try again.',
  google_exchange: 'Google could not complete the sign-in. Please try again.',
  google_denied: 'Google sign-in was cancelled.',
  google_email_unverified:
    'Google did not confirm your email address, so no account was created. Use email and password instead.',
  google_profile: 'Google did not return a usable profile. Please try again.',
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    error?: string | string[];
    verified?: string | string[];
    reset?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const user = await getCurrentUser();
  if (user) redirect(next);

  const google = googleAvailability();
  const rawError = first(params.error);
  const errorMessage = rawError ? (AUTH_ERRORS[rawError] ?? 'Sign-in failed. Please try again.') : null;
  const notice =
    first(params.verified) === '1'
      ? 'Your email is verified. Sign in to continue.'
      : first(params.reset) === '1'
        ? 'Your password was updated. Sign in with the new password.'
        : null;

  return (
    <AuthPage>
      <p className="label">Your workspace</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Sign in to AutoClipper</h1>
      <p className="mt-3 text-sm leading-relaxed text-mist-400">
        Projects, uploads, clips and downloads are private to your account. Continue with Google or
        use an email and password.
      </p>

      {notice ? (
        <p
          role="status"
          className="mt-5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-200"
        >
          {notice}
        </p>
      ) : null}

      {errorMessage ? (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200"
        >
          {errorMessage}
        </p>
      ) : null}

      {google.configured ? (
        <a
          href={`/api/auth/google?next=${encodeURIComponent(next)}`}
          className="btn-primary mt-6 w-full justify-center py-3"
        >
          <GoogleIcon />
          Continue with Google
        </a>
      ) : (
        <div className="mt-6 rounded-xl border border-ink-700 bg-ink-850/60 p-4">
          <p className="text-xs font-medium text-mist-300">Google sign-in is not configured</p>
          <p className="mt-1 text-xs leading-relaxed text-mist-500">
            {google.reason} Add <span className="font-mono">GOOGLE_CLIENT_ID</span> and{' '}
            <span className="font-mono">GOOGLE_CLIENT_SECRET</span> to enable it.
          </p>
        </div>
      )}

      <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-mist-500">
        <span className="h-px flex-1 bg-ink-700" />
        or use your email
        <span className="h-px flex-1 bg-ink-700" />
      </div>

      <AuthForm next={next} />

      <p className="mt-6 text-[11px] leading-relaxed text-mist-500">
        Passwords are stored as salted scrypt hashes; the app never stores or logs them in plain
        text. Sessions use an HTTP-only cookie, and signing out revokes the session on the server.
      </p>
    </AuthPage>
  );
}
