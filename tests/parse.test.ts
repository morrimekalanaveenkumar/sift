import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdf } from '@/lib/parse/pdf';
import type { ParsedDocument } from '@/lib/parse/types';

const CORPUS = join(process.cwd(), 'corpus');
const load = async (name: string) => parsePdf(new Uint8Array(await readFile(join(CORPUS, name))));

/** All segment texts on a page, for asserting about layout without pinning coordinates. */
const segments = (doc: ParsedDocument, page = 0) =>
  doc.pages[page]!.lines.flatMap((l) => l.segments.map((s) => s.text));

describe('reading a PDF the way a person sees it', () => {
  it('merges runs that a producer split for kerning back into one value', async () => {
    // Blue Harbor draws every value as several text items, the way a PDF generator does
    // when it adjusts kerning. An extractor that treats each item as a value sees
    // "BLU", "-", "2026", "-", "01012" and produces five wrong answers instead of one
    // right one. This is the single most common way extraction silently produces junk.
    const doc = await load('invoice-blue-12.pdf');
    const page = doc.pages[0]!;

    expect(page.words.length).toBeLessThan(page.tokens.length);
    expect(segments(doc)).toContain('BLU-2026-01012');
    // And the pieces must not also survive as values in their own right.
    expect(segments(doc)).not.toContain('BLU');
  });

  it('keeps a label and its value as separate segments', async () => {
    // The gap between a label and its value is what makes them two things rather than
    // one string. If they merge, every field on the page reads as "Invoice No. INV-123".
    const doc = await load('invoice-blue-12.pdf');
    const line = doc.pages[0]!.lines.find((l) => l.text.startsWith('Inv. Number'))!;

    expect(line.segments.map((s) => s.text)).toEqual(
      expect.arrayContaining(['Inv. Number', 'BLU-2026-01012']),
    );
  });

  it('turns a table row into one segment per cell', async () => {
    // A table row and a label/value pair are the same shape — words, gap, more words —
    // which is why segments work for both and there is no separate table machinery.
    const doc = await load('invoice-blue-12.pdf');
    const row = doc.pages[0]!.lines.find((l) => /^Pallet wrap/.test(l.text))!;

    expect(row.segments).toHaveLength(4);
    expect(row.segments[0]!.text).toBe('Pallet wrap 500mm');
    expect(Number(row.segments[1]!.text)).toBeGreaterThan(0);
    // Amount should equal quantity times unit price — proof the cells line up correctly
    // rather than being shuffled.
    const [, qty, unit, amount] = row.segments.map((s) => Number(s.text));
    expect(qty! * unit!).toBeCloseTo(amount!, 1);
  });

  it('reads a sideways page upright', async () => {
    // A scanner marks the page as rotated while the text was drawn horizontally, so once
    // a viewer applies the rotation the text runs vertically. Everything downstream
    // assumes left-to-right, so this has to be fixed here or the page yields four
    // nonsense lines instead of sixteen good ones.
    const rotated = await load('invoice-northwind-30.pdf');
    const upright = await load('invoice-northwind-0.pdf');

    expect(rotated.pages[0]!.textRotationCorrected).toBe(90);
    // After correction it should parse structurally the same as its upright siblings.
    expect(rotated.pages[0]!.lines.length).toBeGreaterThan(12);
    expect(segments(rotated)).toContain('Invoice No.');
    expect(segments(rotated).some((s) => /^NOR-2026-\d+$/.test(s))).toBe(true);
    expect(rotated.pages[0]!.width).toBeCloseTo(upright.pages[0]!.width, 0);
  });

  it('does not interleave the two halves of a two-column header', async () => {
    // In the content stream the columns are emitted in an arbitrary order. Reading items
    // in that order gives "Invoice # Customer KES-2026-01006 Sundial Markets".
    const doc = await load('invoice-kestrel-6.pdf');
    const line = doc.pages[0]!.lines.find((l) => l.text.includes('Invoice #'))!;
    const texts = line.segments.map((s) => s.text);

    expect(texts[0]).toBe('Invoice #');
    expect(texts[1]).toMatch(/^KES-2026-\d+$/);
    expect(texts).toContain('Customer');
  });

  it('handles labels placed above their values', async () => {
    // "Take whatever is to the right of the label" fails completely here.
    const doc = await load('invoice-meridian-18.pdf');
    const labels = doc.pages[0]!.lines.find((l) => l.text.includes('INVOICE NUMBER'))!;
    const values = doc.pages[0]!.lines.find((l) => /MER-2026-\d+/.test(l.text))!;

    expect(labels.segments.map((s) => s.text)).toEqual(['INVOICE NUMBER', 'DATE', 'CLIENT']);
    expect(values.box.y).toBeGreaterThan(labels.box.y);
    // The value must sit under its own label, not under a neighbour.
    expect(Math.abs(values.segments[0]!.box.x - labels.segments[0]!.box.x)).toBeLessThan(4);
  });

  it('loses no rows where a table crosses a page break', async () => {
    // The continuation page carries rows but no header, so anything that locates columns
    // by finding a header row drops everything after the break. The property that matters
    // is not "the second page has rows" — it is that the two pages together account for
    // every row, with none lost or duplicated at the seam.
    const doc = await load('statement-36.pdf');
    expect(doc.pageCount).toBe(2);

    const rowsOn = (page: number) =>
      doc.pages[page]!.lines.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.segments[0]?.text ?? ''));

    const first = rowsOn(0);
    const second = rowsOn(1);
    expect(second.length).toBeGreaterThan(0);
    // 46 transactions were generated; the corpus records the count as ground truth.
    expect(first.length + second.length).toBe(46);

    // Rows on the headerless page must still resolve into the same four cells.
    for (const row of second) expect(row.segments).toHaveLength(4);

    // And the accounting convention for negatives has to survive intact — a parser that
    // strips punctuation turns a debit into a credit.
    const amounts = [...first, ...second].map((r) => r.segments[2]!.text);
    expect(amounts.some((a) => /^\(\d+\.\d{2}\)$/.test(a))).toBe(true);
  });

  it('rejects a file it cannot read, rather than returning an empty document', async () => {
    // The caller decides what an unreadable file means — one bad file in a pile is
    // survivable, every file unreadable is a broken install — and it can only tell the
    // difference if this throws instead of quietly answering "no pages".
    await expect(parsePdf(new TextEncoder().encode('this is not a PDF'))).rejects.toThrow();
  });

  it('reports a page that carries no text rather than pretending it is empty', async () => {
    // "This needs OCR" and "this page is blank" are different answers and the user
    // deserves to be told which one they have.
    const doc = await load('invoice-blue-12.pdf');
    expect(doc.pages[0]!.needsOcr).toBe(false);
    expect(doc.charCount).toBeGreaterThan(100);
  });
});
