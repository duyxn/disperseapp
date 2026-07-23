/**
 * The site password, as the browser holds it.
 *
 * This is a convenience store, not a security boundary — the server re-checks
 * the password on every API call that returns anything sensitive.
 */

const KEY = 'site:password';

export function getPassword(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setPassword(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Private browsing: the session still works, it just won't be remembered.
  }
}

export function clearPassword(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — an unreadable store is already "cleared".
  }
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export async function verifyPassword(password: string): Promise<VerifyResult> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'x-site-password': password },
    });

    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? `Sign-in failed: ${res.status}` };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}
