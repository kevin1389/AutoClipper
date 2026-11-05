/** Only local absolute paths are accepted as post-sign-in destinations. */
export function safeNextPath(value: string | string[] | null | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  if (/[\\\u0000-\u001f]/.test(raw)) return '/dashboard';
  return raw.slice(0, 500);
}
