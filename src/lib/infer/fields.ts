/**
 * Finding the fields on a page, without being told what they are.
 *
 * A field is a label and the value it points at. The whole difficulty is that "label
 * pointing at a value" and "table header sitting above a column" are the same geometry,
 * and confusing them is catastrophic in both directions: treat a table header as a field
 * and every invoice gains a `Description` field whose value is the first line item;
 * treat a field label as a table header and the real fields vanish.
 *
 * So tables are found first and removed from consideration. What distinguishes them is
 * not appearance but *repetition* — a table is several consecutive lines that share a
 * column structure. One line that happens to have three segments is a header with
 * fields; five consecutive lines that all have four segments at the same x positions are
 * a table, whatever they look like.
 */

import { centerY, right, unionAll, type Box, type Line, type Page, type Segment } from '../parse/types';
import { typeValue, type ValueType } from './value';

export type FieldCandidate = {
  label: string;
  labelBox: Box;
  value: string;
  valueBox: Box;
  page: number;
  /** Where the value sat relative to its label. Recorded because it is evidence later. */
  relation: 'right' | 'below';
  type: ValueType;
  confidence: number;
};

export type TableRegion = {
  page: number;
  header: string[] | null;
  rows: Segment[][];
  box: Box;
  columnCount: number;
};

/**
 * What the rest of the pile tells us about this document.
 *
 * Some questions cannot be answered from one document. "Is 'Corrugated boxes' a label or
 * a value?" has no local answer — it is short text sitting next to an amount, which is
 * exactly what a label looks like. Across forty documents the answer is obvious: labels
 * recur and values do not. `Subtotal` appears on thirty-one invoices; `Corrugated boxes`
 * appears on two receipts and is different on the others.
 *
 * So analysis runs twice. The first pass has no context and over-reports; its output is
 * used to work out which strings recur; the second pass uses that to tell labels from
 * values. Two passes over a pile we already hold in memory, in exchange for the one
 * distinction the whole product depends on.
 */
export type CorpusContext = {
  /** Strings seen acting as a label on at least a few different documents. */
  recurringLabels: Set<string>;
};

export type DocumentFields = {
  fields: FieldCandidate[];
  tables: TableRegion[];
  /** Lines that are neither: prose, addresses, footers. Kept so nothing is silently lost. */
  narrative: string[];
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Do two lines have segments starting at roughly the same x positions? */
function columnsAgree(a: Line, b: Line, tolerance = 6): boolean {
  if (a.segments.length !== b.segments.length || a.segments.length < 2) return false;
  return a.segments.every((seg, i) => Math.abs(seg.box.x - b.segments[i]!.box.x) <= tolerance);
}

/**
 * A table is a run of consecutive lines sharing a column structure.
 *
 * Right-aligned numeric columns break a naive "same starting x" test, because the start
 * of "1347.15" and "640.04" differ by a character width. So alignment is checked on
 * either edge: a column is consistent if its segments share a left edge *or* a right one.
 */
function alignedEitherEdge(a: Line, b: Line, tolerance = 6): boolean {
  if (a.segments.length !== b.segments.length || a.segments.length < 2) return false;
  return a.segments.every((seg, i) => {
    const other = b.segments[i]!;
    return (
      Math.abs(seg.box.x - other.box.x) <= tolerance ||
      Math.abs(right(seg.box) - right(other.box)) <= tolerance
    );
  });
}

export function detectTables(page: Page, minRows = 3, corpus?: CorpusContext): TableRegion[] {
  const lines = page.lines;
  const tables: TableRegion[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = lines[i]!;
    if (start.segments.length < 2) { i++; continue; }

    let end = i;
    while (end + 1 < lines.length && alignedEitherEdge(start, lines[end + 1]!)) end++;
    if (end - i + 1 < minRows) { i++; continue; }

    let body = lines.slice(i, end + 1);
    let header: string[] | null = null;

    // The header aligns with the body, so it lands *inside* the detected run rather than
    // above it. Split it off when the first line is all words and the rest carry values.
    const first = body[0]!;
    const rest = body.slice(1);
    const firstIsWords = first.segments.every((sg) => typeValue(sg.text).type === 'text');
    const restHasValues = rest.some((l) => l.segments.some((sg) => typeValue(sg.text).type !== 'text'));
    if (firstIsWords && restHasValues && rest.length >= minRows - 1) {
      header = first.segments.map((sg) => sg.text);
      body = rest;
    }

    // Is this actually a table, or a stack of fields that happens to line up?
    //
    // A totals block — Subtotal / Tax / Grand Total, each with an amount beside it — is
    // three consecutive lines of two aligned columns, which is indistinguishable from a
    // small table by geometry alone. It is not a table: those are three separate fields,
    // and swallowing them loses the three numbers anyone actually cares about.
    //
    // What separates them is that a real table announces itself: it has a header, or it
    // has more than two columns, or it goes on long enough that no one would call it a
    // list of fields.
    const columnCount = body[0]!.segments.length;
    let isTable = header !== null || columnCount >= 3 || body.length >= 5;

    // The two-column case that geometry cannot settle. A totals block and a receipt's
    // list of items are both "three lines of a word and an amount"; one is three fields
    // and the other is a table of line items, and nothing on the page distinguishes them.
    //
    // The pile does. `Subtotal` and `VAT` recur across every invoice; `Corrugated boxes`
    // does not recur at all. A left column made of strings that recur is a set of labels;
    // one made of strings that do not is data.
    if (!isTable && columnCount === 2 && corpus) {
      const firstColumn = body.map((l) => l.segments[0]!.text);
      const recurring = firstColumn.filter((t) => corpus.recurringLabels.has(t)).length;
      if (recurring / firstColumn.length < 0.6) isTable = true;
    }

    if (!isTable) { i++; continue; }

    // A table's last row is often not part of the table. "TOTAL | 820.51" sits in the
    // same two columns as the items above it and aligns perfectly, so the run swallows
    // it — and the one number anyone actually wants off a receipt disappears into a list
    // of line items. It gives itself away by being a recurring label where the rows above
    // are one-off descriptions.
    while (
      corpus &&
      body.length > minRows &&
      corpus.recurringLabels.has(body[body.length - 1]!.segments[0]!.text)
    ) {
      body = body.slice(0, -1);
      end--;
    }

    const top = header ? first.box.y : body[0]!.box.y;
    const last = body[body.length - 1]!;
    tables.push({
      page: page.index,
      header,
      rows: body.map((l) => l.segments),
      columnCount,
      box: {
        x: Math.min(...body.map((l) => l.box.x)),
        y: top,
        w: Math.max(...body.map((l) => right(l.box))) - Math.min(...body.map((l) => l.box.x)),
        h: last.box.y + last.box.h - top,
      },
    });

    i = end + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const LABEL_MAX_WORDS = 5;

/**
 * Could this segment be a label?
 *
 * Labels are short, and they are not themselves values — "Invoice No." is a label,
 * "INV-2026-01042" is not. The trailing-colon case is allowed to override length because
 * "Amount payable including all applicable taxes:" is unmistakably a label however long
 * it is.
 */
export function looksLikeLabel(text: string, context?: { size: number; medianSize: number }): boolean {
  const t = text.trim();
  if (!t) return false;

  // A heading is not a label. The company name at the top of a receipt is short text
  // sitting directly above another value, which is structurally indistinguishable from a
  // label — until you notice it is set in 15pt on a page whose body is 8pt. Typography
  // separates them, and it does so without knowing a single company name.
  if (context && context.size > context.medianSize * 1.3) return false;

  if (/[:：]$/.test(t)) return true;

  const words = t.split(/\s+/);
  if (words.length > LABEL_MAX_WORDS) return false;

  const typed = typeValue(t);
  // A segment that parses as a date, an amount or an id is a value, whatever it is next to.
  if (typed.type !== 'text') return false;
  // Pure punctuation or a stray glyph is neither.
  return /[A-Za-z]/.test(t);
}

const normaliseLabel = (s: string) => s.trim().replace(/[:：#]+$/, '').trim();

const sizeOf = (seg: Segment) => Math.max(...seg.words.map((w) => w.size), 0);

/**
 * Is `value` plausibly the value belonging to `label`, rather than another label?
 *
 * `looksLikeLabel` cannot answer this on its own, because it only knows that a segment
 * is short text — and "Sold To" and "Orenda Systems" are both short text. Asked in
 * isolation, every customer name in the corpus is a label, and the customer field
 * disappears from every document.
 *
 * Three things distinguish a value, any one of which is enough:
 *
 *   - It parses as something: a date, an amount, an identifier. Labels do not.
 *   - It is longer than a label would be.
 *   - It is *rendered larger than its own label*. This one does most of the work and is
 *     not a trick: documents are typeset by people, and people set labels smaller and
 *     quieter than the values they point at, because that is what makes a form readable.
 *     The typography is evidence, and it survives translation, abbreviation and layout
 *     changes in a way that word lists do not.
 */
function isValueFor(label: Segment, value: Segment): boolean {
  if (typeValue(value.text).type !== 'text') return true;
  if (value.words.length > 3) return true;
  return sizeOf(value) > sizeOf(label) * 1.04;
}

/**
 * Pull label/value pairs off a page.
 *
 * Two arrangements are recognised, because both are common and neither subsumes the
 * other: the value sits to the right of the label on the same line, or directly beneath
 * it. "Take whatever is to the right" is the usual shortcut and it fails completely on
 * the label-above layout, which is not rare.
 */
/**
 * Split a segment that contains both a label and its value.
 *
 * "Receipt R0400217" is one segment because the gap between the two words is an ordinary
 * space — there is no geometric break to find. But the second half parses as an
 * identifier and the first does not, and that boundary is the label/value boundary.
 *
 * Only splits when the tail is a *typed* value. Splitting on plain text would tear
 * "Halcyon Retail Pvt Ltd" into a label and a value, which is worse than not splitting
 * at all.
 */
export function splitFusedLabelValue(
  segment: Segment,
): { label: Segment; value: Segment } | null {
  // Split on spaces in the *text*, not on word boundaries. A single PDF text item can
  // contain spaces — "Receipt R0400217" is very often one item — so splitting at word
  // boundaries finds nothing to split, which is how the receipt number went missing.
  const pieces = piecesOf(segment);
  if (pieces.length < 2) return null;

  // Score every valid split and take the best, rather than the first.
  //
  // "Amount Payable INR 171120.70" has two valid cuts. Taking the longest label gives
  // "Amount Payable INR" = "171120.70", which quietly moves the currency into the field
  // name — so the field ends up called "Amount Payable INR" and the amount loses the one
  // piece of metadata that says what it is denominated in. Choosing by how confidently
  // the *value* parses gets it right: "INR 171120.70" is money with a known currency
  // (0.95) and beats a bare number (0.7).
  let best: { label: Segment; value: Segment; score: number } | null = null;

  for (let cut = pieces.length - 1; cut >= 1; cut--) {
    const head = pieces.slice(0, cut);
    const tail = pieces.slice(cut);
    const headText = head.map((p) => p.text).join(' ');
    const tailText = tail.map((p) => p.text).join(' ');

    const tailType = typeValue(tailText);
    if (tailType.type === 'text') continue;
    if (typeValue(headText).type !== 'text') continue;
    if (!/[A-Za-z]/.test(headText)) continue;

    // Nudge towards longer labels only as a tie-break, never over a clearer value.
    const score = tailType.confidence + cut * 0.001;
    if (!best || score > best.score) {
      best = {
        label: { text: headText, box: unionAll(head.map((p) => p.box)), words: segment.words },
        value: { text: tailText, box: unionAll(tail.map((p) => p.box)), words: segment.words },
        score,
      };
    }
  }

  return best ? { label: best.label, value: best.value } : null;
}

/**
 * Break a segment into space-separated pieces with a box for each.
 *
 * Where a word already corresponds to one piece its real box is used. Where a single
 * word contains spaces the box is divided by character count, which assumes uniform
 * character width and is therefore approximate — it is off by a few points on a
 * proportional font. That is fine for its purpose: the box exists so the UI can point at
 * the value on the page, and being a couple of points wide of the mark is invisible,
 * whereas not finding the field at all is not.
 */
function piecesOf(segment: Segment): { text: string; box: Box }[] {
  const out: { text: string; box: Box }[] = [];

  for (const word of segment.words) {
    const parts = word.text.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      if (parts[0]) out.push({ text: parts[0], box: word.box });
      continue;
    }
    const totalChars = parts.reduce((n, p) => n + p.length, 0) + (parts.length - 1);
    let consumed = 0;
    for (const part of parts) {
      const startFraction = consumed / totalChars;
      const endFraction = (consumed + part.length) / totalChars;
      out.push({
        text: part,
        box: {
          x: word.box.x + word.box.w * startFraction,
          y: word.box.y,
          w: word.box.w * (endFraction - startFraction),
          h: word.box.h,
        },
      });
      consumed += part.length + 1;
    }
  }

  return out;
}

/**
 * What does this page say it is?
 *
 * Business documents are laid out the same way the world over: the sender's name in the
 * largest type at the top, and directly under it, smaller, the word for what the thing
 * *is* — "INVOICE", "Account Statement", "Receipt R0400217". Both are standalone lines
 * above the first label/value pair, and the only reliable way to tell them apart is
 * typographic: the letterhead is the biggest thing on the page and the self-description
 * is not. That rule needs no list of known document types, which is the point — Sift is
 * supposed to work on documents nobody anticipated.
 *
 * So: find the largest text on the page, and read the line directly under it. Trailing
 * value-ish tokens are dropped, so "Receipt R0400217" answers "Receipt" rather than
 * something different on every document in the pile.
 *
 * Returns null when that line is prose, data, or absent — a letter's "Dear Supplier,"
 * sits in exactly the same place as an invoice's "INVOICE" and means nothing like the
 * same thing, and the difference is visible without understanding either.
 */
export function selfDescription(page: Page): string | null {
  const maxSize = Math.max(0, ...page.words.map((w) => w.size));

  // The letterhead is the largest type on the page. Everything hangs off finding it.
  const letterhead = page.lines.findIndex((l) =>
    l.segments.some((seg) => sizeOf(seg) >= maxSize),
  );
  if (letterhead === -1) return null;

  const line = page.lines[letterhead + 1];
  // One segment only: two segments on a line is a label and its value, which is data
  // rather than a title.
  if (!line || line.segments.length !== 1) return null;
  if (line.box.y > page.height * 0.25) return null;

  const text = line.segments[0]!.text.trim();
  // A line that ends mid-sentence is prose. "Dear Supplier," sits in exactly the place a
  // title would and is nothing like one.
  if (/[,;]$/.test(text)) return null;

  const head: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (typeValue(word).type !== 'text') break;
    head.push(word);
  }
  if (head.length === 0 || head.length > 4) return null;

  const title = head.join(' ').replace(/[.:]+$/, '');
  return /[A-Za-z]/.test(title) ? title : null;
}

export function extractFields(page: Page, tables: TableRegion[]): FieldCandidate[] {
  const sizes = page.words.map((w) => w.size).sort((a, b) => a - b);
  const medianSize = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const isLabel = (seg: Segment) =>
    looksLikeLabel(seg.text, { size: sizeOf(seg), medianSize });

  const inTable = (line: Line) =>
    tables.some(
      (t) => centerY(line.box) >= t.box.y - 2 && centerY(line.box) <= t.box.y + t.box.h + 2,
    );

  const lines = page.lines.filter((l) => !inTable(l));
  const out: FieldCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const segs = line.segments;

    // A line that is a single fused "Label Value" segment, with no gap to split on.
    if (segs.length === 1) {
      const fused = splitFusedLabelValue(segs[0]!);
      if (fused && isLabel(fused.label)) {
        out.push(candidate(page.index, fused.label, fused.value, 'right', 0));
      }
      continue;
    }

    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!;
      if (!isLabel(seg)) continue;

      // Prefer the value on the same line, if the next segment is one.
      const next = segs[s + 1];
      if (next && (!isLabel(next) || isValueFor(seg, next))) {
        const gap = next.box.x - right(seg.box);
        out.push(candidate(page.index, seg, next, 'right', gap));
        s++; // the value is consumed; it cannot also be the next label
        continue;
      }

      // Otherwise look directly beneath. The value has to start at about the same x and
      // be close enough vertically that nothing else could be between them.
      const below = findBelow(lines, i, seg, isLabel);
      if (below) out.push(candidate(page.index, seg, below.segment, 'below', below.gap));
    }
  }

  return out;
}

function findBelow(
  lines: Line[],
  index: number,
  label: Segment,
  isLabel: (s: Segment) => boolean,
): { segment: Segment; gap: number } | null {
  const labelLine = lines[index]!;
  for (let j = index + 1; j < Math.min(index + 3, lines.length); j++) {
    const line = lines[j]!;
    const gap = line.box.y - (labelLine.box.y + labelLine.box.h);
    // More than about a line and a half of clear space means they are not related.
    if (gap > label.box.h * 1.8) return null;

    const aligned = line.segments.find(
      (s) => Math.abs(s.box.x - label.box.x) <= 4 && (!isLabel(s) || isValueFor(label, s)),
    );
    if (aligned) return { segment: aligned, gap };
  }
  return null;
}

function candidate(
  page: number,
  label: Segment,
  value: Segment,
  relation: 'right' | 'below',
  gap: number,
): FieldCandidate {
  const typed = typeValue(value.text);
  // Closer means more certain. A value three inches from its label might belong to
  // something else entirely, and the distance is the only evidence either way.
  const proximity = Math.max(0, 1 - gap / (relation === 'right' ? 220 : 40));

  return {
    label: normaliseLabel(label.text),
    labelBox: label.box,
    value: value.text,
    valueBox: value.box,
    page,
    relation,
    type: typed.type,
    confidence: Math.min(0.97, 0.45 + proximity * 0.3 + typed.confidence * 0.25),
  };
}

// ---------------------------------------------------------------------------

export function analyseDocument(pages: Page[], corpus?: CorpusContext): DocumentFields {
  const tables: TableRegion[] = [];
  const fields: FieldCandidate[] = [];
  const narrative: string[] = [];

  for (const page of pages) {
    const pageTables = detectTables(page, 3, corpus);
    tables.push(...pageTables);
    fields.push(...extractFields(page, pageTables));
  }

  // Anything that was neither a field nor a table. Kept rather than dropped: a document
  // that yields no fields at all is a real answer ("this is a letter"), and silently
  // returning an empty result would look like a bug instead.
  for (const page of pages) {
    for (const line of page.lines) {
      const claimed =
        fields.some((f) => f.labelBox.y === line.box.y || f.valueBox.y === line.box.y) ||
        tables.some((t) => centerY(line.box) >= t.box.y && centerY(line.box) <= t.box.y + t.box.h);
      if (!claimed && line.text.split(/\s+/).length > 4) narrative.push(line.text);
    }
  }

  return { fields, tables, narrative };
}

/**
 * Analyse a whole pile, using the first pass to inform the second.
 *
 * This is the function the application actually calls. The single-document version
 * exists for tests and for the case where someone genuinely has one file — and it is
 * measurably worse, which is the honest situation rather than a flaw to hide.
 */
export function analyseCorpus(
  documents: { id: string; pages: Page[] }[],
  minDocumentsToRecur = 3,
): Map<string, DocumentFields> {
  const first = new Map<string, DocumentFields>();
  for (const doc of documents) first.set(doc.id, analyseDocument(doc.pages));

  const documentFrequency = new Map<string, number>();
  for (const [, analysis] of first) {
    for (const label of new Set(analysis.fields.map((f) => f.label))) {
      documentFrequency.set(label, (documentFrequency.get(label) ?? 0) + 1);
    }
  }

  // A string only counts as a label if several different documents used it as one. The
  // threshold is a floor, not a fraction, because a pile can be mostly one kind of
  // document and a fraction would then track the majority rather than the evidence.
  const recurringLabels = new Set(
    [...documentFrequency.entries()]
      .filter(([, n]) => n >= Math.min(minDocumentsToRecur, Math.max(1, documents.length)))
      .map(([label]) => label),
  );

  const second = new Map<string, DocumentFields>();
  for (const doc of documents) second.set(doc.id, analyseDocument(doc.pages, { recurringLabels }));
  return second;
}
