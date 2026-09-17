/**
 * The geometry vocabulary.
 *
 * Every coordinate in this codebase is in **viewport space at scale 1**: origin at the
 * top-left of the page as a human sees it, y increasing downward, units of PDF points.
 *
 * That choice is load-bearing. PDF's native space has its origin at the bottom-left with
 * y increasing upward, and a page can additionally carry a /Rotate of 90, 180 or 270 that
 * the viewer is expected to apply. Carrying that complexity around would mean every piece
 * of downstream code — line reconstruction, column detection, and above all the overlay
 * that has to sit exactly on top of the rendered page — would need to know about page
 * rotation and flip its own arithmetic. Normalising once, here, means a rotated scan is
 * simply a page whose text happens to be laid out the way it looks.
 */

export type Box = { x: number; y: number; w: number; h: number };

export const right = (b: Box) => b.x + b.w;
export const bottom = (b: Box) => b.y + b.h;
export const centerY = (b: Box) => b.y + b.h / 2;
export const centerX = (b: Box) => b.x + b.w / 2;

export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
};

export const unionAll = (boxes: Box[]): Box =>
  boxes.reduce((a, b) => union(a, b), boxes[0] ?? { x: 0, y: 0, w: 0, h: 0 });

/** Vertical overlap of two boxes as a fraction of the smaller one's height. */
export function verticalOverlap(a: Box, b: Box): number {
  const top = Math.max(a.y, b.y);
  const bot = Math.min(bottom(a), bottom(b));
  const overlap = bot - top;
  if (overlap <= 0) return 0;
  return overlap / Math.max(1e-6, Math.min(a.h, b.h));
}

/**
 * One run of text as the PDF stores it.
 *
 * A "token" here is whatever the PDF producer chose to emit as a single item, which is
 * emphatically *not* a word. A producer adjusting kerning will split "INV-2026-01042"
 * into five items; one that does not will emit an entire line as one. Neither is wrong,
 * and no downstream code should have to care — that is what the grouping pass is for.
 */
export type Token = {
  text: string;
  box: Box;
  /** Font size in points, recovered from the transform rather than the font dictionary. */
  size: number;
  font: string;
  bold: boolean;
};

/** Tokens merged into visual words by horizontal proximity. */
export type Word = {
  text: string;
  box: Box;
  size: number;
  bold: boolean;
  /** Which source tokens this word came from, so a highlight can point at the real runs. */
  tokenIndices: number[];
};

/**
 * A run of words with no meaningful gap between them.
 *
 * This is the most useful unit on the page, and the reason is that two very different
 * things look identical in geometry: a label sitting beside its value, and a table cell
 * sitting beside the next cell in the row. Both are "words, gap, more words". So rather
 * than having separate machinery for forms and for tables, everything downstream works
 * on segments — and a label/value pair and a table row are the same shape.
 */
export type Segment = {
  text: string;
  box: Box;
  words: Word[];
};

/** Words sharing a baseline, ordered left to right. */
export type Line = {
  text: string;
  box: Box;
  words: Word[];
  /** The line broken at its real gaps. Never empty for a non-empty line. */
  segments: Segment[];
};

export type Page = {
  index: number;
  width: number;
  height: number;
  /** The total rotation already applied to these coordinates. */
  rotation: number;
  /**
   * How far the page had to be turned to make its text read left-to-right, beyond its
   * declared /Rotate. Non-zero means the document was sideways — worth surfacing, since
   * it usually means a scan and the user may want to know.
   */
  textRotationCorrected: number;
  tokens: Token[];
  words: Word[];
  lines: Line[];
  /** Detected column boundaries in x, empty when the page is single-column. */
  columns: { x: number; w: number }[];
  /**
   * True when the page carries almost no extractable text — a scan. Recorded rather
   * than silently producing an empty page, because "this document needs OCR" is a
   * different answer from "this document is blank" and the user deserves to be told
   * which one they have.
   */
  needsOcr: boolean;
};

export type ParsedDocument = {
  pageCount: number;
  pages: Page[];
  /** Total extractable characters, a cheap proxy for "did we get anything at all". */
  charCount: number;
};
