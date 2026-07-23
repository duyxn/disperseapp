/**
 * Password check for the site gate.
 *
 * The browser calls this to find out whether the password it holds is still
 * good — on first entry, and on every load so that rotating SITE_PASSWORD
 * actually locks people out.
 */
import { checkPassword, clientIp } from './_auth.js';

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

export default function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');

  // POST only: a password in a GET is the kind of thing that ends up in a
  // browser history, a proxy log, or a prefetch.
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = checkPassword(req.headers['x-site-password'], clientIp(req.headers));
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  res.status(200).json({ ok: true });
}
