import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';
import { SiteFooter } from './site-header';

/** Shared black/charcoal frame for login, registration and password screens. */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-700/70 bg-ink-950">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo />
          <Link href="/" className="btn-ghost text-xs">
            Home
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-5 py-16 sm:px-8">
        <div className="panel mx-auto w-full max-w-md p-7">{children}</div>
      </main>

      <SiteFooter />
    </div>
  );
}
