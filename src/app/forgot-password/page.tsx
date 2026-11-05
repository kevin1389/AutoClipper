import Link from 'next/link';
import { AuthPage } from '@/components/auth-page';
import { ForgotPasswordForm } from './forgot-password-form';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return (
    <AuthPage>
      <p className="label">Account access</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Forgot your password?</h1>
      <p className="mt-3 text-sm leading-relaxed text-mist-400">
        Enter the email address on your account. If it exists, we send a single-use link that expires
        in one hour.
      </p>

      <ForgotPasswordForm />

      <p className="mt-6 text-center text-xs text-mist-400">
        <Link href="/login" className="link">
          Back to sign in
        </Link>
      </p>
    </AuthPage>
  );
}
