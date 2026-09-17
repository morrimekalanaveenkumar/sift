/**
 * You fixed one value. How many others have the same problem?
 *
 * This is the difference between review being feasible and being a job. Extraction
 * mistakes are almost never one-offs — they come from a rule that was wrong, so the same
 * rule was wrong everywhere it applied. A person who corrects "INR 171120.70" to
 * "171120.70" has not fixed one cell; they have told you something true about every cell
 * that vendor produced. Making them say it forty-seven more times is the actual cost of
 * most document tools.
 *
 * The approach: describe *what kind of edit* the correction was, rather than what it
 * changed it to. A signature like "removed the prefix 'INR '" applies cleanly to other
 * values; "set it to 171120.70" applies to nothing.
 *
 * Deliberately conservative. Over-applying a correction silently rewrites data the user
 * never looked at, which is far worse than asking them twice — so a signature has to be
 * specific, the blast radius is always previewed before anything is written, and
 * anything that does not fit a known pattern stays a one-off.
 */

import { parseDateLoose, shapeOf, typeValue, type DateStyle } from '../infer/value';

export type CorrectionSignature =
  | { kind: 'strip_prefix'; prefix: string }
  | { kind: 'strip_suffix'; suffix: string }
  | { kind: 'strip_both'; prefix: string; suffix: string }
  | { kind: 'date_convention'; from: DateStyle; to: DateStyle }
  | { kind: 'manual' };

export const describeSignature = (s: CorrectionSignature): string => {
  switch (s.kind) {
    case 'strip_prefix': return `remove the leading ${JSON.stringify(s.prefix)}`;
    case 'strip_suffix': return `remove the trailing ${JSON.stringify(s.suffix)}`;
    case 'strip_both': return `remove ${JSON.stringify(s.prefix)} and ${JSON.stringify(s.suffix)}`;
    case 'date_convention': return `read these dates as ${s.to === 'mdy' ? 'month first' : 'day first'}`;
    case 'manual': return 'a one-off correction';
  }
};

/** Stable key for grouping corrections in the database. */
export const signatureKey = (s: CorrectionSignature): string =>
  s.kind === 'strip_prefix' ? `strip_prefix:${s.prefix}`
  : s.kind === 'strip_suffix' ? `strip_suffix:${s.suffix}`
  : s.kind === 'strip_both' ? `strip_both:${s.prefix}|${s.suffix}`
  : s.kind === 'date_convention' ? `date:${s.from}->${s.to}`
  : 'manual';

/**
 * What kind of edit turned `before` into `after`?
 *
 * Order matters: the most specific interpretation wins, because a vague signature
 * matches too much. "04/05/2026" → "2026-05-04" is a date convention, not a substring
 * edit, even though it could be described as one.
 */
export function classifyCorrection(before: string, after: string): CorrectionSignature {
  const b = before.trim();
  const a = after.trim();
  if (!b || !a || b === a) return { kind: 'manual' };

  // A date that stayed the same date but changed convention. Worth catching first: it is
  // the single most common systematic mistake, and the one a person is least able to
  // spot by eye across a whole column.
  const beforeDate = parseDateLoose(b, 'dmy');
  const afterIsIso = /^\d{4}-\d{2}-\d{2}$/.test(a);
  if (beforeDate && afterIsIso) {
    const asDmy = parseDateLoose(b, 'dmy');
    const asMdy = parseDateLoose(b, 'mdy');
    if (asMdy?.iso === a && asDmy?.iso !== a) return { kind: 'date_convention', from: 'dmy', to: 'mdy' };
    if (asDmy?.iso === a && asMdy?.iso !== a) return { kind: 'date_convention', from: 'mdy', to: 'dmy' };
  }

  // The correction removed text from one or both ends and changed nothing in the middle.
  if (b.includes(a)) {
    const start = b.indexOf(a);
    const prefix = b.slice(0, start);
    const suffix = b.slice(start + a.length);
    // A single stripped character is too weak to generalise from — it would match half
    // the corpus.
    if (prefix.length >= 2 && suffix.length >= 2) return { kind: 'strip_both', prefix, suffix };
    if (prefix.length >= 2 && suffix.length === 0) return { kind: 'strip_prefix', prefix };
    if (suffix.length >= 2 && prefix.length === 0) return { kind: 'strip_suffix', suffix };
  }

  return { kind: 'manual' };
}

/** Apply a signature to a value, or decline. */
export function applySignature(signature: CorrectionSignature, raw: string): string | null {
  const value = raw.trim();

  switch (signature.kind) {
    case 'strip_prefix':
      return value.startsWith(signature.prefix) ? value.slice(signature.prefix.length).trim() : null;
    case 'strip_suffix':
      return value.endsWith(signature.suffix) ? value.slice(0, -signature.suffix.length).trim() : null;
    case 'strip_both': {
      if (!value.startsWith(signature.prefix) || !value.endsWith(signature.suffix)) return null;
      return value.slice(signature.prefix.length, value.length - signature.suffix.length).trim();
    }
    case 'date_convention': {
      // Only rewrite dates that were genuinely ambiguous. A date whose day is over twelve
      // was never in doubt — "05/13/2026" proves its own order — and "re-read this column
      // as month-first" must not touch the values that already settled the question. Ask
      // the *unresolved* parse whether it was ambiguous, because parsing with a style
      // supplied always answers no.
      const asFound = parseDateLoose(value, 'unknown');
      if (!asFound?.ambiguous) return null;
      return parseDateLoose(value, signature.to)?.iso ?? null;
    }
    case 'manual':
      return null;
  }
}

export type Candidate = {
  cellId: string;
  document: string;
  before: string;
  after: string;
};

/**
 * Which other cells would this correction change, and to what?
 *
 * Returns previews rather than performing anything. The user sees the exact list before a
 * single row is written — because "we also changed 47 things you did not look at" is only
 * acceptable when they were shown the 47 first.
 */
export function previewGeneralisation(
  signature: CorrectionSignature,
  cells: { id: string; document: string; raw: string | null }[],
  excludeCellId?: string,
): Candidate[] {
  if (signature.kind === 'manual') return [];

  const out: Candidate[] = [];
  for (const cell of cells) {
    if (cell.id === excludeCellId || !cell.raw) continue;
    const after = applySignature(signature, cell.raw);
    if (after === null || after === cell.raw.trim()) continue;

    // A rule learned from one good edit can still be wrong on a cell nobody looked at,
    // and it goes wrong in two ways: it empties the value, or it strips off the part
    // that made the value typeable at all. Both are silent data loss, so neither is
    // offered. Note that this is deliberately not a confidence comparison — removing
    // "INR " from an amount *does* lower confidence, because the currency marker is
    // gone, and that correction is the whole reason this feature exists.
    if (!after) continue;
    if (typeValue(cell.raw).type !== 'text' && typeValue(after).type === 'text') continue;

    out.push({ cellId: cell.id, document: cell.document, before: cell.raw, after });
  }
  return out;
}

export { shapeOf };
