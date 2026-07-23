/**
 * Shared password check for the API routes.
 *
 * The gate in the browser is cosmetic — anyone can skip a React screen with
 * devtools. This is the one that matters, because it's the only thing standing
 * between the public internet and the payout data.
 *
 * Files under /api starting with `_` are not turned into routes by Vercel.
 */
import { timingSafeEqual } from 'node:crypto';

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Crude per-IP throttle on wrong guesses.
 *
 * One shared password with unlimited attempts is guessable given enough time,
 * and every accepted request here can fan out into hundreds of Wise calls.
 *
 * Caveat worth knowing: this Map lives in one warm serverless instance, so it
 * is per-instance, resets on cold start, and a spread-out attacker will evade
 * it. It raises the cost of a naive attack; it is not a real rate limiter. For
 * that, put a rate-limit rule on /api/* in the Vercel firewall.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  // Left-most entry is the original client; the rest are proxies.
  return value?.split(',')[0]?.trim() || 'unknown';
}

function throttled(ip: string, now: number): boolean {
  const seen = failures.get(ip);
  if (!seen) return false;
  if (now - seen.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return seen.count >= MAX_FAILURES;
}

function recordFailure(ip: string, now: number): void {
  // Bound the map so a spray of forged IPs can't grow it without limit.
  if (failures.size > 10_000) failures.clear();

  const seen = failures.get(ip);
  if (!seen || now - seen.first > WINDOW_MS) failures.set(ip, { count: 1, first: now });
  else seen.count++;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function checkPassword(
  supplied: string | string[] | undefined,
  ip = 'unknown',
): AuthResult {
  const expected = process.env.SITE_PASSWORD;

  // Fail closed: an unset password would otherwise silently open the endpoint.
  if (!expected) {
    return { ok: false, status: 500, error: 'SITE_PASSWORD is not set on the server.' };
  }

  const now = Date.now();
  if (throttled(ip, now)) {
    return { ok: false, status: 429, error: 'Too many attempts. Try again later.' };
  }

  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!value || !constantTimeEqual(value, expected)) {
    recordFailure(ip, now);
    return { ok: false, status: 401, error: 'Wrong password.' };
  }

  failures.delete(ip);
  return { ok: true };
}
