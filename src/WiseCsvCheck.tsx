import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_WINDOW_DAYS,
  buildCleanCsv,
  checkCsv,
  formatAge,
  parseWiseCsv,
  parseWiseDate,
  type ParsedCsv,
  type PayoutsResponse,
} from './wiseCheck';
import { getPassword } from './siteAuth';

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

async function fetchPayouts(days: number): Promise<PayoutsResponse> {
  const res = await fetch(`/api/wise-payouts?days=${days}`, {
    headers: { 'x-site-password': getPassword() },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed: ${res.status}`);
  return body as PayoutsResponse;
}

export function WiseCsvCheck() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);

  const {
    data: history,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['wisePayouts', days],
    enabled: !!parsed,
    staleTime: 60_000,
    retry: false,
    queryFn: () => fetchPayouts(days),
  });

  const now = Date.now();

  const result = useMemo(() => {
    if (!parsed || !history) return null;
    return checkCsv(parsed.rows, history.payouts, days, now);
    // `now` is deliberately excluded: it changes every render and the window is
    // days wide, so re-running on it would only churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, history, days]);

  async function handleFile(file: File) {
    const text = await file.text();
    setFilename(file.name);
    setParsed(parseWiseCsv(text));
  }

  function handleDownloadClean() {
    if (!parsed || !result) return;
    const base = filename.replace(/\.csv$/i, '') || 'wise-batch';
    downloadCsv(`${base}-deduped.csv`, buildCleanCsv(parsed, result.flaggedLines));
  }

  const flags = result?.flags ?? [];
  const cleanCount = parsed ? parsed.rows.length - (result?.flaggedLines.size ?? 0) : 0;

  return (
    <>
      <div className="mb-4 rounded-lg bg-gray-900 p-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1">
            <label className="mb-2 block text-sm font-medium text-gray-400">Wise batch CSV</label>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
              className="w-full rounded-md bg-gray-800 px-4 py-2.5 text-sm text-gray-300 file:mr-4 file:rounded file:border-0 file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:text-gray-200 hover:file:bg-gray-600"
            />
          </div>

          <div className="w-40">
            <label className="mb-2 block text-sm font-medium text-gray-400">Look back (days)</label>
            <input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
              className="w-full rounded-md bg-gray-800 px-4 py-3 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
        </div>

        {parsed && (
          <p className="mt-3 text-sm text-gray-400">
            {filename} — {parsed.rows.length} recipient{parsed.rows.length !== 1 && 's'}
            {parsed.problems.length > 0 && (
              <span className="text-amber-400"> · {parsed.problems.length} unreadable line(s)</span>
            )}
          </p>
        )}

        {isFetching && <p className="mt-3 text-sm text-gray-500">Loading Wise payout history...</p>}

        {error && (
          <div className="mt-3 rounded-md bg-red-900/30 p-3">
            <p className="text-sm text-red-400">{(error as Error).message}</p>
            <button
              onClick={() => void refetch()}
              className="mt-2 rounded-md bg-red-800/60 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-800"
            >
              Retry
            </button>
          </div>
        )}

        {history?.truncated && (
          <p className="mt-3 text-sm text-amber-500/80">
            The window held more transfers than this check pages through — some prior payouts were
            not compared.
          </p>
        )}
      </div>

      {parsed && parsed.problems.length > 0 && (
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          <h2 className="mb-2 text-sm font-medium text-amber-400">
            {parsed.problems.length} line{parsed.problems.length !== 1 && 's'} skipped
          </h2>
          <div className="space-y-1">
            {parsed.problems.slice(0, 20).map((p) => (
              <p key={p.line} className="text-sm text-amber-300/70">
                Line {p.line}: {p.reason} —{' '}
                <span className="font-mono text-amber-300/50">{p.raw.slice(0, 80)}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="mb-4 rounded-lg bg-gray-900 p-6">
          {flags.length === 0 ? (
            <p className="text-sm text-green-400">
              No recipient in this batch was paid in the last {days} day{days !== 1 && 's'}. Checked
              against {history?.count ?? 0} Wise transfer{history?.count === 1 ? '' : 's'}.
            </p>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-4">
                <h2 className="text-sm font-medium text-amber-400">
                  {flags.length} of {parsed?.rows.length} recipient
                  {flags.length !== 1 && 's'} flagged
                </h2>
                <button
                  onClick={handleDownloadClean}
                  disabled={cleanCount === 0}
                  className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Download CSV without them ({cleanCount})
                </button>
              </div>

              <div className="max-h-96 space-y-2 overflow-y-auto">
                {flags.map((flag) => (
                  <div
                    key={`${flag.kind}-${flag.row.line}`}
                    className="rounded-md border border-amber-700/50 bg-amber-900/20 p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm text-amber-200">
                        {flag.row.name || flag.row.email}{' '}
                        <span className="text-amber-300/50">
                          {flag.row.amount} {flag.row.currency}
                        </span>
                      </span>
                      <span className="font-mono text-xs text-amber-300/50">
                        line {flag.row.line}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-amber-300/60">{flag.row.email}</p>

                    {flag.kind === 'repeat-in-file' ? (
                      <p className="mt-1 text-xs text-amber-400/80">
                        Already appears on line {flag.firstLine} of this same file.
                      </p>
                    ) : (
                      <div className="mt-1 space-y-0.5">
                        {flag.prior.slice(0, 4).map((p) => (
                          <p key={p.transferId} className="text-xs text-amber-400/80">
                            Paid {p.amount} {p.currency} {formatAge(parseWiseDate(p.created), now)} —{' '}
                            {p.status.replace(/_/g, ' ')}
                            {p.reference ? ` · ${p.reference}` : ''}
                          </p>
                        ))}
                        {flag.prior.length > 4 && (
                          <p className="text-xs text-amber-400/60">
                            +{flag.prior.length - 4} more payout(s)
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
