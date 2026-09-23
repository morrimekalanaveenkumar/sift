/**
 * PDF → positioned text.
 *
 * Three passes, each fixing a failure mode that a naive extractor walks straight into:
 *
 *   1. **Tokens.** Read text items and put them all in one normalised coordinate space
 *      (see types.ts), so page rotation stops existing as a concept downstream.
 *   2. **Words.** Merge tokens that are visually adjacent. A PDF producer splits strings
 *      wherever it adjusts kerning, so the visible value "INV-2026-01042" routinely
 *      arrives as five separate items. Treating each item as a value is the single most
 *      common way extraction silently produces garbage.
 *   3. **Lines and columns.** Rebuild reading order from geometry rather than trusting
 *      the order the items appear in the content stream, which is arbitrary. On a
 *      two-column page the stream order interleaves the columns, so anything that reads
 *      items in order gets two documents shuffled together.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { getDocument, Util, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  bottom,
  centerY,
  right,
  union,
  unionAll,
  verticalOverlap,
  type Box,
  type Line,
  type Page,
  type ParsedDocument,
  type Segment,
  type Token,
  type Word,
} from './types';

type Matrix = [number, number, number, number, number, number];

const applyTransform = (p: [number, number], m: Matrix): [number, number] => [
  m[0] * p[0] + m[2] * p[1] + m[4],
  m[1] * p[0] + m[3] * p[1] + m[5],
];

/**
 * Where pdf.js should look for the fourteen standard PDF fonts.
 *
 * A PDF is allowed to reference Helvetica without embedding it, and pdf.js then wants the
 * metrics from its own bundled copy. Without this it still extracts the text, but warns
 * once per page — eighty lines of noise on a forty-document run, which is exactly the
 * kind of thing that makes a tool feel broken when it is working fine.
 *
 * The `existsSync` is not defensive padding. Those fonts are data files that nothing
 * imports, so a bundler's dependency tracing does not follow them, and a deployed build
 * can have the package without the directory. Handing pdf.js a path that is not there is
 * worse than handing it nothing: it then fails to load a font and the whole text
 * extraction rejects, so every page comes back empty and the pile looks like prose.
 * That is exactly what happened on the first deploy.
 */
const standardFontDataUrl = (() => {
  try {
    const require = createRequire(import.meta.url);
    const path = `${dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
})();

export async function parsePdf(data: Uint8Array): Promise<ParsedDocument> {
  const doc = await getDocument({
    data,
    // Node has no worker and no DOM. Turning off eval and the font face rules keeps
    // pdf.js from reaching for browser APIs that are not there.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl,
  }).promise;

  const pages: Page[] = [];
  let charCount = 0;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const parsed = await parsePage(page, i - 1);
    charCount += parsed.tokens.reduce((n, t) => n + t.text.length, 0);
    pages.push(parsed);
    page.cleanup();
  }

  await doc.destroy();
  return { pageCount: pages.length, pages, charCount };
}

async function parsePage(page: PDFPageProxy, index: number): Promise<Page> {
  // Asking for the viewport at scale 1 gives us a transform that already folds in the
  // page's /Rotate and the bottom-left-origin flip. Every coordinate below goes through
  // it, so a rotated page needs no special handling anywhere else.
  const content = await page.getTextContent();

  // ...with one exception, and it is the one that actually shows up in scanned documents.
  //
  // A page's /Rotate tells a viewer how to turn the paper. It does not tell you which way
  // the *text* runs, and those disagree constantly: a scanner emits a page whose text was
  // drawn horizontally and then marks the page as rotated, so once the viewer applies the
  // rotation the text runs vertically down the screen. Everything below this point
  // assumes text runs left-to-right — line grouping compares vertical overlap, segments
  // compare horizontal gaps — so sideways text produces four nonsense lines instead of
  // fourteen good ones.
  //
  // Rather than teaching every downstream pass about direction, measure which way the
  // text actually runs and ask pdf.js for a viewport that puts it upright. The rest of
  // the file then stays honest about coordinates being "as a human reads them".
  const baseRotation = page.rotate;
  const probe = page.getViewport({ scale: 1 });
  const correction = dominantTextRotation(content.items, probe.transform as Matrix);
  const viewport =
    correction === 0 ? probe : page.getViewport({ scale: 1, rotation: baseRotation - correction });

  const tokens: Token[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const text = item.str;
    if (!text || !text.trim()) continue;

    const m = Util.transform(viewport.transform, item.transform) as Matrix;

    // Build the box by transforming all four corners of the glyph run, which is what
    // keeps this correct when the page is rotated rather than only for upright text.
    //
    // The subtlety that costs an hour if you miss it: `item.width` and `item.height` are
    // already in **user space**, while the corners have to be given in **text space**
    // because the matrix will scale them. The matrix scale is the font size, so passing
    // the user-space width straight in applies the font size twice — for 17pt text that
    // puts the top of the box 289 points above the baseline instead of 17, and every
    // line on the page ends up overlapping every other one.
    const sx = Math.hypot(m[0], m[1]) || 1;
    const sy = Math.hypot(m[2], m[3]) || 1;
    const w = (item.width ?? 0) / sx;
    const h = (item.height ?? 0) / sy;
    const corners: [number, number][] = [
      applyTransform([0, 0], m),
      applyTransform([w, 0], m),
      applyTransform([0, h], m),
      applyTransform([w, h], m),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const box: Box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };

    const size = Math.hypot(m[2], m[3]) || box.h;
    const font = (item as { fontName?: string }).fontName ?? '';

    tokens.push({
      text,
      box,
      size,
      font,
      // The font dictionary is not reliably available here, and the name is what every
      // PDF toolchain actually keys on in practice.
      bold: /bold|black|heavy|semibold|-bd|,bold/i.test(font),
    });
  }

  const words = groupIntoWords(tokens);
  const lines = groupIntoLines(words);
  const columns = detectColumns(words, viewport.width);

  return {
    index,
    width: viewport.width,
    height: viewport.height,
    rotation: viewport.rotation,
    textRotationCorrected: correction,
    tokens,
    words,
    lines,
    columns,
    // A page of a text PDF carries hundreds of characters. A scanned page carries none,
    // or a stray few from a footer stamp. The threshold scales with area so a receipt is
    // not mistaken for a scan.
    needsOcr: tokens.reduce((n, t) => n + t.text.trim().length, 0) <
      Math.max(12, (viewport.width * viewport.height) / 40_000),
  };
}

/**
 * Which way does the text on this page actually run?
 *
 * Returns the multiple of 90° that the page must be turned by to make the text upright,
 * or 0 when it already is. Measured from the text matrices rather than assumed from
 * /Rotate, because those two disagree exactly when it matters.
 *
 * Votes are weighted by the length of each run so a stray rotated watermark or a sideways
 * margin stamp cannot outvote the body of the page.
 */
export function dominantTextRotation(items: unknown[], viewportTransform: Matrix): number {
  const votes = new Map<number, number>();

  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item)) continue;
    const it = item as { str: string; transform: number[] };
    const weight = it.str?.trim().length ?? 0;
    if (weight === 0) continue;

    const m = Util.transform(viewportTransform, it.transform) as Matrix;
    // The baseline direction is the image of the x-axis under the matrix.
    const deg = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const quadrant = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    votes.set(quadrant, (votes.get(quadrant) ?? 0) + weight);
  }

  let best = 0;
  let bestWeight = 0;
  for (const [angle, weight] of votes) {
    if (weight > bestWeight) { best = angle; bestWeight = weight; }
  }
  // 0 and 180 both leave text running horizontally. Only a quarter turn needs fixing —
  // upside-down text is a different problem and needs OCR, not a transform.
  return best === 90 || best === 270 ? best : 0;
}

/**
 * Merge tokens that are visually adjacent into words.
 *
 * The decision is "is the gap between these two runs smaller than a space would be?".
 * Space width is estimated from font size rather than measured, because the font metrics
 * are not available here and a fraction of the em is close enough: real inter-word gaps
 * are ~0.25em and up, while kerning splits leave gaps near zero.
 */
export function groupIntoWords(tokens: Token[]): Word[] {
  if (tokens.length === 0) return [];

  const order = tokens
    .map((t, i) => ({ t, i }))
    .sort((a, b) =>
      Math.abs(centerY(a.t.box) - centerY(b.t.box)) > Math.min(a.t.box.h, b.t.box.h) * 0.5
        ? centerY(a.t.box) - centerY(b.t.box)
        : a.t.box.x - b.t.box.x,
    );

  const words: Word[] = [];
  let current: { tokens: Token[]; indices: number[] } | null = null;

  const flush = () => {
    if (!current) return;
    const box = unionAll(current.tokens.map((t) => t.box));
    words.push({
      text: current.tokens.map((t) => t.text).join('').replace(/\s+/g, ' ').trim(),
      box,
      size: Math.max(...current.tokens.map((t) => t.size)),
      bold: current.tokens.some((t) => t.bold),
      tokenIndices: current.indices,
    });
    current = null;
  };

  for (const { t, i } of order) {
    if (!current) {
      current = { tokens: [t], indices: [i] };
      continue;
    }
    const prev = current.tokens[current.tokens.length - 1]!;
    const sameLine = verticalOverlap(prev.box, t.box) > 0.5;
    const gap = t.box.x - right(prev.box);
    const spaceWidth = Math.max(prev.size, t.size) * 0.22;

    // A token that already ends or begins with whitespace is telling us the producer
    // considered them separate words; believe it rather than the geometry.
    const explicitBreak = /\s$/.test(prev.text) || /^\s/.test(t.text);

    if (sameLine && !explicitBreak && gap >= -2 && gap < spaceWidth) {
      current.tokens.push(t);
      current.indices.push(i);
    } else {
      flush();
      current = { tokens: [t], indices: [i] };
    }
  }
  flush();

  return words;
}

/**
 * Rebuild lines from geometry, then break each line at its real gaps.
 *
 * Lines come from vertical overlap rather than from the order items appear in the
 * content stream, because that order is arbitrary — a producer may emit a whole column
 * before starting the next one, or jump around entirely.
 *
 * An earlier version also split lines at detected column gutters. That was a mistake:
 * on an ordinary invoice the space between the description column and the amounts column
 * looks exactly like a gutter, so a single-column page got sliced in half and table rows
 * lost their amounts. Segments do the same job without the false positives, because a
 * gap only has to be locally significant rather than globally structural.
 */
export function groupIntoLines(words: Word[]): Line[] {
  if (words.length === 0) return [];

  const rows: Word[][] = [];
  for (const word of [...words].sort((a, b) => centerY(a.box) - centerY(b.box))) {
    const row = rows[rows.length - 1];
    // Compare against the whole row, not just its first word: a row containing a large
    // heading and small body text would otherwise split, because the small word may not
    // overlap the first word enough on its own.
    if (row && row.some((w) => verticalOverlap(w.box, word.box) > 0.4)) row.push(word);
    else rows.push([word]);
  }

  return rows
    .map((row) => lineOf([...row].sort((a, b) => a.box.x - b.box.x)))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function lineOf(words: Word[]): Line {
  const box = unionAll(words.map((w) => w.box));

  // Break where the gap is wide compared to the text around it. Scaling the threshold
  // to font size rather than using a fixed number of points is what lets the same rule
  // work on a 7pt receipt and a 17pt heading.
  const segments: Segment[] = [];
  let current: Word[] = [];
  for (const word of words) {
    const prev = current[current.length - 1];
    if (prev) {
      const gap = word.box.x - right(prev.box);
      const threshold = Math.max(prev.size, word.size) * 0.9;
      if (gap > threshold) {
        segments.push(segmentOf(current));
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) segments.push(segmentOf(current));

  return { text: words.map((w) => w.text).join(' ').trim(), box, words, segments };
}

const segmentOf = (words: Word[]): Segment => ({
  text: words.map((w) => w.text).join(' ').trim(),
  box: unionAll(words.map((w) => w.box)),
  words,
});

/**
 * Find vertical whitespace corridors wide enough and tall enough to be column gutters.
 *
 * Deliberately conservative. A false positive splits a normal page into nonsense, which
 * is far worse than missing a column layout and reading it as wide lines — so a corridor
 * has to be both genuinely wide and span most of the text's vertical extent before it
 * counts.
 */
export function detectColumns(words: Word[], pageWidth: number): { x: number; w: number }[] {
  if (words.length < 12) return [];

  const top = Math.min(...words.map((w) => w.box.y));
  const bot = Math.max(...words.map((w) => bottom(w.box)));
  const textHeight = bot - top;
  if (textHeight <= 0) return [];

  // Occupancy histogram across the page width, in 4pt buckets.
  const bucket = 4;
  const n = Math.ceil(pageWidth / bucket);
  const occupied = new Array<number>(n).fill(0);
  for (const w of words) {
    const from = Math.max(0, Math.floor(w.box.x / bucket));
    const to = Math.min(n - 1, Math.floor(right(w.box) / bucket));
    for (let i = from; i <= to; i++) occupied[i] = (occupied[i] ?? 0) + w.box.h;
  }

  const minGutter = 28; // points
  const gutters: { from: number; to: number }[] = [];
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if ((occupied[i] ?? 0) === 0) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && (i - runStart) * bucket >= minGutter) {
        gutters.push({ from: runStart * bucket, to: i * bucket });
      }
      runStart = -1;
    }
  }

  const textLeft = Math.min(...words.map((w) => w.box.x));
  const textRight = Math.max(...words.map((w) => right(w.box)));

  // Drop gutters at the margins — they are margins, not gutters.
  const inner = gutters.filter((g) => g.from > textLeft + 20 && g.to < textRight - 20);
  if (inner.length === 0) return [];

  // A gutter only counts if text sits on both sides of it over most of the page's
  // vertical extent. A gap that only exists in the header is a layout detail, not a
  // column boundary.
  const real = inner.filter((g) => {
    const mid = (g.from + g.to) / 2;
    const leftRows = new Set<number>();
    const rightRows = new Set<number>();
    for (const w of words) {
      const band = Math.floor((centerY(w.box) - top) / Math.max(1, textHeight / 20));
      if (right(w.box) <= mid) leftRows.add(band);
      else if (w.box.x >= mid) rightRows.add(band);
    }
    let shared = 0;
    for (const b of leftRows) if (rightRows.has(b)) shared++;
    return shared >= 6;
  });
  if (real.length === 0) return [];

  const edges = [textLeft, ...real.flatMap((g) => [g.from, g.to]), textRight];
  const cols: { x: number; w: number }[] = [];
  for (let i = 0; i < edges.length; i += 2) {
    const x = edges[i]!;
    const end = edges[i + 1] ?? textRight;
    if (end - x > 40) cols.push({ x, w: end - x });
  }
  return cols.length >= 2 ? cols : [];
}

export { union, unionAll, verticalOverlap };
