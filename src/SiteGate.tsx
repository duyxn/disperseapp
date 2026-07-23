import { useEffect, useState, type ReactNode } from 'react';
import { clearPassword, getPassword, setPassword, verifyPassword } from './siteAuth';

type Status = 'checking' | 'locked' | 'unlocked';

/**
 * Password screen in front of the whole app.
 *
 * Deliberately thin: it keeps casual visitors out and holds the password the
 * API calls need. It is not what protects the payout data — the server checks
 * the same password on every request, so bypassing this screen gets you an
 * empty shell.
 */
export function SiteGate({ children }: { children: ReactNode }) {
  // With nothing stored there is nothing to verify, so start locked rather than
  // flashing a "Checking..." screen on the way there.
  const [status, setStatus] = useState<Status>(() => (getPassword() ? 'checking' : 'locked'));
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-check the stored password on every load, so rotating SITE_PASSWORD
  // actually locks out browsers that already had the old one.
  useEffect(() => {
    const stored = getPassword();
    if (!stored) return;

    let cancelled = false;
    void verifyPassword(stored).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setStatus('unlocked');
      } else {
        clearPassword();
        setStatus('locked');
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input) return;

    setSubmitting(true);
    setError(null);

    const result = await verifyPassword(input);
    setSubmitting(false);

    if (result.ok) {
      setPassword(input);
      setInput('');
      setStatus('unlocked');
    } else {
      setError(result.error);
    }
  }

  if (status === 'unlocked') return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4 text-gray-100">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-bold tracking-tight">Disperse</h1>

        {status === 'checking' ? (
          <p className="text-center text-sm text-gray-500">Checking...</p>
        ) : (
          <form onSubmit={handleSubmit} className="rounded-lg bg-gray-900 p-6">
            <label htmlFor="site-password" className="mb-2 block text-sm font-medium text-gray-400">
              Password
            </label>
            <input
              id="site-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              className="w-full rounded-md bg-gray-800 px-4 py-3 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-600"
            />

            <button
              type="submit"
              disabled={submitting || !input}
              className="mt-3 w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Checking...' : 'Unlock'}
            </button>

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
