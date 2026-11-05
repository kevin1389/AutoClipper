import type { SessionUser } from '@/lib/auth';
import { accountLabel } from '@/lib/auth';

/** Sign-out is a same-origin POST that revokes the session row server-side. */
export function AccountBadge({ user, compact = false }: { user: SessionUser; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      {!compact && (
        <div className="hidden text-right leading-tight sm:block">
          <p className="max-w-[16rem] truncate text-xs font-medium text-mist-200">{accountLabel(user)}</p>
          {user.email && user.name ? (
            <p className="max-w-[16rem] truncate text-[10px] text-mist-500">{user.email}</p>
          ) : null}
        </div>
      )}
      <form method="post" action="/api/auth/sign-out">
        <button type="submit" className="btn-ghost text-xs">
          Sign out
        </button>
      </form>
    </div>
  );
}
