import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePdf } from '@/lib/parse/pdf';
import { analyseCorpus, selfDescription, type DocumentFields } from '@/lib/infer/fields';
import { clusterDocuments, signatureOf } from '@/lib/infer/cluster';
import { labelSimilarity, normaliseLabelTokens, reconcileFields, type DocumentObservation } from '@/lib/infer/reconcile';
import type { ParsedDocument } from '@/lib/parse/types';

type Item = { file: string; doc: ParsedDocument; analysis: DocumentFields };
let items: Item[];

beforeAll(async () => {
  const files = (await readdir('corpus')).filter((f) => f.endsWith('.pdf')).sort();
  const parsed = [];
  for (const f of files) {
    parsed.push({ id: f, doc: await parsePdf(new Uint8Array(await readFile(join('corpus', f)))) });
  }
  const analyses = analyseCorpus(parsed.map((p) => ({ id: p.id, pages: p.doc.pages })));
  items = parsed.map((p) => ({ file: p.id, doc: p.doc, analysis: analyses.get(p.id)! }));
}, 240_000);

const clusterFor = (prefix: string) => {
  const clusters = clusterDocuments(items, (i) => signatureOf(i.doc, i.analysis));
  return clusters.find((c) => c.members.filter((m) => m.file.startsWith(prefix)).length > c.members.length / 2)!;
};

const schemaFor = (prefix: string) => {
  const cluster = clusterFor(prefix);
  const obs: DocumentObservation[] = cluster.members.map((m) => ({
    docId: m.file,
    fields: m.analysis.fields,
    pageWidth: m.doc.pages[0]?.width ?? 595,
    pageHeight: m.doc.pages[0]?.height ?? 842,
  }));
  return { cluster, ...reconcileFields(obs) };
};

describe('sorting an unknown pile into kinds', () => {
  it('groups by structure, not by field names', async () => {
    // Clustering on label text would put each vendor in its own group, because five
    // vendors share almost no label wording — and there would be nothing left for
    // reconciliation to do. Structure is what they actually share.
    const clusters = clusterDocuments(items, (i) => signatureOf(i.doc, i.analysis));
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    expect(clusters.length).toBeLessThanOrEqual(6);

    const invoices = clusterFor('invoice');
    // All 31 invoices, from five vendors with different layouts, in one cluster —
    // including the one a scanner rotated 90°.
    expect(invoices.members.filter((m) => m.file.startsWith('invoice'))).toHaveLength(31);
    expect(invoices.members.some((m) => m.file.includes('northwind-30'))).toBe(true);
  });

  it('keeps prose out of the structured kinds', () => {
    // A letter is not a form. Forcing it into a schema would invent fields that are not
    // there; the honest answer is that it belongs to its own kind with none.
    const letters = clusterFor('letter');
    expect(letters.members.every((m) => m.file.startsWith('letter'))).toBe(true);
    expect(letters.members.flatMap((m) => m.analysis.fields)).toHaveLength(0);
  });
});

describe('reconciling field names across vendors', () => {
  it('collapses five vendors\' names for the invoice number into one field', () => {
    const { fields } = schemaFor('invoice');
    const number = fields.find((f) => [f.name, ...f.aliases].includes('Inv. Number'))!;

    expect(number).toBeDefined();
    expect(number.type).toBe('identifier');
    // Every vendor's spelling, including "Reference", which shares no words with any
    // of the others and is caught by role and value shape instead.
    expect([number.name, ...number.aliases].sort()).toEqual(
      ['INVOICE NUMBER', 'Inv. Number', 'Invoice', 'Invoice No.', 'Reference'].sort(),
    );
    expect(number.coverage).toBe(1);
  });

  it('collapses date fields whose names share no words at all', () => {
    // "Raised on" and "Issued" mean "Invoice Date" and look nothing like it. What gives
    // them away is that each is the first date on its document — a fact about invoices
    // rather than about any vendor's template.
    const { fields } = schemaFor('invoice');
    const issued = fields.find((f) => [f.name, ...f.aliases].includes('Raised on'))!;

    expect([issued.name, ...issued.aliases]).toEqual(
      expect.arrayContaining(['Invoice Date', 'Date of Issue', 'Raised on', 'Issued', 'DATE']),
    );
    expect(issued.type).toBe('date');
  });

  it('refuses to merge three amounts that appear together', () => {
    // Subtotal, tax and total are all money, all in the same corner, all named
    // differently by every vendor. The only thing stopping them collapsing into one
    // column is that they appear together on a single document — which is proof, not a
    // signal, and is treated as a hard constraint.
    const { fields } = schemaFor('invoice');
    const names = fields.map((f) => [f.name, ...f.aliases]);

    const groupOf = (label: string) => names.findIndex((g) => g.includes(label));
    expect(groupOf('Subtotal')).not.toBe(groupOf('VAT'));
    expect(groupOf('Subtotal')).not.toBe(groupOf('Grand Total'));
    expect(groupOf('VAT')).not.toBe(groupOf('Grand Total'));

    // And each of them still gathers its own synonyms from the other vendors.
    const tax = fields.find((f) => [f.name, ...f.aliases].includes('VAT'))!;
    expect([tax.name, ...tax.aliases]).toEqual(
      expect.arrayContaining(['VAT', 'VAT @ 20%', 'GST (18%)', 'SALES TAX', 'Tax']),
    );
  });

  it('discovers the whole invoice schema, not just the easy fields', () => {
    const { fields } = schemaFor('invoice');
    const solid = fields.filter((f) => f.coverage >= 0.5);

    // Number, date, customer, subtotal, tax, total, due date.
    expect(solid).toHaveLength(7);
    expect(solid.filter((f) => f.coverage === 1)).toHaveLength(6);
    // Nothing should be left over as a one-vendor straggler.
    expect(fields.filter((f) => f.coverage < 0.2)).toHaveLength(0);
  });

  it('explains every merge in words', () => {
    // A schema someone is asked to trust has to be able to justify itself. "These two
    // labels are the same field" is a claim, and the user should be able to see why.
    const { fields } = schemaFor('invoice');
    const merged = fields.filter((f) => f.aliases.length > 0);

    expect(merged.length).toBeGreaterThan(3);
    for (const f of merged) {
      expect(f.rationale.length).toBeGreaterThan(0);
      expect(f.rationale.join(' ')).toMatch(/name|shape|field on its document|part of the page/);
    }
  });
});

describe('label normalisation', () => {
  it('expands clippings without a domain word list', () => {
    expect(normaliseLabelTokens('Inv. Number')).toEqual(['invoice', 'number']);
    expect(normaliseLabelTokens('Invoice No.')).toEqual(['invoice', 'number']);
    // The rate belongs to the document, not to the field's name.
    expect(normaliseLabelTokens('VAT @ 20%')).toEqual(['vat']);
    expect(normaliseLabelTokens('GST (18%)')).toEqual(['gst']);
  });

  it('scores partial agreement instead of demanding a majority', () => {
    // "Payment Due" and "Due Date" share one token in three. Weak alone, decisive when
    // it lines up with role and type — so the gate has to let it through.
    expect(labelSimilarity('Payment Due', 'Due Date')).toBeGreaterThan(0.2);
    expect(labelSimilarity('Invoice No.', 'Inv. Number')).toBeGreaterThan(0.9);
    expect(labelSimilarity('Subtotal', 'Bill To')).toBe(0);
  });
});

describe('telling a label from a value needs the whole pile', () => {
  it('does not mistake receipt line items for fields', () => {
    // "Corrugated boxes" beside an amount is structurally identical to "Subtotal" beside
    // an amount. One document cannot tell them apart; forty can, because labels recur
    // and values do not.
    const { fields } = schemaFor('receipt');
    const names = fields.flatMap((f) => [f.name, ...f.aliases]);

    expect(names.some((n) => /Corrugated|Insulated|Warehouse racking/.test(n))).toBe(false);
    expect(names).toContain('TOTAL');
  });

  it('does not mistake a heading for a label', () => {
    // The shop name at the top of a receipt sits directly above another value, which is
    // exactly what a label does. It is set in 11pt on an 8pt page, and that is the tell.
    const { fields } = schemaFor('receipt');
    const names = fields.flatMap((f) => [f.name, ...f.aliases]);
    expect(names.some((n) => /Marlow|Grainhouse|Depot 9/.test(n))).toBe(false);
  });

  it('splits a label and value that share one text run', () => {
    // "Receipt R0400217" is a single PDF text item, so there is no gap to split on — but
    // the tail parses as an identifier and the head does not, and that is the boundary.
    const { fields } = schemaFor('receipt');
    const receiptNumber = fields.find((f) => f.name === 'Receipt')!;
    expect(receiptNumber).toBeDefined();
    expect(receiptNumber.type).toBe('identifier');
    expect(receiptNumber.samples[0]).toMatch(/^R\d+$/);
  });
});

describe('working out what a pile of documents calls itself', () => {
  const said = (file: string) => selfDescription(items.find((i) => i.file === file)!.doc.pages[0]!);

  it('reads the document type off the page rather than off a list of known types', () => {
    // No part of Sift is told what an invoice is. The page says so itself, in the line
    // under the letterhead, and that is where this reads it from.
    expect(said('invoice-northwind-0.pdf')).toBe('INVOICE');
    expect(said('statement-36.pdf')).toBe('Account Statement');
  });

  it('is not fooled by the letterhead, which is bigger and means something else', () => {
    // "Northwind Supplies" is the largest text on the page and is not what the document
    // is — it is who sent it. Every vendor in the corpus lays the page out this way, and
    // so does almost every real one.
    for (const file of ['invoice-northwind-0.pdf', 'invoice-meridian-18.pdf', 'invoice-blue-12.pdf']) {
      expect(said(file)).toBe('INVOICE');
    }
  });

  it('drops the value half of a type line that carries one', () => {
    // A receipt announces itself as "Receipt R0400217" — the number differs on every
    // document in the pile, so keeping it would give every receipt its own kind name.
    expect(said('receipt-31.pdf')).toBe('Receipt');
  });

  it('says nothing when a document opens with prose', () => {
    // A letter has a letterhead and then a greeting. Guessing from that would name the
    // kind "Dear Supplier", so the answer here has to be "I do not know".
    expect(said('letter-38.pdf')).toBeNull();
  });
});
