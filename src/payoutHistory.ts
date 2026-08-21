import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { DISPERSE_ADDRESS, disperseAbi } from './abi';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back we look for prior payouts, unless the user changes it. */
export const DEFAULT_WINDOW_DAYS = 10;

/**
 * The longest look-back offered. Past this the Alchemy page cap starts biting
 * for an active wallet, and a truncated history is a false all-clear.
 */
export const MAX_WINDOW_DAYS = 90;

export function clampWindowDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(days)));
}

/**
 * Look-backs we actually fetch at.
 *
 * The window is a control the user nudges, and every distinct value would
 * otherwise be its own multi-wallet RPC sweep — including each intermediate
 * value typed on the way to the one they meant. Fetching a superset and
 * trimming to the exact window in `findDuplicates` keeps that to one sweep per
 * tier, and makes narrowing the window instant.
 */
const FETCH_TIERS = [1, 3, 7, 14, 30, 60, MAX_WINDOW_DAYS];

/** The tier a given look-back is served from. Always >= `days`. */
export function fetchWindowDays(days: number): number {
  const wanted = clampWindowDays(days);
  return FETCH_TIERS.find((t) => t >= wanted) ?? MAX_WINDOW_DAYS;
}

/** Blocks spanning `days` at 12s each, with slack for faster-than-nominal periods. */
function windowBlocks(days: number): bigint {
  return BigInt(Math.ceil((days * DAY_MS * 1.02) / 12_000));
}

/**
 * Every wallet you send disperses from.
 *
 * The check reads the chain, not a database, so it can only catch a repeat if it
 * looks at the wallet that actually made the earlier payment. Sending from one
 * wallet and re-sending from another is exactly how a recipient gets paid twice
 * without either wallet's own history showing it — so all of them are always
 * checked, whichever one is currently connected. Add a new sending wallet here
 * the day you start using it, or a payment from it will be invisible to this.
 */
export const SENDER_WALLETS: Address[] = [
  '0x3f128b6703f4004bf5eb169ba6e9af1cba4af8df',
  '0x858689198a3ab2e88846ae5e9d8f905aeb251205',
];

/** True when this wallet is one whose history the check actually compares. */
export function isKnownSender(wallet: Address | undefined): boolean {
  if (!wallet) return false;
  return SENDER_WALLETS.some((w) => w.toLowerCase() === wallet.toLowerCase());
}

/** The connected wallet plus every configured sender, de-duplicated. */
export function walletsToCheck(connected: Address | undefined): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const w of [...(connected ? [connected] : []), ...SENDER_WALLETS]) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`;

/** A single outbound payment: `token: null` means ETH. */
export type Payout = {
  recipient: Address;
  token: Address | null;
  amount: bigint;
  timestamp: number;
  hash: Hex;
  /** Which of your wallets sent it. */
  sender: Address;
  /** Submitted from this browser but not yet visible to the indexer. */
  pending?: boolean;
};

type AlchemyTransfer = {
  hash: Hex;
  from: Address;
  to: Address | null;
  category: string;
  metadata?: { blockTimestamp?: string };
  rawContract?: { value?: Hex | null; address?: Address | null };
};

async function getAssetTransfers(params: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  const out: AlchemyTransfer[] = [];
  let pageKey: string | undefined;

  // Bounded: a wallet with more than 5k outbound transfers in 7 days is not the
  // case this check is for, and we'd rather degrade than hammer the RPC.
  for (let page = 0; page < 5; page++) {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [{ ...params, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }],
      }),
    });

    if (!res.ok) throw new Error(`Alchemy request failed: ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? 'Alchemy request failed');

    out.push(...(json.result?.transfers ?? []));
    pageKey = json.result?.pageKey;
    if (!pageKey) return out;
  }

  // Truncating here would hide prior payouts and silently weaken the very check
  // this powers, so an incomplete history has to be reported as a failure.
  throw new Error('Too many recent transfers to check reliably');
}

function transferTimestamp(t: AlchemyTransfer): number {
  const ts = t.metadata?.blockTimestamp;
  return ts ? Date.parse(ts) : 0;
}

function transferAmount(t: AlchemyTransfer): bigint | null {
  const raw = t.rawContract?.value;
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Resolve in batches so a large history doesn't burst the RPC rate limit. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Every payment this wallet made in the window, from the chain itself.
 *
 * Both disperse paths route value through the contract, so neither shows the
 * real recipients in the sender's own transfers:
 *
 *   - `disperseEther` forwards ETH from the contract, so the internal transfers
 *     are attributed to Disperse rather than to the sender.
 *   - `disperseToken` pulls the aggregate into the contract first, so the
 *     sender's only ERC-20 transfer is one lump sum addressed to Disperse.
 *
 * In both cases the transfer *to* Disperse is our handle on the transaction: we
 * decode its calldata and fan it back out into the real recipients, the same
 * decode `ExportFromTx` does. Transfers to anywhere else are already direct
 * payments — plain sends and `disperseTokenSimple` alike — and are kept as-is.
 */
export async function fetchRecentPayouts(
  client: PublicClient,
  user: Address,
  now: number,
  days: number,
): Promise<Payout[]> {
  const blocks = windowBlocks(days);
  const latestBlock = await client.getBlockNumber();
  const fromBlock = `0x${(latestBlock > blocks ? latestBlock - blocks : 0n).toString(16)}`;
  const cutoff = now - days * DAY_MS;

  const [erc20, external] = await Promise.all([
    getAssetTransfers({
      fromAddress: user,
      fromBlock,
      toBlock: 'latest',
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: true,
    }),
    getAssetTransfers({
      fromAddress: user,
      fromBlock,
      toBlock: 'latest',
      category: ['external'],
      withMetadata: true,
      excludeZeroValue: true,
    }),
  ]);

  const payouts: Payout[] = [];
  /** Transactions that routed value through Disperse, keyed by hash. */
  const disperseTxs = new Map<Hex, number>();

  const collect = (t: AlchemyTransfer, token: Address | null) => {
    const timestamp = transferTimestamp(t);
    if (!t.to || timestamp < cutoff) return;

    if (t.to.toLowerCase() === DISPERSE_ADDRESS.toLowerCase()) {
      disperseTxs.set(t.hash, timestamp);
      return;
    }

    const amount = transferAmount(t);
    if (amount == null || amount === 0n) return;
    payouts.push({ recipient: t.to, token, amount, timestamp, hash: t.hash, sender: user });
  };

  for (const t of erc20) collect(t, t.rawContract?.address ?? null);
  for (const t of external) collect(t, null);

  // Fan each disperse back out into the recipients named in its calldata.
  const decoded = await inBatches([...disperseTxs], 5, async ([hash, timestamp]) => {
    // A transport failure must not masquerade as "no prior payouts", so this is
    // deliberately left to propagate and fail the whole check.
    const tx = await client.getTransaction({ hash });

    // The transfer only tells us Disperse was involved. Unless the user called
    // it directly, the calldata belongs to some other contract and could decode
    // against this ABI by coincidence, inventing payouts that never happened.
    if (!tx.to || tx.to.toLowerCase() !== DISPERSE_ADDRESS.toLowerCase()) return [];

    let call: { functionName: string; args: readonly unknown[] };
    try {
      call = decodeFunctionData({ abi: disperseAbi, data: tx.input });
    } catch {
      // Value sent to Disperse by some other means — nothing to fan out.
      return [];
    }

    if (call.functionName === 'disperseEther') {
      const [recipients, values] = call.args as [Address[], bigint[]];
      return recipients.map((recipient, i) => ({
        recipient,
        token: null,
        amount: values[i] ?? 0n,
        timestamp,
        hash,
        sender: user,
      })) satisfies Payout[];
    }

    if (call.functionName === 'disperseToken' || call.functionName === 'disperseTokenSimple') {
      const [token, recipients, values] = call.args as [Address, Address[], bigint[]];
      return recipients.map((recipient, i) => ({
        recipient,
        token,
        amount: values[i] ?? 0n,
        timestamp,
        hash,
        sender: user,
      })) satisfies Payout[];
    }

    return [];
  });

  payouts.push(...decoded.flat());
  return payouts;
}

/** Every payment made by any of the given wallets in the window, merged. */
export async function fetchPayoutsForWallets(
  client: PublicClient,
  wallets: Address[],
  now: number,
  days: number,
): Promise<Payout[]> {
  // A failure in any wallet's fetch must fail the whole check rather than
  // quietly omit that wallet's payments — a partial history is a false all-clear.
  const perWallet = await Promise.all(wallets.map((w) => fetchRecentPayouts(client, w, now, days)));
  return perWallet.flat();
}

function sameToken(a: Address | null, b: Address | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Narrows which prior payments count as a duplicate.
 *
 * `amount`/`tolerance` are the opt-in half. By default amount is deliberately
 * not part of the match: the question is "did I already pay this wallet?", not
 * "did I pay it this exact figure?". Re-runs that owe a different amount the
 * second time (a corrected balance, an added review) are still the same
 * recipient being paid twice, and matching on amount would let every one of
 * those through. But when you already know a batch legitimately re-pays the
 * same people different sums, near-equal amounts are the signal worth keeping
 * and everything else is noise — so it's offered, off by default.
 */
export type DuplicateFilter = {
  /** Ignore anything paid before this instant. */
  cutoff: number;
  /** The amount about to be sent. Only matched when `tolerance` is also set. */
  amount?: bigint;
  /** Max absolute difference from `amount`, in the token's own units. */
  tolerance?: bigint;
};

function withinTolerance(a: bigint, b: bigint, tolerance: bigint): boolean {
  return (a > b ? a - b : b - a) <= tolerance;
}

/**
 * Every prior payment to this recipient, of the same asset, from any of your
 * wallets, inside the window — most recent first.
 *
 * All matches are returned, not just the latest: someone paid three times in
 * the window is a bigger problem than someone paid once, and collapsing that to
 * a single line hides it.
 */
export function findDuplicates(
  payouts: Payout[],
  recipient: Address,
  token: Address | null,
  filter: DuplicateFilter,
): Payout[] {
  const { cutoff, amount, tolerance } = filter;

  return payouts
    .filter(
      (p) =>
        p.recipient.toLowerCase() === recipient.toLowerCase() &&
        sameToken(p.token, token) &&
        p.timestamp >= cutoff &&
        (amount == null || tolerance == null || withinTolerance(p.amount, amount, tolerance)),
    )
    .sort((a, b) => b.timestamp - a.timestamp);
}

// --- Pending overlay -------------------------------------------------------
//
// An indexer won't see a disperse for ~15s after it's submitted, which is
// exactly the window in which someone re-sends out of impatience. We record
// what we submit locally to cover that gap; the chain remains the source of
// truth for anything older.

/**
 * How long a locally-recorded submission is trusted.
 *
 * Deliberately far shorter than the duplicate window. A submitted transaction
 * can revert, be cancelled, be replaced, or simply be dropped, in which case
 * nobody was paid and a record claiming otherwise is a false warning. Rather
 * than track every one of those outcomes, the record expires once the chain has
 * had ample time to show the truth: if it landed, it is in the indexed history
 * by now; if it didn't, it should no longer be flagged.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

type StoredPayout = {
  recipient: Address;
  token: Address | null;
  amount: string;
  timestamp: number;
  hash: Hex;
};

function storageKey(user: Address): string {
  return `disperse:pending:${user.toLowerCase()}`;
}

export function readPendingPayouts(user: Address, now: number): Payout[] {
  try {
    const raw = localStorage.getItem(storageKey(user));
    if (!raw) return [];

    const stored = JSON.parse(raw) as StoredPayout[];
    const cutoff = now - PENDING_TTL_MS;

    return stored
      .filter((p) => p.timestamp >= cutoff)
      .map((p) => ({ ...p, amount: BigInt(p.amount), sender: user, pending: true }));
  } catch {
    return [];
  }
}

export function recordPendingPayouts(
  user: Address,
  entries: { recipient: Address; token: Address | null; amount: bigint }[],
  hash: Hex,
  now: number,
): void {
  try {
    const cutoff = now - PENDING_TTL_MS;
    const existing = (() => {
      const raw = localStorage.getItem(storageKey(user));
      if (!raw) return [] as StoredPayout[];
      return (JSON.parse(raw) as StoredPayout[]).filter((p) => p.timestamp >= cutoff);
    })();

    // The effect that calls this can fire twice (StrictMode, remounts).
    if (existing.some((p) => p.hash.toLowerCase() === hash.toLowerCase())) return;

    const added = entries.map((e) => ({
      recipient: e.recipient,
      token: e.token,
      amount: e.amount.toString(),
      timestamp: now,
      hash,
    }));

    localStorage.setItem(storageKey(user), JSON.stringify([...existing, ...added]));
  } catch {
    // Storage disabled or full — the on-chain check still covers us.
  }
}

/**
 * Forget a submitted transaction — it reverted, or was cancelled or replaced,
 * so those recipients were never actually paid and must stop being flagged.
 */
export function removePendingPayouts(user: Address, hash: Hex): void {
  try {
    const raw = localStorage.getItem(storageKey(user));
    if (!raw) return;

    const kept = (JSON.parse(raw) as StoredPayout[]).filter(
      (p) => p.hash.toLowerCase() !== hash.toLowerCase(),
    );
    localStorage.setItem(storageKey(user), JSON.stringify(kept));
  } catch {
    // Storage unavailable — nothing recorded, nothing to undo.
  }
}

/** Drop pending records the indexer has caught up on, so we don't double-count. */
export function mergePayouts(onChain: Payout[], pending: Payout[]): Payout[] {
  const seen = new Set(onChain.map((p) => p.hash.toLowerCase()));
  return [...onChain, ...pending.filter((p) => !seen.has(p.hash.toLowerCase()))];
}

export function formatAgo(timestamp: number, now: number): string {
  const mins = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
