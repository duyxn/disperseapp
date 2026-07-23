/**
 * Reading a Wise batch CSV and checking it against recent payouts.
 *
 * Wise batch files are keyed by recipient email, so that's what we match on —
 * any payout to the same address inside the window is a flag, regardless of
 * amount. Paying someone twice for different work is rarer than accidentally
 * re-running yesterday's batch, and the amounts usually differ when it happens.
 */

export const DEFAULT_WINDOW_DAYS = 7;

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

export type PayoutsResponse = {
  profileId: number;
  days: number;
  since: string;
  until: string;
  count: number;
  truncated: boolean;
  payouts: WisePayout[];
};

export type CsvRow = {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  name: string;
  email: string;
  reference: string;
  amount: string;
  currency: string;
  /** The original text, so a filtered file round-trips byte-for-byte. */
  raw: string;
};

export type ParsedCsv = {
  header: string;
  rows: CsvRow[];
  /** Lines we couldn't read a recipient email out of. */
  problems: { line: number; raw: string; reason: string }[];
};

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }

  out.push(field);
  return out.map((f) => f.trim());
}

function findColumn(headers: string[], ...patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const i = headers.findIndex((h) => pattern.test(h));
    if (i !== -1) return i;
  }
  return -1;
}

export function parseWiseCsv(text: string): ParsedCsv {
  // Strip a BOM and normalise CRLF so column indexes and raw lines both behave.
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

  const headerIndex = lines.findIndex((l) => l.trim());
  if (headerIndex === -1) return { header: '', rows: [], problems: [] };

  const header = lines[headerIndex];
  const headers = splitCsvLine(header).map((h) => h.toLowerCase());

  const emailAt = findColumn(headers, /^recipientemail$/, /email/);
  const nameAt = findColumn(headers, /^name$/, /holder|recipient name|full ?name/);
  const amountAt = findColumn(headers, /^amount$/, /^targetvalue$/, /amount/);
  const currencyAt = findColumn(headers, /^amountcurrency$/, /^targetcurrency$/, /currency/);
  const referenceAt = findColumn(headers, /reference/);

  const rows: CsvRow[] = [];
  const problems: ParsedCsv['problems'] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const line = i + 1;

    if (emailAt === -1) {
      problems.push({ line, raw, reason: 'No recipient email column in this file' });
      continue;
    }

    const fields = splitCsvLine(raw);
    const email = (fields[emailAt] ?? '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      problems.push({ line, raw, reason: 'Missing or invalid recipient email' });
      continue;
    }

    rows.push({
      line,
      email,
      name: nameAt === -1 ? '' : (fields[nameAt] ?? ''),
      amount: amountAt === -1 ? '' : (fields[amountAt] ?? ''),
      currency: currencyAt === -1 ? '' : (fields[currencyAt] ?? ''),
      reference: referenceAt === -1 ? '' : (fields[referenceAt] ?? ''),
      raw,
    });
  }

  return { header, rows, problems };
}

/**
 * Wise stamps some timestamps as `2026-07-20 11:44:56` with no zone marker,
 * which JS would read as local time. They are UTC.
 */
export function parseWiseDate(value: string): number {
  const normalised = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value.replace(' ', 'T')
    : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * One flagged row. The two reasons are independent and can both apply — a
 * recipient can be a repeat within this file *and* already paid last week,
 * and hiding the second behind the first is how you pay someone a third time.
 */
export type Flag = {
  row: CsvRow;
  /** Payouts already made to this recipient inside the window. */
  prior: WisePayout[];
  /** Where this recipient first appears in the file, when they repeat. */
  firstLine?: number;
};

export type CheckResult = {
  flags: Flag[];
  /** Line numbers of every flagged row, for filtering. */
  flaggedLines: Set<number>;
};

/**
 * Flags rows that were already paid inside the window, plus rows that repeat a
 * recipient within the file itself — a batch that pays the same person twice
 * is the same mistake, one upload earlier.
 *
 * Every row is checked against the payout history, including repeats: the
 * question being answered is per-recipient ("has this person been paid?"), so
 * no row may be dropped from that check for any other reason.
 */
export function checkCsv(rows: CsvRow[], payouts: WisePayout[], windowDays: number, now: number): CheckResult {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  const priorByEmail = new Map<string, WisePayout[]>();
  for (const p of payouts) {
    if (!p.email) continue;
    if (parseWiseDate(p.created) < cutoff) continue;
    const list = priorByEmail.get(p.email);
    if (list) list.push(p);
    else priorByEmail.set(p.email, [p]);
  }

  for (const list of priorByEmail.values()) {
    list.sort((a, b) => parseWiseDate(b.created) - parseWiseDate(a.created));
  }

  const flags: Flag[] = [];
  const flaggedLines = new Set<number>();
  const seenInFile = new Map<string, number>();

  for (const row of rows) {
    const firstLine = seenInFile.get(row.email);
    if (firstLine == null) seenInFile.set(row.email, row.line);

    const prior = priorByEmail.get(row.email) ?? [];
    if (prior.length === 0 && firstLine == null) continue;

    flags.push({ row, prior, firstLine });
    flaggedLines.add(row.line);
  }

  return { flags, flaggedLines };
}

/** The original file minus the flagged rows, ready to upload to Wise. */
export function buildCleanCsv(parsed: ParsedCsv, flaggedLines: Set<number>): string {
  const kept = parsed.rows.filter((r) => !flaggedLines.has(r.line)).map((r) => r.raw);
  return [parsed.header, ...kept].join('\n') + '\n';
}

export function formatAge(timestamp: number, now: number): string {
  const mins = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
