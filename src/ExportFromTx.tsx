import { useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  decodeFunctionData,
  formatEther,
  formatUnits,
  isHex,
  type Hex,
  type Address,
} from 'viem';
import { disperseAbi, erc20Abi, DISPERSE_ADDRESS } from './abi';

type Row = { address: Address; amount: bigint };

type Decoded = {
  hash: Hex;
  kind: 'eth' | 'token';
  token?: Address;
  tokenSymbol?: string;
  tokenDecimals?: number;
  rows: Row[];
  total: bigint;
};

function extractTxHash(input: string): Hex | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/0x[a-fA-F0-9]{64}/);
  if (!match) return null;
  const hash = match[0] as Hex;
  return isHex(hash) && hash.length === 66 ? hash : null;
}

function toCsv(decoded: Decoded): string {
  const decimals = decoded.kind === 'eth' ? 18 : (decoded.tokenDecimals ?? 18);
  const symbol = decoded.kind === 'eth' ? 'ETH' : (decoded.tokenSymbol ?? 'TOKEN');
  const header = `address,amount,symbol`;
  const body = decoded.rows
    .map((r) => `${r.address},${formatUnits(r.amount, decimals)},${symbol}`)
    .join('\n');
  return `${header}\n${body}\n`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportFromTx() {
  const publicClient = usePublicClient();
  const [input, setInput] = useState('');
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleParse() {
    setError(null);
    setDecoded(null);

    const hash = extractTxHash(input);
    if (!hash) {
      setError('Could not find a transaction hash in the input.');
      return;
    }
    if (!publicClient) {
      setError('No RPC client available.');
      return;
    }

    setLoading(true);
    try {
      const tx = await publicClient.getTransaction({ hash });

      if (tx.to && tx.to.toLowerCase() !== DISPERSE_ADDRESS.toLowerCase()) {
        setError(
          `This transaction is not addressed to the Disperse contract (${DISPERSE_ADDRESS}). Got: ${tx.to}`,
        );
        return;
      }

      let result: { functionName: string; args: readonly unknown[] };
      try {
        result = decodeFunctionData({ abi: disperseAbi, data: tx.input });
      } catch {
        setError('Transaction input does not match a known disperse function.');
        return;
      }

      if (result.functionName === 'disperseEther') {
        const [recipients, values] = result.args as [Address[], bigint[]];
        const rows = recipients.map((address, i) => ({ address, amount: values[i] }));
        const total = rows.reduce((s, r) => s + r.amount, 0n);
        setDecoded({ hash, kind: 'eth', rows, total });
      } else if (
        result.functionName === 'disperseToken' ||
        result.functionName === 'disperseTokenSimple'
      ) {
        const [token, recipients, values] = result.args as [Address, Address[], bigint[]];
        const rows = recipients.map((address, i) => ({ address, amount: values[i] }));
        const total = rows.reduce((s, r) => s + r.amount, 0n);

        let tokenDecimals: number | undefined;
        let tokenSymbol: string | undefined;
        try {
          const [d, s] = await Promise.all([
            publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'decimals',
            }),
            publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'symbol',
            }),
          ]);
          tokenDecimals = Number(d);
          tokenSymbol = s as string;
        } catch {
          tokenDecimals = 18;
          tokenSymbol = 'TOKEN';
        }

        setDecoded({
          hash,
          kind: 'token',
          token,
          tokenDecimals,
          tokenSymbol,
          rows,
          total,
        });
      } else {
        setError(`Unsupported disperse function: ${result.functionName}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to fetch transaction: ${msg.slice(0, 200)}`);
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!decoded) return;
    const csv = toCsv(decoded);
    const short = decoded.hash.slice(0, 10);
    downloadCsv(`disperse-${short}.csv`, csv);
  }

  const decimals = decoded ? (decoded.kind === 'eth' ? 18 : (decoded.tokenDecimals ?? 18)) : 18;
  const symbol = decoded
    ? decoded.kind === 'eth'
      ? 'ETH'
      : (decoded.tokenSymbol ?? 'TOKEN')
    : '';

  return (
    <>
      <div className="mb-4 rounded-lg bg-gray-900 p-6">
        <label className="mb-2 block text-sm font-medium text-gray-400">
          Etherscan transaction URL or hash
        </label>
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="https://etherscan.io/tx/0x... or 0x..."
          className="w-full rounded-md bg-gray-800 px-4 py-3 font-mono text-sm text-gray-100 placeholder-gray-500 outline-none focus:ring-2 focus:ring-blue-600"
        />
        <button
          onClick={handleParse}
          disabled={loading || !input.trim()}
          className="mt-3 w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Decoding...' : 'Decode transaction'}
        </button>

        {error && (
          <div className="mt-3 rounded-md bg-red-900/30 p-3">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
      </div>

      {decoded && (
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-400">
              {decoded.rows.length} recipient{decoded.rows.length !== 1 && 's'} —{' '}
              {decoded.kind === 'eth' ? 'ETH disperse' : `Token disperse (${symbol})`}
            </h2>
            <button
              onClick={handleDownload}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
            >
              Download CSV
            </button>
          </div>

          {decoded.kind === 'token' && decoded.token && (
            <p className="mb-3 font-mono text-xs text-gray-500">
              Token: {decoded.token}
            </p>
          )}

          <div className="max-h-80 space-y-1 overflow-y-auto">
            {decoded.rows.map((row, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded px-2 py-1 text-sm odd:bg-gray-800/50"
              >
                <span className="font-mono text-gray-300">{row.address}</span>
                <span className="text-gray-100">
                  {formatUnits(row.amount, decimals)} {symbol}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-gray-800 pt-3 text-right text-sm font-medium">
            Total: {decoded.kind === 'eth' ? formatEther(decoded.total) : formatUnits(decoded.total, decimals)} {symbol}
          </div>
        </div>
      )}
    </>
  );
}
