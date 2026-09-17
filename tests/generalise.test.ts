import { describe, expect, it } from 'vitest';
import {
  applySignature,
  classifyCorrection,
  describeSignature,
  previewGeneralisation,
  signatureKey,
  type CorrectionSignature,
} from '@/lib/extract/generalise';

/**
 * These tests are mostly about what generalisation must *refuse* to do.
 *
 * Applying one person's correction to rows they never looked at is the single most
 * dangerous thing this system does, so the interesting cases are all the ones where a
 * pattern matches and the answer is still no.
 */

describe('working out what kind of edit a correction was', () => {
  it('recognises a stripped prefix rather than memorising the new value', () => {
    // The point of a signature: "remove 'INR '" transfers to other cells, "set it to
    // 171120.70" transfers to nothing.
    expect(classifyCorrection('INR 171120.70', '171120.70')).toEqual({
      kind: 'strip_prefix',
      prefix: 'INR ',
    });
  });

  it('recognises a stripped suffix', () => {
    expect(classifyCorrection('Halcyon Retail Pvt Ltd', 'Halcyon Retail')).toEqual({
      kind: 'strip_suffix',
      suffix: ' Pvt Ltd',
    });
  });

  it('reads a re-dated value as a convention change, not a substring edit', () => {
    // "03/02/2026" -> "2026-03-02" could be described as an edit to the characters. It
    // is not: it is a statement that this vendor writes months first, which is a fact
    // about every date they ever sent.
    expect(classifyCorrection('03/02/2026', '2026-03-02')).toEqual({
      kind: 'date_convention',
      from: 'dmy',
      to: 'mdy',
    });
  });

  it('refuses to generalise from a single stripped character', () => {
    // "Acme." -> "Acme" is real, but "remove the trailing '.'" would match a large part
    // of any corpus. A signature that broad is worse than no signature.
    expect(classifyCorrection('Acme.', 'Acme')).toEqual({ kind: 'manual' });
  });

  it('treats an unrelated rewrite as a one-off', () => {
    expect(classifyCorrection('Brightwater Foods', 'Brightwater Foods Ltd')).toEqual({ kind: 'manual' });
    expect(classifyCorrection('12.00', '9.99')).toEqual({ kind: 'manual' });
  });

  it('gives every signature a stable key and a sentence a person can read', () => {
    const sig = classifyCorrection('INR 171120.70', '171120.70');
    expect(signatureKey(sig)).toBe('strip_prefix:INR ');
    expect(describeSignature(sig)).toBe('remove the leading "INR "');
  });
});

describe('applying a signature to another value', () => {
  const stripInr: CorrectionSignature = { kind: 'strip_prefix', prefix: 'INR ' };

  it('applies where the pattern is present and declines where it is not', () => {
    expect(applySignature(stripInr, 'INR 4021.50')).toBe('4021.50');
    expect(applySignature(stripInr, 'Rs 4021.50')).toBeNull();
  });

  it('never re-reads a date that already proved its own order', () => {
    // This is the one that matters. "Read this column as month-first" is learned from an
    // ambiguous value, and must not touch "13/02/2026" — there is no thirteenth month,
    // so that value was never in doubt and rewriting it would invent a date.
    const sig: CorrectionSignature = { kind: 'date_convention', from: 'dmy', to: 'mdy' };
    expect(applySignature(sig, '04/05/2026')).toBe('2026-04-05');
    expect(applySignature(sig, '13/02/2026')).toBeNull();
    expect(applySignature(sig, '09 Feb 2026')).toBeNull();
  });

  it('does nothing at all for a one-off', () => {
    expect(applySignature({ kind: 'manual' }, 'anything')).toBeNull();
  });
});

describe('previewing the blast radius', () => {
  const cells = [
    { id: 'a', document: 'one.pdf', raw: 'INR 100.00' },
    { id: 'b', document: 'two.pdf', raw: 'INR 250.75' },
    { id: 'c', document: 'three.pdf', raw: '$40.00' },
    { id: 'd', document: 'four.pdf', raw: null },
  ];

  it('returns previews rather than performing anything', () => {
    const sig = classifyCorrection('INR 12.00', '12.00');
    const preview = previewGeneralisation(sig, cells);

    expect(preview.map((p) => p.cellId)).toEqual(['a', 'b']);
    expect(preview[0]).toMatchObject({ before: 'INR 100.00', after: '100.00' });
    // The originals are untouched: the caller decides, not this function.
    expect(cells[0]!.raw).toBe('INR 100.00');
  });

  it('leaves out the cell the person just fixed', () => {
    const sig = classifyCorrection('INR 12.00', '12.00');
    expect(previewGeneralisation(sig, cells, 'a').map((p) => p.cellId)).toEqual(['b']);
  });

  it('refuses to empty a value it does not fully understand', () => {
    // The same rule reaching a cell that reads "INR" and nothing else would leave a
    // blank behind, in a row nobody opened. Silent data loss is the failure mode this
    // whole feature has to avoid.
    const sig: CorrectionSignature = { kind: 'strip_prefix', prefix: 'INR ' };
    expect(previewGeneralisation(sig, [{ id: 'x', document: 'x.pdf', raw: 'INR ' }])).toEqual([]);
  });

  it('refuses a rule that would strip the part making a value typeable', () => {
    // "INV-2026-01042" is an identifier; "INV" is a word. A rule that turns one into the
    // other has stopped correcting and started destroying.
    const sig: CorrectionSignature = { kind: 'strip_suffix', suffix: '-2026-01042' };
    expect(
      previewGeneralisation(sig, [{ id: 'y', document: 'y.pdf', raw: 'INV-2026-01042' }]),
    ).toEqual([]);
  });

  it('does nothing for a one-off, however many cells look similar', () => {
    expect(previewGeneralisation({ kind: 'manual' }, cells)).toEqual([]);
  });
});
