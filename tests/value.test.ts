import { describe, expect, it } from 'vitest';
import {
  parseDateLoose, parseMoney, resolveDateStyle, shapeOf, typeColumn, typeValue,
} from '@/lib/infer/value';

describe('typing a value', () => {
  it.each([
    ['INV-2026-01042', 'identifier'],
    ['naveen@example.com', 'email'],
    ['2026-02-18', 'date'],
    ['09 Feb 2026', 'date'],
    ['$1,234.56', 'money'],
    ['Rs 171120.70', 'money'],
    ['(448.35)', 'money'],
    ['26', 'integer'],
    ['Halcyon Retail Pvt Ltd', 'text'],
  ])('%s is a %s', (raw, type) => {
    expect(typeValue(raw).type).toBe(type);
  });

  it('does not call a bare integer money', () => {
    // Quantities, page numbers and line counts are all bare integers. Money needs a
    // signal — a symbol, a currency word, or the two-decimal convention — or every
    // number on the page becomes a currency amount.
    expect(typeValue('26').type).toBe('integer');
    expect(typeValue('26.00').type).toBe('money');
  });
});

describe('money', () => {
  it('reads accounting negatives instead of flipping their sign', () => {
    // (448.35) means −448.35. Stripping punctuation first — the obvious move — turns
    // every debit into a credit, and the statement balances to exactly the wrong number.
    expect(parseMoney('(448.35)')!.amount).toBe(-448.35);
    expect(parseMoney('448.35')!.amount).toBe(448.35);
  });

  it('recognises a currency whether it is a symbol or a word', () => {
    expect(parseMoney('$1,234.56')).toMatchObject({ amount: 1234.56, currency: 'USD' });
    expect(parseMoney('£99.00')).toMatchObject({ amount: 99, currency: 'GBP' });
    // Standard PDF fonts cannot encode ₹, so real Indian invoices write "Rs" constantly.
    expect(parseMoney('Rs 171120.70')).toMatchObject({ amount: 171120.7, currency: 'INR' });
    expect(parseMoney('INR 500.00')).toMatchObject({ amount: 500, currency: 'INR' });
  });
});

describe('dates, and knowing when you cannot tell', () => {
  it('parses the unambiguous formats outright', () => {
    expect(parseDateLoose('2026-02-18')!.iso).toBe('2026-02-18');
    expect(parseDateLoose('09 Feb 2026')!.iso).toBe('2026-02-09');
    expect(parseDateLoose('Feb 09, 2026')!.iso).toBe('2026-02-09');
  });

  it('settles a slash date when one component proves the order', () => {
    expect(parseDateLoose('27/02/2026')).toMatchObject({ iso: '2026-02-27', ambiguous: false });
    expect(parseDateLoose('02/27/2026')).toMatchObject({ iso: '2026-02-27', ambiguous: false });
  });

  it('admits when a slash date is genuinely ambiguous', () => {
    // 04/05/2026 is the 4th of May almost everywhere and the 5th of April in the US.
    // Nothing in the string resolves it. Guessing is right half the time and never says
    // which half — so the honest answer is low confidence and a flag.
    const d = parseDateLoose('04/05/2026')!;
    expect(d.ambiguous).toBe(true);
    expect(d.confidence).toBeLessThan(0.5);
  });

  it('resolves the whole column from a single unambiguous row', () => {
    // This is the payoff: one row with a day over 12 settles every ambiguous row in the
    // same column. The evidence exists, it just is not in the cell you are looking at.
    const column = ['04/05/2026', '27/02/2026', '01/03/2026'];
    expect(resolveDateStyle(column).style).toBe('dmy');

    const { typed, style } = typeColumn(column);
    expect(style).toBe('dmy');
    expect(typed[0]!.value).toBe('2026-05-04');
    expect(typed[0]!.confidence).toBeGreaterThan(0.8);
  });

  it('refuses to pick when a column mixes both conventions', () => {
    // Proof of both orders in one column means documents from different vendors got
    // merged. Averaging that away would silently corrupt half the rows.
    expect(resolveDateStyle(['27/02/2026', '02/27/2026']).style).toBe('unknown');
  });

  it('resolves per source rather than per column, because vendors disagree', () => {
    // The bug this pins cost four documents. A reconciled field gathers dates from every
    // vendor in the pile; one writes 27/02/2026 and another writes 02/27/2026. Across the
    // merged column there is proof of both orders, so the honest answer is "cannot tell"
    // — and then something still has to decide, and whatever it picks is wrong for half
    // the rows.
    //
    // Grouping by the label each value was found under fixes it, because a vendor uses
    // one wording consistently: everything under "DATE" came from the same source, and
    // one unambiguous value among them settles the rest.
    const merged = ['27/02/2026', '01/03/2026', '02/27/2026', '03/02/2026'];
    expect(resolveDateStyle(merged).style).toBe('unknown');

    const byLabel = {
      'Invoice Date': ['27/02/2026', '01/03/2026'],
      DATE: ['02/27/2026', '03/02/2026'],
    };
    expect(resolveDateStyle(byLabel['Invoice Date']).style).toBe('dmy');
    expect(resolveDateStyle(byLabel.DATE).style).toBe('mdy');

    // And with the convention known, the ambiguous member of each group reads correctly:
    // 01/03 is 1 March for one vendor, 03/02 is 2 March for the other.
    expect(typeColumn(byLabel['Invoice Date']).typed[1]!.value).toBe('2026-03-01');
    expect(typeColumn(byLabel.DATE).typed[1]!.value).toBe('2026-03-02');
  });
});

describe('shape fingerprints', () => {
  it('gives two different ids from two vendors the same shape', () => {
    // Shape agreement is much stronger evidence that two labels mean the same field than
    // their names being similar, which is what makes reconciliation possible at all.
    expect(shapeOf('INV-2026-01042')).toBe(shapeOf('KES-2026-01006'));
    expect(shapeOf('2026-02-18')).not.toBe(shapeOf('INV-2026-01042'));
  });
});
