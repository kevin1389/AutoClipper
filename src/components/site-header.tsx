import Link from 'next/link';
import { AccountBadge } from './account-badge';
import { Logo } from './logo';
import { getCurrentUser } from '@/lib/auth';

export { Logo };

export async function SiteHeader() {
  const user = await getCurrentUser();

  return (
    <header className="sticky top-0 z-40 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-7 text-sm text-mist-300 md:flex">
          <Link href="/#how" className="transition-colors hover:text-white">
            How it works
          </Link>
          <Link href="/#pipeline" className="transition-colors hover:text-white">
            Pipeline
          </Link>
          <Link href="/#limits" className="transition-colors hover:text-white">
            Honest limits
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          {user ? (
            <>
              <AccountBadge user={user} />
              <Link href="/dashboard" className="btn-primary">
                Dashboard
              </Link>
            </>
          ) : (
            <>
              <Link href="/login" className="btn-secondary hidden sm:inline-flex">
                Sign in
              </Link>
              <Link href="/dashboard" className="btn-primary">
                Start clipping
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-700/70 bg-ink-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Logo compact />
          <p className="max-w-sm text-xs leading-relaxed text-mist-500">
            AutoClipper renders real MP4 files with FFmpeg. Transcriptions and highlight selection are
            pluggable providers — the app never fabricates clips.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-mist-400">
          <Link href="/dashboard" className="hover:text-white">
            Dashboard
          </Link>
          <Link href="/api/health" className="hover:text-white">
            System status
          </Link>
          <span className="text-mist-500">Next.js · FFmpeg · SQLite</span>
        </div>
      </div>
    </footer>
  );
}
