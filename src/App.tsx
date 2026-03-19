import { useState, useMemo, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from 'wagmi';
import { parseEther, parseUnits, formatUnits, isAddress } from 'viem';
import { DISPERSE_ADDRESS, disperseAbi, erc20Abi } from './abi';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

type ParsedEntry = {
  address: `0x${string}`;
  amount: string;
};

type ParseResult = {
  valid: ParsedEntry[];
  errors: { line: number; text: string; reason: string }[];
};

function parseRecipients(input: string): ParseResult {
  const lines = input.split('\n').filter((l) => l.trim());
  const valid: ParsedEntry[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
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

    valid.push({ address: addr as `0x${string}`, amount: amt });
  }

  return { valid, errors };
}

function App() {
  const { address: userAddress, isConnected } = useAccount();
  const [mode, setMode] = useState<'eth' | 'usdc' | 'erc20'>('eth');
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [recipientInput, setRecipientInput] = useState('');

  const isToken = mode !== 'eth';
  const tokenAddress = mode === 'usdc' ? USDC_ADDRESS : customTokenAddress;

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
    writeContract: disperse,
    data: disperseHash,
    error: disperseError,
    isPending: isDispersing,
    reset: resetDisperse,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: disperseHash,
  });

  function handleDisperse() {
    if (!amounts || parsed.valid.length === 0) return;

    const addresses = parsed.valid.map((e) => e.address);

    if (isToken && validTokenAddress) {
      disperse({
        address: DISPERSE_ADDRESS,
        abi: disperseAbi,
        functionName: 'disperseToken',
        args: [validTokenAddress, addresses, amounts],
      });
    } else {
      disperse({
        address: DISPERSE_ADDRESS,
        abi: disperseAbi,
        functionName: 'disperseEther',
        args: [addresses, amounts],
        value: totalAmount,
      });
    }
  }

  const canSend =
    isConnected &&
    parsed.valid.length > 0 &&
    parsed.errors.length === 0 &&
    amounts !== null &&
    totalAmount > 0n &&
    (!isToken || (validTokenAddress && !needsApproval));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Disperse</h1>
          <ConnectButton />
        </div>

        {/* Token Selector */}
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          <div className="mb-4 flex gap-4">
            {(['eth', 'usdc', 'erc20'] as const).map((m) => (
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
                {m === 'eth' ? 'ETH' : m === 'usdc' ? 'USDC' : 'ERC-20'}
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
                    {entry.amount} {isToken ? (tokenSymbol ?? 'tokens') : 'ETH'}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-gray-800 pt-3 text-right text-sm font-medium">
              Total: {formatUnits(totalAmount, decimals)} {isToken ? (tokenSymbol ?? 'tokens') : 'ETH'}
            </div>
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
            disabled={!canSend || isDispersing || isConfirming}
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

        {disperseError && (
          <div className="mt-4 rounded-lg bg-red-900/30 p-4">
            <p className="text-sm text-red-400">
              {disperseError.message.includes('User rejected')
                ? 'Transaction rejected'
                : disperseError.message.slice(0, 200)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
