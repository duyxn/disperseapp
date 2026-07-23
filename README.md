# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Wise batch duplicate check

The **Wise CSV check** tab takes a Wise batch-payment CSV and flags any recipient
who was already paid in the last N days (default 7), so a re-run doesn't pay the
same people twice. Matching is by recipient email, any amount. It also flags a
recipient appearing twice inside the same file, and offers the CSV back with the
flagged rows stripped out.

History comes from the Wise API via `/api/wise-payouts`, a Vercel serverless
function — the browser can't call Wise directly (no CORS, and the token is a
secret). It lists transfers on the profile for the window, drops cancelled and
refunded ones, and resolves each transfer's recipient account to an email.
Transfers created by a Wise batch upload are ordinary transfers, so they show up
here the same as API-created ones.

Set these in Vercel (Project → Settings → Environment Variables). They must NOT
be prefixed with `VITE_`, which would ship them to the browser:

| Variable | Required | Notes |
| --- | --- | --- |
| `SITE_PASSWORD` | yes | Password for the whole site (see below) |
| `WISE_API_TOKEN` | yes | Wise API token with read access to the paying profile |
| `WISE_PROFILE_ID` | no | Defaults to the business profile on the token |
| `WISE_API_URL` | no | Set to `https://api.sandbox.transferwise.tech` to test against sandbox |

## Site password

The whole app sits behind a single shared password, `SITE_PASSWORD`. The React
screen in front of it is only the front door — `api/_auth.ts` checks the same
password on `/api/wise-payouts`, so skipping the screen in devtools gets you an
empty shell and a 401, not the payout data.

The browser keeps the password in `localStorage` and re-checks it against
`/api/login` on every load, so rotating `SITE_PASSWORD` locks out browsers that
still hold the old one.

Wrong guesses are throttled per IP (20 per 10 minutes) before the password is
compared, and a throttled response says how long the wait is. That counter lives
in one warm serverless instance, so it resets on a cold start and a patient
attacker spread across IPs will get past it — it raises the cost of a naive
attack rather than preventing one. For a real limit, add a rate-limit rule on
`/api/*` in the Vercel firewall.

Note the limit is per IP, not per person, so everyone behind one office
connection shares a bucket. Redeploying clears it immediately if you ever get
stuck behind it.

Note what this does and doesn't cover:

- It's one shared password, not per-user accounts.
- The Wise API token stays server-side. It's only ever sent to an allowlisted
  Wise origin, and upstream error bodies are logged rather than returned to the
  browser, so an upstream error can't reflect it back out.
- The password is held in `localStorage` and sent on each request, so any XSS —
  first-party or from a dependency — can lift it and reuse it from elsewhere. A
  short-lived `HttpOnly` session cookie would be the fix if that matters.
- If the password does leak, the exposure is everything `/api/wise-payouts`
  returns: recipient names, emails, amounts, currencies, references, statuses,
  transfer IDs, timestamps, and the Wise profile ID. The proxy only issues GETs
  to Wise, so there's no path from it to moving money — provided the token
  itself is read-only, which is worth confirming when you issue it.
