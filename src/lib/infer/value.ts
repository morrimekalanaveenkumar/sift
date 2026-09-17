/**
 * What kind of thing is this string, and what does it actually mean?
 *
 * Two jobs that look like one. **Typing** decides that "04/05/2026" is a date; **parsing**
 * decides whether it is the 4th of May or the 5th of April. The second is not always
 * answerable from the value alone, which is why the interesting function in this file
 * takes a whole column rather than a single cell — see `resolveDateStyle`.
 */

export type ValueType =
  | 'date'
  | 'money'
  | 'number'
  | 'integer'
  | 'identifier'
  | 'email'
  | 'phone'
  | 'boolean'
  | 'text';

export type TypedValue = {
  type: ValueType;
  raw: string;
  /** Canonical form: ISO for dates, a number for money and numerics, trimmed text otherwise. */
  value: string | number | boolean | null;
  currency?: string;
  /** 0–1. How sure we are about the *type*, before any corpus-level evidence. */
  confidence: number;
};

/**
 * A structural fingerprint: letters become A, digits become 9, punctuation stays.
 *
 * This is what lets reconciliation notice that two differently-named fields hold the
 * same kind of thing. "INV-2026-01042" and "KES-2026-01006" are different strings and
 * the same shape, and shape agreement is far stronger evidence that two labels mean the
 * same field than their names being similar.
 */
export function shapeOf(raw: string): string {
  return raw
    .trim()
    .replace(/[A-Za-z]/g, 'A')
    .replace(/[0-9]/g, '9')
    // Collapse runs so "999999" and "9999" compare equal in coarse form but keep the
    // punctuation skeleton that carries the real structure.
    .replace(/A{2,}/g, 'A+')
    .replace(/9{2,}/g, '9+');
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY',
};
const CURRENCY_WORDS = /\b(INR|USD|GBP|EUR|AUD|SGD|AED|CAD|JPY|Rs\.?)\b/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Type a single value, with no knowledge of its neighbours. */
export function typeValue(raw: string): TypedValue {
  const s = raw.trim();
  if (!s) return { type: 'text', raw, value: null, confidence: 0 };

  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) {
    return { type: 'email', raw, value: s.toLowerCase(), confidence: 0.98 };
  }
  if (/^(yes|no|true|false|y|n)$/i.test(s)) {
    return { type: 'boolean', raw, value: /^(yes|true|y)$/i.test(s), confidence: 0.9 };
  }

  // Dates are tested before phone numbers, and the order is not arbitrary: "2026-02-18"
  // is eight digits separated by punctuation, which is also exactly what a phone number
  // looks like to a regex. The more specific pattern has to win, or every ISO date in
  // the corpus silently becomes a phone number.
  const date = parseDateLoose(s);
  if (date) return { type: 'date', raw, value: date.iso, confidence: date.confidence };

  if (
    /^\+?[\d(][\d\s().-]{8,}$/.test(s) &&
    (s.match(/\d/g)?.length ?? 0) >= 9 &&
    // A run of digits broken only by single separators into date-sized groups is a date
    // that failed to parse, not a phone number.
    !/^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s)
  ) {
    return { type: 'phone', raw, value: s.replace(/[^\d+]/g, ''), confidence: 0.85 };
  }

  const money = parseMoney(s);
  if (money) {
    return { type: 'money', raw, value: money.amount, currency: money.currency, confidence: money.confidence };
  }

  // A bare number. Distinguish integers from decimals because the difference decides the
  // column type, and a quantity stored as numeric(12,2) is a smell.
  const bare = s.replace(/,/g, '');
  if (/^-?\d+$/.test(bare)) {
    return { type: 'integer', raw, value: Number(bare), confidence: 0.9 };
  }
  if (/^-?\d*\.\d+$/.test(bare)) {
    return { type: 'number', raw, value: Number(bare), confidence: 0.9 };
  }

  // Identifier: mixed letters and digits, or digit groups joined by separators, and short
  // enough not to be a sentence. This is what invoice numbers, account numbers and
  // reference codes all look like.
  if (
    s.length <= 40 &&
    !/\s{2,}/.test(s) &&
    /\d/.test(s) &&
    /^[A-Za-z0-9][A-Za-z0-9\/*_. #-]*$/.test(s) &&
    s.split(/\s+/).length <= 3
  ) {
    return { type: 'identifier', raw, value: s, confidence: 0.75 };
  }

  return { type: 'text', raw, value: s, confidence: 0.6 };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export function parseMoney(s: string): { amount: number; currency?: string; confidence: number } | null {
  const t = s.trim();

  // Accounting negatives: (1,234.56) means −1234.56. Stripping punctuation before
  // parsing — which is the obvious thing to do — turns every debit into a credit, and
  // the result balances to exactly the wrong number.
  const negated = /^\(.*\)$/.test(t);
  const inner = negated ? t.slice(1, -1).trim() : t;

  let currency: string | undefined;
  let rest = inner;

  const symbol = Object.keys(CURRENCY_SYMBOLS).find((c) => rest.startsWith(c) || rest.endsWith(c));
  if (symbol) {
    currency = CURRENCY_SYMBOLS[symbol];
    rest = rest.split(symbol).join('').trim();
  } else {
    const word = rest.match(CURRENCY_WORDS);
    if (word) {
      const code = word[1]!.toUpperCase().replace(/\.$/, '');
      currency = code === 'RS' ? 'INR' : code;
      rest = rest.replace(CURRENCY_WORDS, '').trim();
    }
  }

  const cleaned = rest.replace(/,/g, '').replace(/^\+/, '');
  if (!/^-?\d+(\.\d{1,4})?$/.test(cleaned)) return null;

  const amount = Number(cleaned) * (negated ? -1 : 1);
  if (!Number.isFinite(amount)) return null;

  // A bare number is only money if something says so — a symbol, a currency word, or the
  // two-decimal convention. Otherwise quantities and page numbers all become money.
  const hasSignal = !!currency || negated || /\.\d{2}$/.test(cleaned);
  if (!hasSignal) return null;

  return { amount, currency, confidence: currency ? 0.95 : 0.7 };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DateStyle = 'iso' | 'dmy' | 'mdy' | 'named' | 'unknown';

type LooseDate = { iso: string; confidence: number; style: DateStyle; ambiguous: boolean };

/**
 * Parse a date, admitting when it is ambiguous rather than guessing silently.
 *
 * `04/05/2026` is the 4th of May in most of the world and the 5th of April in the United
 * States, and nothing in the string resolves it. Guessing gets it right about half the
 * time and never tells you which half — so this marks the value ambiguous and lets
 * `resolveDateStyle` settle it from the whole column, where the evidence actually is.
 */
export function parseDateLoose(s: string, style: DateStyle = 'unknown'): LooseDate | null {
  const t = s.trim();

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return { iso: `${iso[1]}-${iso[2]}-${iso[3]}`, confidence: 0.98, style: 'iso', ambiguous: false };
  }

  // "09 Feb 2026" / "Feb 09, 2026" — unambiguous because the month is named.
  const named =
    t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/) ??
    t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const monthFirst = Number.isNaN(Number(named[1]));
    const month = MONTHS[(monthFirst ? named[1]! : named[2]!).toLowerCase().slice(0, 4).replace(/[^a-z]/g, '').slice(0, 4)]
      ?? MONTHS[(monthFirst ? named[1]! : named[2]!).toLowerCase().slice(0, 3)];
    const day = Number(monthFirst ? named[2] : named[1]);
    const year = Number(named[3]);
    if (month && day >= 1 && day <= 31) {
      return { iso: isoOf(year, month, day), confidence: 0.96, style: 'named', ambiguous: false };
    }
    return null;
  }

  const slash = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = Number(slash[3]);

    // One of the two positions being over 12 settles it outright.
    if (a > 12 && b <= 12) return { iso: isoOf(year, b, a), confidence: 0.95, style: 'dmy', ambiguous: false };
    if (b > 12 && a <= 12) return { iso: isoOf(year, a, b), confidence: 0.95, style: 'mdy', ambiguous: false };
    if (a > 12 && b > 12) return null;

    // Genuinely ambiguous. Use the caller's style if it has one, and say so either way.
    const resolved = style === 'mdy' ? { m: a, d: b } : { m: b, d: a };
    return {
      iso: isoOf(year, resolved.m, resolved.d),
      confidence: style === 'unknown' ? 0.45 : 0.85,
      style: style === 'unknown' ? 'unknown' : style,
      ambiguous: style === 'unknown',
    };
  }

  return null;
}

const isoOf = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Decide a column's date convention from all of its values at once.
 *
 * Any single value with a first component over 12 proves the column is day-first; any
 * with a second component over 12 proves it is month-first. One unambiguous row settles
 * every ambiguous row in the same column, which is why this is worth doing at the column
 * level instead of guessing per cell.
 *
 * With no evidence either way it returns 'unknown', and the caller should say so rather
 * than pick. Half the dates in a financial system being silently wrong is a worse outcome
 * than a field flagged for review.
 */
export function resolveDateStyle(values: string[]): { style: DateStyle; evidence: number } {
  let dmy = 0;
  let mdy = 0;

  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }

  if (dmy > 0 && mdy === 0) return { style: 'dmy', evidence: dmy };
  if (mdy > 0 && dmy === 0) return { style: 'mdy', evidence: mdy };
  // Both kinds of proof in one column means the column mixes conventions — which happens
  // when documents from different vendors are merged, and is worth surfacing rather than
  // averaging away.
  if (dmy > 0 && mdy > 0) return { style: 'unknown', evidence: 0 };
  return { style: 'unknown', evidence: 0 };
}

/** Re-type a whole column once its date convention is known. */
export function typeColumn(values: string[]): { type: ValueType; style: DateStyle; typed: TypedValue[] } {
  const first = values.map((v) => typeValue(v));
  const counts = new Map<ValueType, number>();
  for (const t of first) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);

  let type: ValueType = 'text';
  let best = 0;
  for (const [t, n] of counts) if (n > best) { best = n; type = t; }

  if (type !== 'date') return { type, style: 'unknown', typed: first };

  const { style } = resolveDateStyle(values);
  const typed = values.map((v) => {
    const d = parseDateLoose(v, style);
    return d
      ? { type: 'date' as const, raw: v, value: d.iso, confidence: d.confidence }
      : typeValue(v);
  });
  return { type: 'date', style, typed };
}
