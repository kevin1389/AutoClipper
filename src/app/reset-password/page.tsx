import Link from 'next/link';
import { AuthPage } from '@/components/auth-page';
import { ResetPasswordForm } from './reset-password-form';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  return (
    <AuthPage>
      <p className="label">Account access</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Choose a new password</h1>

      {token ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-mist-400">
            The link can be used once. Resetting also signs you out everywhere else.
          </p>
          <ResetPasswordForm token={token} />
        </>
      ) : (
        <div className="mt-5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200">
          This reset link is missing its token. Request a new email from the forgot-password page.
        </div>
      )}

      <p className="mt-6 text-center text-xs text-mist-400">
        <Link href="/forgot-password" className="link">
          Request another link
        </Link>
      </p>
    </AuthPage>
  );
}
