const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Emails are matched case-insensitively and without surrounding whitespace. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length > 0 && value.length <= 254 && EMAIL_PATTERN.test(value);
}
