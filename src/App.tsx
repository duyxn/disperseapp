import { useState, useMemo, useEffect, useCallback } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
} from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseEther, parseUnits, formatUnits, isAddress, type PublicClient } from 'viem';
import { DISPERSE_ADDRESS, disperseAbi, erc20Abi } from './abi';
import {
  fetchPayoutsForWallets,
  findDuplicates,
  formatAgo,
  mergePayouts,
  readPendingPayouts,
  recordPendingPayouts,
  removePendingPayouts,
  walletsToCheck,
  isKnownSender,
  clampWindowDays,
  fetchWindowDays,
  DAY_MS,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  PENDING_TTL_MS,
  type Payout,
} from './payoutHistory';
import { WiseCsvCheck } from './WiseCsvCheck';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7' as const;

type ParsedEntry = {
  address: `0x${string}`;
  amount: string;
  /** 0-based index in the raw textarea, so a single line can be removed precisely. */
  line: number;
};

type ParseResult = {
  valid: ParsedEntry[];
  errors: { line: number; text: string; reason: string }[];
};

function parseRecipients(input: string): ParseResult {
  const lines = input.split('\n');
  const valid: ParsedEntry[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(/[,\s=]+/).filter(Boolean);

    if (parts.length < 2) {
      errors.push({ line: i + 1, text: line, reason: 'Expected: address, amount' });
      continue;
    }

    const [addr, amt] = parts;

    if (!isAddress(addr)) {
      errors.push({ line: i + 1, text: line, reason: 'Invalid address' });
      continue;
    }

    if (isNaN(Number(amt)) || Number(amt) <= 0) {
      errors.push({ line: i + 1, text: line, reason: 'Invalid amount' });
      continue;
    }

    valid.push({ address: addr as `0x${string}`, amount: amt, line: i });
  }

  return { valid, errors };
}

function App() {
  const { address: userAddress, isConnected } = useAccount();
  const [page, setPage] = useState<'disperse' | 'wise'>('disperse');
  const [mode, setMode] = useState<'eth' | 'usdc' | 'usdt' | 'erc20'>('eth');
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [recipientInput, setRecipientInput] = useState('');

  // Duplicate-check settings.
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [amountFilterOn, setAmountFilterOn] = useState(false);
  const [toleranceInput, setToleranceInput] = useState('5');

  const isToken = mode !== 'eth';
  const tokenAddress = mode === 'usdc' ? USDC_ADDRESS : mode === 'usdt' ? USDT_ADDRESS : customTokenAddress;

  const validTokenAddress = isAddress(tokenAddress) ? (tokenAddress as `0x${string}`) : undefined;

  // Token info
  const { data: tokenSymbol, isLoading: symbolLoading, isError: symbolFailed } = useReadContract({
    address: validTokenAddress!,
    abi: erc20Abi,
    functionName: 'symbol',
    query: { enabled: !!validTokenAddress, retry: 3, retryDelay: 1000 },
  });

  const { data: tokenDecimals, isLoading: decimalsLoading } = useReadContract({
    address: validTokenAddress!,
    abi: erc20Abi,
    functionName: 'decimals',
    query: { enabled: !!validTokenAddress, retry: 3, retryDelay: 1000 },
  });

  const { data: tokenName } = useReadContract({
    address: validTokenAddress!,
    abi: erc20Abi,
    functionName: 'name',
    query: { enabled: !!validTokenAddress, retry: 3, retryDelay: 1000 },
  });

  const { data: tokenBalance } = useReadContract({
    address: validTokenAddress!,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress!],
    query: { enabled: !!validTokenAddress && !!userAddress, retry: 3, retryDelay: 1000 },
  });

  const tokenLoading = symbolLoading || decimalsLoading;

  // Parse recipients
  const parsed = useMemo(() => parseRecipients(recipientInput), [recipientInput]);

  const decimals = isToken && tokenDecimals != null ? tokenDecimals : 18;

  // Compute amounts in wei
  const amounts = useMemo(() => {
    try {
      return parsed.valid.map((e) =>
        isToken ? parseUnits(e.amount, decimals) : parseEther(e.amount),
      );
    } catch {
      return null;
    }
  }, [parsed.valid, isToken, decimals]);

  const totalAmount = useMemo(() => {
    if (!amounts) return 0n;
    return amounts.reduce((sum, v) => sum + v, 0n);
  }, [amounts]);

  // Recent payout history, for the duplicate check
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  // Every configured sending wallet is checked, not just the connected one —
  // a repeat is only visible if we look at the wallet that made the first send.
  const checkedWallets = useMemo(() => walletsToCheck(userAddress), [userAddress]);

  // Connected but unlisted means this wallet's own past sends aren't in
  // SENDER_WALLETS, so a duplicate from it would slip through unseen.
  const unlistedSender = isConnected && !!userAddress && !isKnownSender(userAddress);

  // Served from a tier at least as wide as the window asked for, so narrowing
  // the look-back re-filters in place instead of re-reading the chain.
  const fetchDays = fetchWindowDays(windowDays);

  const { data: recentPayouts, isLoading: historyLoading, isError: historyFailed } = useQuery({
    queryKey: ['recentPayouts', checkedWallets.map((w) => w.toLowerCase()).sort(), fetchDays],
    enabled: checkedWallets.length > 0 && !!publicClient,
    staleTime: 60_000,
    queryFn: (): Promise<Payout[]> =>
      fetchPayoutsForWallets(publicClient as PublicClient, checkedWallets, Date.now(), fetchDays),
  });

  // The pending overlay lives in state, not read straight from localStorage:
  // storage writes and TTL expiry are invisible to React, so a memo reading it
  // directly could show a stale warning — or miss a fresh one — indefinitely.
  // Kept per wallet: a tx submitted by one account can resolve after the user
  // has switched to another, and that late write must neither be checked
  // against the new wallet's history nor displace its records.
  const [pendingByOwner, setPendingByOwner] = useState<Record<string, Payout[]>>({});

  const reloadPending = useCallback((sender: `0x${string}`) => {
    setPendingByOwner((prev) => ({
      ...prev,
      [sender.toLowerCase()]: readPendingPayouts(sender, Date.now()),
    }));
  }, []);

  useEffect(() => {
    if (userAddress) reloadPending(userAddress);
  }, [userAddress, reloadPending]);

  const pendingPayouts = useMemo(
    () => (userAddress ? (pendingByOwner[userAddress.toLowerCase()] ?? []) : []),
    [pendingByOwner, userAddress],
  );

  // Nothing else re-renders when a record simply gets old, so drive expiry.
  useEffect(() => {
    if (pendingPayouts.length === 0) return;
    const id = setInterval(() => {
      setPendingByOwner((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, Payout[]> = {};

        for (const [owner, payouts] of Object.entries(prev)) {
          const kept = payouts.filter((p) => now - p.timestamp < PENDING_TTL_MS);
          if (kept.length !== payouts.length) changed = true;
          next[owner] = kept;
        }

        return changed ? next : prev;
      });
    }, 30_000);
    return () => clearInterval(id);
  }, [pendingPayouts.length]);

  // `null` means "don't narrow by amount" — the filter is off, or what's typed
  // isn't a usable figure. Both fall back to flagging every repeat, because the
  // failure that matters here is a duplicate slipping through unseen.
  const tolerance = useMemo(() => {
    if (!amountFilterOn) return null;
    const raw = toleranceInput.trim();
    if (!raw) return null;
    try {
      const value = parseUnits(raw, decimals);
      return value >= 0n ? value : null;
    } catch {
      return null;
    }
  }, [amountFilterOn, toleranceInput, decimals]);

  const toleranceInvalid = amountFilterOn && tolerance === null;

  const { duplicates, hiddenByAmount } = useMemo((): {
    duplicates: { entry: ParsedEntry; priors: (Payout & { ago: string })[] }[];
    hiddenByAmount: number;
  } => {
    const empty = { duplicates: [], hiddenByAmount: 0 };
    if (!recentPayouts || !amounts) return empty;
    const now = Date.now();
    const token = isToken ? (validTokenAddress ?? null) : null;
    if (isToken && !token) return empty;

    const history = mergePayouts(recentPayouts, pendingPayouts);
    const cutoff = now - windowDays * DAY_MS;

    const perEntry = parsed.valid.map((entry, i) => {
      // Both passes are run so the amount filter can say what it suppressed —
      // a narrowing that hides matches without admitting it reads as an
      // all-clear, which is the one thing this check must never fake.
      const inWindow = findDuplicates(history, entry.address, token, { cutoff });
      const priors =
        tolerance === null
          ? inWindow
          : findDuplicates(history, entry.address, token, {
              cutoff,
              amount: amounts[i],
              tolerance,
            });

      return {
        entry,
        priors: priors.map((p) => ({ ...p, ago: formatAgo(p.timestamp, now) })),
        suppressed: priors.length === 0 && inWindow.length > 0,
      };
    });

    return {
      duplicates: perEntry.filter((d) => d.priors.length > 0),
      hiddenByAmount: perEntry.filter((d) => d.suppressed).length,
    };
  }, [
    recentPayouts,
    pendingPayouts,
    amounts,
    parsed.valid,
    isToken,
    validTokenAddress,
    windowDays,
    tolerance,
  ]);

  // Allowance (ERC-20 only)
  const { data: currentAllowance, refetch: refetchAllowance } = useReadContract({
    address: validTokenAddress!,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress!, DISPERSE_ADDRESS],
    query: { enabled: isToken && !!validTokenAddress && !!userAddress },
  });

  const needsApproval = isToken && totalAmount > 0n && (currentAllowance ?? 0n) < totalAmount;

  // Approve tx
  const {
    writeContract: approve,
    data: approveHash,
    isPending: isApproving,
    reset: resetApprove,
  } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash });

  useEffect(() => {
    if (approveConfirmed) {
      refetchAllowance();
      resetApprove();
    }
  }, [approveConfirmed, refetchAllowance, resetApprove]);

  function handleApprove() {
    if (!validTokenAddress) return;
    approve({
      address: validTokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DISPERSE_ADDRESS, totalAmount],
    });
  }

  // Disperse tx
  const {
    writeContractAsync: disperse,
    data: disperseHash,
    error: disperseError,
    isPending: isDispersing,
    reset: resetDisperse,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: disperseHash,
  });

  // Tracked outside the mutation: `resetDisperse` fires whenever the recipients
  // or mode change, which would otherwise drop the tx we still need to follow.
  // The sender is carried along so that switching accounts can't make cleanup
  // target a different wallet's records.
  const [submittedTx, setSubmittedTx] = useState<{ hash: `0x${string}`; sender: `0x${string}` } | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isAwaitingHash, setIsAwaitingHash] = useState(false);

  const { isLoading: isSubmittedPending, isError: submittedFailed } = useWaitForTransactionReceipt({
    hash: submittedTx?.hash,
  });

  // A reverted disperse paid nobody, and a revert is usually followed straight
  // away by a retry — so it has to stop being flagged immediately rather than
  // waiting out the pending TTL. Subtler outcomes (cancelled, replaced, dropped)
  // are left to that expiry instead of being tracked here.
  //
  // wagmi's hook turns a reverted receipt into an error rather than resolving it
  // with `status: 'reverted'`, and that same error covers transport failures —
  // so the receipt is re-read directly to tell an actual revert from a hiccup.
  useEffect(() => {
    if (!submittedTx || !submittedFailed || !publicClient) return;
    let cancelled = false;

    (async () => {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: submittedTx.hash });
        if (cancelled || receipt.status !== 'reverted') return;
        removePendingPayouts(submittedTx.sender, submittedTx.hash);
        reloadPending(submittedTx.sender);
        // Every window tier is invalidated, not just the one on screen: the key
        // carries the checked wallets and the tier, so a sender-shaped key
        // matches nothing and the stale history would survive the revert.
        queryClient.invalidateQueries({ queryKey: ['recentPayouts'] });
      } catch {
        // Couldn't confirm the outcome — leave the record to expire on its own.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [submittedTx, submittedFailed, publicClient, queryClient, reloadPending]);

  async function handleDisperse() {
    if (!amounts || parsed.valid.length === 0) return;

    const addresses = parsed.valid.map((e) => e.address);

    // Snapshot what is actually being submitted. The user is free to edit the
    // textarea or switch tokens while the wallet prompt is open, so reading
    // state again once the hash arrives would record the wrong list.
    const submitted = parsed.valid.map((e, i) => ({
      recipient: e.address,
      token: isToken ? (validTokenAddress ?? null) : null,
      amount: amounts[i],
    }));
    const sender = userAddress;
    setSubmitError(null);
    // Covers the stretch before a hash exists: the wallet prompt is open, the
    // mutation may be reset out from under us, and `submittedTx` isn't set yet.
    setIsAwaitingHash(true);

    let hash: `0x${string}`;
    try {
      hash =
        isToken && validTokenAddress
          ? await disperse({
              address: DISPERSE_ADDRESS,
              abi: disperseAbi,
              functionName: 'disperseToken',
              args: [validTokenAddress, addresses, amounts],
            })
          : await disperse({
              address: DISPERSE_ADDRESS,
              abi: disperseAbi,
              functionName: 'disperseEther',
              args: [addresses, amounts],
              value: totalAmount,
            });
    } catch (e) {
      // Held independently of the mutation: `resetDisperse` detaches it, so
      // `disperseError` alone would silently drop this.
      setSubmitError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      setIsAwaitingHash(false);
    }

    if (!sender) return;
    setSubmittedTx({ hash, sender });
    recordPendingPayouts(sender, submitted, hash, Date.now());
    reloadPending(sender);
    // Pick up the confirmed on-chain record without waiting for staleness.
    queryClient.invalidateQueries({ queryKey: ['recentPayouts'] });
  }

  // `isSubmittedPending` follows the tx independently of the mutation, which
  // `resetDisperse` clears whenever recipients or mode change — without it,
  // editing the list mid-flight would re-enable the button for a second send.
  const isSending = isDispersing || isConfirming || isSubmittedPending || isAwaitingHash;

  const canSend =
    isConnected &&
    parsed.valid.length > 0 &&
    parsed.errors.length === 0 &&
    amounts !== null &&
    totalAmount > 0n &&
    (!isToken || (validTokenAddress && !needsApproval));

  const unitLabel = isToken ? (tokenSymbol ?? 'tokens') : 'ETH';
  const dayLabel = `${windowDays} day${windowDays === 1 ? '' : 's'}`;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Disperse</h1>
          <ConnectButton />
        </div>

        {/* Page Selector */}
        <div className="mb-4 flex gap-2">
          {([
            ['disperse', 'On-chain disperse'],
            ['wise', 'Wise CSV check'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                page === key ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {page === 'wise' && <WiseCsvCheck />}

        {page === 'disperse' && (
          <>
        {/* Token Selector */}
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          <div className="mb-4 flex gap-4">
            {(['eth', 'usdc', 'usdt', 'erc20'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  resetDisperse();
                }}
                className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                  mode === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                {m === 'eth' ? 'ETH' : m === 'usdc' ? 'USDC' : m === 'usdt' ? 'USDT' : 'ERC-20'}
              </button>
            ))}
          </div>

          {mode === 'erc20' && (
            <div>
              <input
                type="text"
                placeholder="Token contract address (0x...)"
                value={customTokenAddress}
                onChange={(e) => setCustomTokenAddress(e.target.value)}
                className="w-full rounded-md bg-gray-800 px-4 py-3 font-mono text-sm text-gray-100 placeholder-gray-500 outline-none focus:ring-2 focus:ring-blue-600"
              />
              {customTokenAddress && !validTokenAddress && (
                <p className="mt-2 text-sm text-red-400">Invalid token address</p>
              )}
            </div>
          )}

          {isToken && validTokenAddress && tokenLoading && (
            <p className="mt-3 text-sm text-gray-500">Loading token info...</p>
          )}
          {isToken && validTokenAddress && symbolFailed && !tokenSymbol && (
            <p className="mt-2 text-sm text-red-400">
              Could not load token. Is this a valid ERC-20 address?
            </p>
          )}
          {isToken && validTokenAddress && tokenSymbol && !tokenLoading && (
            <div className="mt-3 flex items-center gap-4 text-sm text-gray-400">
              <span>
                {tokenName} ({tokenSymbol})
              </span>
              <span>Decimals: {tokenDecimals?.toString()}</span>
              {tokenBalance != null && (
                <span>
                  Balance: {formatUnits(tokenBalance, decimals)} {tokenSymbol}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Recipients */}
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          <label className="mb-2 block text-sm font-medium text-gray-400">
            Recipients and amounts (one per line)
          </label>
          <textarea
            value={recipientInput}
            onChange={(e) => {
              setRecipientInput(e.target.value);
              resetDisperse();
            }}
            placeholder={`0x314ab97b76e39d63c78d5c86c2daf8eaa306b182 3.141592\n0x271bffabd0f79b8bd4d7a1c245b7ec5b576ea98a 1.618033`}
            className="h-48 w-full resize-y rounded-md bg-gray-800 p-4 font-mono text-sm text-gray-100 placeholder-gray-600 outline-none focus:ring-2 focus:ring-blue-600"
          />

          {parsed.errors.length > 0 && (
            <div className="mt-3 space-y-1">
              {parsed.errors.map((err) => (
                <p key={err.line} className="text-sm text-red-400">
                  Line {err.line}: {err.reason} — <span className="text-red-300/70 font-mono">{err.text}</span>
                </p>
              ))}
            </div>
          )}

          {/* Warning: recipients matching token contract */}
          {isToken && validTokenAddress && parsed.valid.some(
            (e) => e.address.toLowerCase() === validTokenAddress.toLowerCase()
          ) && (
            <div className="mt-3 rounded-md bg-amber-900/30 border border-amber-700/50 p-3">
              <p className="text-sm font-medium text-amber-400 mb-2">
                Warning: sending tokens to the token contract itself
              </p>
              <div className="space-y-1">
                {parsed.valid
                  .filter((e) => e.address.toLowerCase() === validTokenAddress.toLowerCase())
                  .map((e, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-amber-300/70">
                        {e.address.slice(0, 10)}...{e.address.slice(-8)} — {e.amount}
                      </span>
                    </div>
                  ))}
              </div>
              <button
                onClick={() => {
                  const lines = recipientInput.split('\n');
                  const filtered = lines.filter((line) => {
                    const parts = line.trim().split(/[,\s=]+/).filter(Boolean);
                    if (parts.length < 1) return true;
                    return parts[0].toLowerCase() !== validTokenAddress.toLowerCase();
                  });
                  setRecipientInput(filtered.join('\n'));
                }}
                className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 transition"
              >
                Remove matching lines
              </button>
            </div>
          )}

          {/* Duplicate-check settings */}
          <div className="mt-3 rounded-md border border-gray-800 bg-gray-950/40 p-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-sm text-gray-400">
                <span>Flag repeats within</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_WINDOW_DAYS}
                  value={windowDays}
                  onChange={(e) => setWindowDays(clampWindowDays(Number(e.target.value)))}
                  className="w-20 rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-600"
                />
                <span>day{windowDays === 1 ? '' : 's'}</span>
              </label>

              <label className="flex items-center gap-2 text-sm text-gray-400">
                <input
                  type="checkbox"
                  checked={amountFilterOn}
                  onChange={(e) => setAmountFilterOn(e.target.checked)}
                  className="h-4 w-4 accent-blue-600"
                />
                <span>only if within</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={toleranceInput}
                  onChange={(e) => setToleranceInput(e.target.value)}
                  disabled={!amountFilterOn}
                  className="w-24 rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-40"
                />
                <span>{unitLabel} of what I'm sending</span>
              </label>
            </div>

            {toleranceInvalid && (
              <p className="mt-2 text-xs text-amber-500/80">
                {toleranceInput.trim()
                  ? `"${toleranceInput.trim()}" isn't a valid ${unitLabel} amount`
                  : 'No threshold entered'}{' '}
                — every repeat in the window is being shown.
              </p>
            )}
          </div>

          {/* Warning: recipients already paid a similar amount recently */}
          {historyLoading && parsed.valid.length > 0 && (
            <p className="mt-3 text-sm text-gray-500">Checking payouts from the last {dayLabel}...</p>
          )}

          {historyFailed && parsed.valid.length > 0 && (
            <p className="mt-3 text-sm text-amber-500/80">
              Could not load recent payout history — duplicates were not checked.
            </p>
          )}

          {duplicates.length > 0 && (
            <div className="mt-3 rounded-md bg-amber-900/30 border border-amber-700/50 p-3">
              <p className="text-sm font-medium text-amber-400 mb-2">
                Warning: {duplicates.length} recipient{duplicates.length !== 1 && 's'} already paid in
                the last {dayLabel}
                {tolerance !== null && ` within ${toleranceInput.trim()} ${unitLabel} of this send`}{' '}
                (across all {checkedWallets.length} of your wallets)
              </p>
              <div className="space-y-2">
                {duplicates.map((d, i) => (
                  <div key={i} className="text-sm">
                    <div className="font-mono text-amber-300/70">
                      {d.entry.address.slice(0, 10)}...{d.entry.address.slice(-8)} — {d.entry.amount}
                      {d.priors.length > 1 && (
                        <span className="text-amber-400"> · paid {d.priors.length}× already</span>
                      )}
                    </div>
                    <div className="mt-0.5 space-y-0.5 pl-2">
                      {d.priors.map((p, j) => (
                        <div key={j} className="text-amber-300/50">
                          paid {formatUnits(p.amount, decimals)} {p.ago} from{' '}
                          {p.sender.slice(0, 6)}...{p.sender.slice(-4)}
                          {p.pending && ' (pending)'}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  // By line, not by address: the same recipient may legitimately
                  // appear again with an amount that wasn't flagged.
                  const flagged = new Set(duplicates.map((d) => d.entry.line));
                  const kept = recipientInput
                    .split('\n')
                    .filter((_, i) => !flagged.has(i));
                  setRecipientInput(kept.join('\n'));
                }}
                className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 transition"
              >
                Remove flagged lines
              </button>
            </div>
          )}

          {/* The amount filter is a narrowing, so what it drops has to be named. */}
          {hiddenByAmount > 0 && (
            <p className="mt-3 text-sm text-amber-500/80">
              {hiddenByAmount} {duplicates.length > 0 && 'other '}recipient
              {hiddenByAmount !== 1 && 's'}{' '}
              {hiddenByAmount === 1 ? 'was' : 'were'} paid in the last {dayLabel}, but not within{' '}
              {toleranceInput.trim()} {unitLabel} of what you're about to send — hidden by the amount
              filter.
            </p>
          )}
        </div>

        {/* Summary */}
        {parsed.valid.length > 0 && amounts && (
          <div className="mb-4 rounded-lg bg-gray-900 p-6">
            <h2 className="mb-3 text-sm font-medium text-gray-400">
              Summary ({parsed.valid.length} recipient{parsed.valid.length !== 1 && 's'})
            </h2>
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {parsed.valid.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm odd:bg-gray-800/50"
                >
                  <span className="font-mono text-gray-300">
                    {entry.address.slice(0, 8)}...{entry.address.slice(-6)}
                  </span>
                  <span className="text-gray-100">
                    {entry.amount} {unitLabel}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-gray-800 pt-3 text-right text-sm font-medium">
              Total: {formatUnits(totalAmount, decimals)} {unitLabel}
            </div>
          </div>
        )}

        {/* Unlisted-wallet guard: this wallet's own history was not compared. */}
        {unlistedSender && (
          <div className="mb-4 rounded-lg bg-red-900/40 border border-red-600/60 p-4">
            <p className="text-sm font-medium text-red-300">
              You're connected as{' '}
              <span className="font-mono">
                {userAddress!.slice(0, 8)}…{userAddress!.slice(-6)}
              </span>
              , which isn't in your checked-wallets list — its own past sends were{' '}
              <span className="font-semibold">not compared</span>, so a duplicate from this wallet
              could slip through.
            </p>
            <p className="mt-2 text-xs text-red-300/70">
              If you send from this wallet regularly, add it to{' '}
              <span className="font-mono">SENDER_WALLETS</span> in{' '}
              <span className="font-mono">src/payoutHistory.ts</span>.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {isToken && needsApproval && (
            <button
              onClick={handleApprove}
              disabled={isApproving || isApproveConfirming || !isConnected}
              className="flex-1 rounded-lg bg-amber-600 py-3 font-medium text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApproving
                ? 'Confirm in wallet...'
                : isApproveConfirming
                  ? 'Approving...'
                  : `Approve ${tokenSymbol ?? 'Token'}`}
            </button>
          )}

          <button
            onClick={handleDisperse}
            disabled={!canSend || isSending}
            className="flex-1 rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDispersing
              ? 'Confirm in wallet...'
              : isConfirming
                ? 'Sending...'
                : `Send ${isToken ? (tokenSymbol ?? 'Tokens') : 'ETH'}`}
          </button>
        </div>

        {/* Transaction Status */}
        {disperseHash && (
          <div className="mt-4 rounded-lg bg-gray-900 p-4">
            {isConfirming && (
              <p className="text-sm text-yellow-400">Transaction pending...</p>
            )}
            {isConfirmed && (
              <p className="text-sm text-green-400">Transaction confirmed!</p>
            )}
            <a
              href={`https://etherscan.io/tx/${disperseHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-sm text-blue-400 hover:underline"
            >
              View on Etherscan
            </a>
          </div>
        )}

        {(disperseError ?? submitError) && (
          <div className="mt-4 rounded-lg bg-red-900/30 p-4">
            <p className="text-sm text-red-400">
              {(() => {
                const message = disperseError?.message ?? submitError ?? '';
                return message.includes('User rejected')
                  ? 'Transaction rejected'
                  : message.slice(0, 200);
              })()}
            </p>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
