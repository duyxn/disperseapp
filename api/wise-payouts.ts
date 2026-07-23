/**
 * Recent Wise payouts, keyed by recipient email.
 *
 * The browser can't call Wise directly — the API has no CORS headers and the
 * token is a bearer secret — so this proxy runs server-side on Vercel and only
 * ever returns the narrow slice the duplicate check needs.
 *
 * GET /api/wise-payouts?days=7
 *   x-site-password: <SITE_PASSWORD>
 */
import { checkPassword, clientIp } from './_auth';

type Req = { method?: string; query: Record<string, string | string[] | undefined>; headers: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

export const config = { maxDuration: 60 };

/**
 * Only these origins ever receive the bearer token. A mistyped or tampered
 * WISE_API_URL would otherwise send it somewhere else entirely, so an unknown
 * value falls back to production rather than being trusted.
 */
const ALLOWED_API_URLS = new Set([
  'https://api.transferwise.com',
  'https://api.sandbox.transferwise.tech',
]);

const configuredUrl = process.env.WISE_API_URL?.replace(/\/+$/, '');
const API_URL =
  configuredUrl && ALLOWED_API_URLS.has(configuredUrl) ? configuredUrl : 'https://api.transferwise.com';

/** Transfers in these states never moved money, so they aren't a duplicate. */
const DEAD_STATUSES = new Set(['cancelled', 'funds_refunded', 'charged_back', 'unknown']);

/** Guard rails — a 7-day window that blows past these is not what this is for. */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const MAX_ACCOUNT_LOOKUPS = 500;
const ACCOUNT_CONCURRENCY = 6;

type WiseTransfer = {
  id: number;
  targetAccount: number | null;
  status: string;
  reference?: string | null;
  created: string;
  targetValue: number;
  targetCurrency: string;
  sourceValue: number;
  sourceCurrency: string;
  details?: { reference?: string | null };
};

type WiseAccount = {
  id: number;
  accountHolderName?: string | null;
  type?: string | null;
  details?: { email?: string | null } | null;
};

export type WisePayout = {
  transferId: number;
  email: string | null;
  name: string | null;
  reference: string | null;
  amount: number;
  currency: string;
  created: string;
  status: string;
};

async function wise<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    // The upstream body is deliberately logged rather than thrown: it can echo
    // request details back, and the thrown message reaches the browser.
    const body = await res.text().catch(() => '');
    console.error(`Wise ${path.split('?')[0]} failed: ${res.status} ${body.slice(0, 500)}`);
    throw new Error(`Wise request failed (${res.status}).`);
  }

  return (await res.json()) as T;
}

async function resolveProfileId(token: string): Promise<number> {
  const fromEnv = process.env.WISE_PROFILE_ID;
  if (fromEnv) return Number(fromEnv);

  const profiles = await wise<{ id: number; type: string }[]>('/v1/profiles', token);
  // Batch payouts run off the business profile whenever there is one.
  const business = profiles.find((p) => p.type === 'business');
  const chosen = business ?? profiles[0];
  if (!chosen) throw new Error('No Wise profiles visible to this token.');
  return chosen.id;
}

async function fetchTransfers(token: string, profileId: number, since: Date, until: Date) {
  const all: WiseTransfer[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      profile: String(profileId),
      offset: String(page * PAGE_SIZE),
      limit: String(PAGE_SIZE),
      createdDateStart: since.toISOString(),
      createdDateEnd: until.toISOString(),
    });

    const batch = await wise<WiseTransfer[]>(`/v1/transfers?${qs}`, token);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return { transfers: all, truncated: false };
  }

  return { transfers: all, truncated: true };
}

/** Transfers carry a recipient account id, not an email — resolve them once each. */
async function fetchAccounts(token: string, ids: number[]): Promise<Map<number, WiseAccount>> {
  const byId = new Map<number, WiseAccount>();

  for (let i = 0; i < ids.length; i += ACCOUNT_CONCURRENCY) {
    const chunk = ids.slice(i, i + ACCOUNT_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          return await wise<WiseAccount>(`/v1/accounts/${id}`, token);
        } catch {
          // A deleted recipient still leaves its transfer in the list; we just
          // can't name it. Losing one row beats failing the whole check.
          return null;
        }
      }),
    );

    for (const account of results) if (account) byId.set(account.id, account);
  }

  return byId;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // The React gate is cosmetic; this is the check that actually protects the
  // payout data, which is why it's repeated here and not just on /api/login.
  const auth = checkPassword(req.headers['x-site-password'], clientIp(req.headers));
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  const token = process.env.WISE_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'WISE_API_TOKEN is not set on the server.' });
    return;
  }

  const days = Math.min(90, Math.max(1, Number(firstValue(req.query.days) ?? 7) || 7));

  try {
    const profileId = await resolveProfileId(token);
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

    const { transfers, truncated } = await fetchTransfers(token, profileId, since, until);
    const live = transfers.filter((t) => !DEAD_STATUSES.has(t.status));

    const accountIds = [...new Set(live.map((t) => t.targetAccount).filter((id): id is number => id != null))];
    const accounts = await fetchAccounts(token, accountIds.slice(0, MAX_ACCOUNT_LOOKUPS));

    const payouts: WisePayout[] = live.map((t) => {
      const account = t.targetAccount != null ? accounts.get(t.targetAccount) : undefined;
      const email = account?.details?.email ?? null;
      return {
        transferId: t.id,
        email: email ? email.trim().toLowerCase() : null,
        name: account?.accountHolderName ?? null,
        reference: t.details?.reference ?? t.reference ?? null,
        amount: t.targetValue,
        currency: t.targetCurrency,
        created: t.created,
        status: t.status,
      };
    });

    res.status(200).json({
      profileId,
      days,
      since: since.toISOString(),
      until: until.toISOString(),
      count: payouts.length,
      /** True when the window held more transfers than we were willing to page through. */
      truncated: truncated || accountIds.length > MAX_ACCOUNT_LOOKUPS,
      payouts,
    });
  } catch (e) {
    // Detail goes to the function log, not to the browser.
    console.error('wise-payouts failed:', e);
    res.status(502).json({ error: 'Could not reach Wise. Check the server logs.' });
  }
}
