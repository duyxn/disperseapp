import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { DISPERSE_ADDRESS, disperseAbi } from './abi';

/** How far back we look for prior payouts. */
export const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Amounts within this fraction of a prior payout count as the same payment. */
export const DUPLICATE_TOLERANCE = 0.01;

/** ~3 days of blocks at 12s, with slack for faster-than-nominal periods. */
const WINDOW_BLOCKS = 22_000n;

const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`;

/** A single outbound payment: `token: null` means ETH. */
export type Payout = {
  recipient: Address;
  token: Address | null;
  amount: bigint;
  timestamp: number;
  hash: Hex;
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

  // Bounded: a wallet with more than 5k outbound transfers in 3 days is not the
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
): Promise<Payout[]> {
  const latestBlock = await client.getBlockNumber();
  const fromBlock = `0x${(latestBlock > WINDOW_BLOCKS ? latestBlock - WINDOW_BLOCKS : 0n).toString(16)}`;
  const cutoff = now - DUPLICATE_WINDOW_MS;

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
    payouts.push({ recipient: t.to, token, amount, timestamp, hash: t.hash });
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
      })) satisfies Payout[];
    }

    return [];
  });

  payouts.push(...decoded.flat());
  return payouts;
}

/** True when `a` is within the tolerance band around the earlier amount `b`. */
export function amountsMatch(a: bigint, b: bigint): boolean {
  if (b === 0n) return a === 0n;
  const diff = a > b ? a - b : b - a;
  return diff * 10_000n <= b * BigInt(Math.round(DUPLICATE_TOLERANCE * 10_000));
}

function sameToken(a: Address | null, b: Address | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/** The most recent prior payout matching this recipient, token, and amount. */
export function findDuplicate(
  payouts: Payout[],
  recipient: Address,
  token: Address | null,
  amount: bigint,
): Payout | null {
  let best: Payout | null = null;

  for (const p of payouts) {
    if (p.recipient.toLowerCase() !== recipient.toLowerCase()) continue;
    if (!sameToken(p.token, token)) continue;
    if (!amountsMatch(amount, p.amount)) continue;
    if (!best || p.timestamp > best.timestamp) best = p;
  }

  return best;
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
      .map((p) => ({ ...p, amount: BigInt(p.amount), pending: true }));
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
