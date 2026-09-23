/**
 * Generate a corpus of documents with known ground truth.
 *
 * Extraction accuracy is meaningless as a claim and only interesting as a measurement,
 * so the test suite needs documents whose correct answers are known exactly. Downloading
 * a public dataset would give realism but no labels; hand-labelling would give labels but
 * only a handful of documents. Generating them gives both, at the cost that the mess is
 * mess I chose.
 *
 * So the mess is chosen deliberately, and from real failure modes rather than random
 * noise. Every awkwardness below is something that actually breaks naive extractors:
 *
 *   - Five vendors that each name the same field differently. This is the whole reason
 *     field reconciliation has to exist.
 *   - Values drawn as several separate text runs, which is what happens when a PDF
 *     generator kerns a number. Naive extractors read "1" "2" "3" as three values.
 *   - A rotated page, because scanners produce them constantly.
 *   - A two-column layout, where reading in raw text order interleaves two documents.
 *   - A table that spans a page break, where the header is on the previous page.
 *   - Labels above values instead of beside them, which breaks "take what's to the right".
 *   - A document of an entirely different kind, to check clustering doesn't force
 *     everything into one schema.
 */

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';

type Truth = Record<string, string | number | null>;
export type Doc = { file: string; kind: string; vendor: string; truth: Truth; notes: string[] };
export type CorpusFile = { filename: string; bytes: Uint8Array };

const docs: Doc[] = [];

/**
 * Where a generated PDF goes.
 *
 * The generator used to call `writeFile` directly, which tied it to a disk and to the
 * CLI. It now hands finished bytes to whoever asked: the setup script writes them to
 * `corpus/`, and the deployed app ingests them straight from memory so a reviewer who
 * opens the URL sees a working demo rather than an empty upload box.
 */
let sink: CorpusFile[] = [];
const emit = (filename: string, bytes: Uint8Array) => { sink.push({ filename, bytes }); };

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

type Ctx = { page: PDFPage; font: PDFFont; bold: PDFFont; h: number };

const text = (
  c: Ctx,
  s: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {},
) => {
  c.page.drawText(s, {
    x,
    y: c.h - y,
    size: opts.size ?? 10,
    font: opts.bold ? c.bold : c.font,
    color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])),
  });
};

/**
 * Draw a value as several adjacent text runs rather than one.
 *
 * This is not a contrived edge case: PDF producers split strings whenever they adjust
 * kerning, so a single visible "INV-2024-0912" routinely arrives as four separate items
 * with their own positions. An extractor that treats each text item as a value gets four
 * wrong answers instead of one right one, which is exactly what the word-grouping step
 * in parse/ exists to prevent.
 */
const splitText = (c: Ctx, s: string, x: number, y: number, size = 10, bold = false) => {
  let cursor = x;
  // Split at boundaries a real kerning pass would pick: after punctuation, and between
  // digit groups.
  const parts = s.match(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g) ?? [s];
  for (const part of parts) {
    c.page.drawText(part, {
      x: cursor,
      y: c.h - y,
      size,
      font: bold ? c.bold : c.font,
      color: rgb(0.1, 0.1, 0.12),
    });
    cursor += (bold ? c.bold : c.font).widthOfTextAtSize(part, size);
  }
};

const rightText = (c: Ctx, s: string, rightEdge: number, y: number, size = 10, bold = false) => {
  const f = bold ? c.bold : c.font;
  text(c, s, rightEdge - f.widthOfTextAtSize(s, size), y, { size, bold });
};

const line = (c: Ctx, x1: number, y: number, x2: number, shade = 0.85) => {
  c.page.drawLine({
    start: { x: x1, y: c.h - y },
    end: { x: x2, y: c.h - y },
    thickness: 0.7,
    color: rgb(shade, shade, shade),
  });
};

// ---------------------------------------------------------------------------
// Deterministic pseudo-random data, so the corpus is reproducible
// ---------------------------------------------------------------------------

let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (lo: number, hi: number) => (lo + rnd() * (hi - lo)).toFixed(2);

const CUSTOMERS = [
  'Halcyon Retail Pvt Ltd', 'Arbor & Finch', 'Sundial Markets', 'Tessellate Labs',
  'Brightwater Foods', 'Orenda Systems', 'Copperleaf Traders', 'Vantage Hospitality',
];
const ITEMS = [
  'Corrugated boxes (pack of 50)', 'Thermal label rolls', 'Pallet wrap 500mm',
  'Cold chain gel packs', 'Insulated liners', 'Void fill paper', 'Strapping tape',
  'Barcode scanner lease', 'Warehouse racking bay', 'Forklift servicing',
];

/** A date rendered the way a given vendor renders it — half the parsing problem. */
const formatDate = (d: Date, style: string): string => {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  switch (style) {
    case 'iso': return `${yyyy}-${mm}-${dd}`;
    case 'uk': return `${dd}/${mm}/${yyyy}`;
    case 'us': return `${mm}/${dd}/${yyyy}`;
    case 'long': return `${dd} ${mon} ${yyyy}`;
    default: return `${mon} ${dd}, ${yyyy}`;
  }
};

const dateFrom = (offset: number) => new Date(2026, 0, 4 + offset);

// ---------------------------------------------------------------------------
// Vendor templates — the same five fields, named and placed five different ways
// ---------------------------------------------------------------------------

type Vendor = {
  name: string;
  labels: { number: string; date: string; due: string; customer: string; total: string; tax: string };
  dateStyle: string;
  currency: string;
  layout: 'label-left' | 'label-above' | 'two-column' | 'boxed';
  splitValues?: boolean;
};

const VENDORS: Vendor[] = [
  {
    name: 'Northwind Supplies',
    labels: { number: 'Invoice No.', date: 'Invoice Date', due: 'Due Date', customer: 'Bill To', total: 'Total Due', tax: 'GST (18%)' },
    // "Rs " rather than the rupee glyph: the standard PDF fonts cannot encode ₹, and
    // real Indian invoices very often render it this way for exactly that reason. It
    // also gives the corpus a currency written as a word rather than a symbol.
    dateStyle: 'uk', currency: 'Rs ', layout: 'label-left',
  },
  {
    name: 'Kestrel Logistics',
    labels: { number: 'Invoice #', date: 'Issued', due: 'Payment Due', customer: 'Customer', total: 'Amount Payable', tax: 'Tax' },
    dateStyle: 'iso', currency: 'INR ', layout: 'two-column',
  },
  {
    name: 'Blue Harbor Foods',
    labels: { number: 'Inv. Number', date: 'Date of Issue', due: 'Due', customer: 'Sold To', total: 'Grand Total', tax: 'VAT' },
    dateStyle: 'long', currency: '$', layout: 'boxed', splitValues: true,
  },
  {
    name: 'Meridian Technologies',
    labels: { number: 'INVOICE NUMBER', date: 'DATE', due: 'TERMS', customer: 'CLIENT', total: 'TOTAL', tax: 'SALES TAX' },
    dateStyle: 'us', currency: '$', layout: 'label-above',
  },
  {
    name: 'Cedarworks Joinery',
    labels: { number: 'Reference', date: 'Raised on', due: 'Settle by', customer: 'Account', total: 'Balance Due', tax: 'VAT @ 20%' },
    dateStyle: 'medium', currency: '£', layout: 'label-left',
  },
];

async function newDoc() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { pdf, font, bold };
}

const ctxFor = (page: PDFPage, font: PDFFont, bold: PDFFont): Ctx => ({
  page, font, bold, h: page.getHeight(),
});

// ---------------------------------------------------------------------------

async function invoice(vendor: Vendor, n: number, opts: { rotate?: boolean } = {}) {
  const { pdf, font, bold } = await newDoc();
  const page = pdf.addPage([595, 842]);
  if (opts.rotate) page.setRotation(degrees(90));
  const c = ctxFor(page, font, bold);

  const number = `${vendor.name.slice(0, 3).toUpperCase()}-2026-${String(1000 + n).padStart(5, '0')}`;
  const issued = dateFrom(n * 3);
  const due = dateFrom(n * 3 + 30);
  const customer = pick(CUSTOMERS);
  const lines = Array.from({ length: int(2, 5) }, () => ({
    desc: pick(ITEMS), qty: int(1, 40), unit: Number(money(80, 2400)),
  }));
  const sub = lines.reduce((t, l) => t + l.qty * l.unit, 0);
  const taxRate = vendor.labels.tax.includes('18') ? 0.18 : vendor.labels.tax.includes('20') ? 0.2 : 0.1;
  const tax = sub * taxRate;
  const total = sub + tax;

  const put = vendor.splitValues ? splitText : (cc: Ctx, s: string, x: number, y: number, size = 10, b = false) =>
    text(cc, s, x, y, { size, bold: b });

  text(c, vendor.name, 48, 60, { size: 17, bold: true });
  text(c, 'INVOICE', 48, 80, { size: 9, color: [0.45, 0.45, 0.5] });

  const L = vendor.labels;
  if (vendor.layout === 'label-left') {
    let y = 130;
    for (const [label, value] of [
      [L.number, number], [L.date, formatDate(issued, vendor.dateStyle)],
      [L.due, formatDate(due, vendor.dateStyle)], [L.customer, customer],
    ] as [string, string][]) {
      text(c, label, 48, y, { size: 9, color: [0.42, 0.42, 0.48] });
      put(c, value, 165, y, 10, false);
      y += 20;
    }
  } else if (vendor.layout === 'label-above') {
    let x = 48;
    for (const [label, value] of [
      [L.number, number], [L.date, formatDate(issued, vendor.dateStyle)], [L.customer, customer],
    ] as [string, string][]) {
      text(c, label, x, 128, { size: 7.5, color: [0.5, 0.5, 0.56] });
      put(c, value, x, 143, 10, false);
      x += 175;
    }
  } else if (vendor.layout === 'two-column') {
    // Two columns of label/value pairs. Reading this in raw text order interleaves the
    // columns, which is why the parser reconstructs lines from geometry instead.
    const left: [string, string][] = [[L.number, number], [L.date, formatDate(issued, vendor.dateStyle)]];
    const right: [string, string][] = [[L.customer, customer], [L.due, formatDate(due, vendor.dateStyle)]];
    left.forEach(([label, value], i) => {
      text(c, label, 48, 130 + i * 20, { size: 9, color: [0.42, 0.42, 0.48] });
      put(c, value, 140, 130 + i * 20, 10, false);
    });
    right.forEach(([label, value], i) => {
      text(c, label, 330, 130 + i * 20, { size: 9, color: [0.42, 0.42, 0.48] });
      put(c, value, 420, 130 + i * 20, 10, false);
    });
  } else {
    page.drawRectangle({
      x: 44, y: c.h - 175, width: 507, height: 62,
      borderColor: rgb(0.85, 0.85, 0.88), borderWidth: 0.8,
    });
    let y = 132;
    for (const [label, value] of [[L.number, number], [L.date, formatDate(issued, vendor.dateStyle)]] as [string, string][]) {
      text(c, label, 56, y, { size: 9, color: [0.42, 0.42, 0.48] });
      put(c, value, 175, y, 10, false);
      y += 20;
    }
    text(c, L.customer, 320, 132, { size: 9, color: [0.42, 0.42, 0.48] });
    put(c, customer, 320, 152, 10, false);
  }

  let y = 225;
  text(c, 'Description', 48, y, { size: 8.5, bold: true, color: [0.4, 0.4, 0.46] });
  rightText(c, 'Qty', 330, y, 8.5, true);
  rightText(c, 'Unit', 430, y, 8.5, true);
  rightText(c, 'Amount', 547, y, 8.5, true);
  line(c, 48, y + 6, 547);
  y += 22;
  for (const l of lines) {
    text(c, l.desc, 48, y);
    rightText(c, String(l.qty), 330, y);
    rightText(c, l.unit.toFixed(2), 430, y);
    rightText(c, (l.qty * l.unit).toFixed(2), 547, y);
    y += 18;
  }
  line(c, 330, y, 547);
  y += 18;
  text(c, 'Subtotal', 380, y, { size: 9.5 });
  rightText(c, `${vendor.currency}${sub.toFixed(2)}`, 547, y);
  y += 17;
  text(c, L.tax, 380, y, { size: 9.5 });
  rightText(c, `${vendor.currency}${tax.toFixed(2)}`, 547, y);
  y += 20;
  text(c, L.total, 380, y, { size: 11, bold: true });
  rightText(c, `${vendor.currency}${total.toFixed(2)}`, 547, y, 11, true);

  text(c, 'Thank you for your business.', 48, 800, { size: 8, color: [0.55, 0.55, 0.6] });

  const file = `invoice-${vendor.name.split(' ')[0]!.toLowerCase()}-${n}.pdf`;
  emit(file, await pdf.save());
  docs.push({
    file, kind: 'invoice', vendor: vendor.name,
    truth: {
      invoice_number: number,
      invoice_date: formatDate(issued, vendor.dateStyle),
      // The date the vendor *meant*, independent of how they render it. Without this the
      // accuracy harness has to guess whether "02/27/2026" is February or a nonsense
      // month, and a harness that guesses cannot grade a parser that does not.
      invoice_date_iso: formatDate(issued, 'iso'),
      customer,
      subtotal: Number(sub.toFixed(2)),
      tax: Number(tax.toFixed(2)),
      total: Number(total.toFixed(2)),
    },
    notes: [
      `layout: ${vendor.layout}`,
      ...(vendor.splitValues ? ['values drawn as multiple text runs'] : []),
      ...(opts.rotate ? ['page rotated 90°'] : []),
    ],
  });
}

/** A receipt: narrow, cramped, no table structure to speak of. */
async function receipt(n: number) {
  const { pdf, font, bold } = await newDoc();
  const page = pdf.addPage([226, 520]);
  const c = ctxFor(page, font, bold);
  const number = `R${String(400000 + n * 7).padStart(7, '0')}`;
  const when = dateFrom(n);
  const store = pick(['Grainhouse Cafe', 'Depot 9 Hardware', 'Marlow Stationery']);
  const items = Array.from({ length: int(2, 4) }, () => ({ d: pick(ITEMS).slice(0, 18), a: Number(money(40, 600)) }));
  const total = items.reduce((t, i) => t + i.a, 0);

  text(c, store, 20, 30, { size: 11, bold: true });
  text(c, `Receipt ${number}`, 20, 48, { size: 8 });
  text(c, formatDate(when, 'uk'), 20, 62, { size: 8 });
  let y = 90;
  for (const i of items) {
    text(c, i.d, 20, y, { size: 8 });
    rightText(c, i.a.toFixed(2), 206, y, 8);
    y += 14;
  }
  line(c, 20, y, 206);
  y += 16;
  text(c, 'TOTAL', 20, y, { size: 9, bold: true });
  rightText(c, total.toFixed(2), 206, y, 9, true);

  const file = `receipt-${n}.pdf`;
  emit(file, await pdf.save());
  docs.push({
    file, kind: 'receipt', vendor: store,
    truth: {
      receipt_number: number,
      date: formatDate(when, 'uk'),
      date_iso: formatDate(when, 'iso'),
      merchant: store,
      total: Number(total.toFixed(2)),
    },
    notes: ['narrow thermal-style layout', 'no ruled table'],
  });
}

/** A statement whose transaction table runs over a page break, header left behind. */
async function statement(n: number) {
  const { pdf, font, bold } = await newDoc();
  const account = `****${int(1000, 9999)}`;
  const rows = Array.from({ length: 46 }, (_, i) => ({
    date: formatDate(dateFrom(i), 'iso'),
    desc: pick(['Card payment', 'Direct debit', 'Transfer in', 'Standing order', 'ATM withdrawal']),
    amount: (rnd() < 0.3 ? 1 : -1) * Number(money(50, 4000)),
  }));
  let balance = 250000;

  let page = pdf.addPage([595, 842]);
  let c = ctxFor(page, font, bold);
  text(c, 'Rivermeet Bank', 48, 55, { size: 15, bold: true });
  text(c, 'Account Statement', 48, 74, { size: 9, color: [0.45, 0.45, 0.5] });
  text(c, 'Account', 48, 104, { size: 9, color: [0.42, 0.42, 0.48] });
  text(c, account, 140, 104);
  text(c, 'Period', 330, 104, { size: 9, color: [0.42, 0.42, 0.48] });
  text(c, '2026-01-04 to 2026-02-18', 400, 104, { size: 9 });

  let y = 145;
  const header = (cc: Ctx, yy: number) => {
    text(cc, 'Date', 48, yy, { size: 8.5, bold: true, color: [0.4, 0.4, 0.46] });
    text(cc, 'Description', 140, yy, { size: 8.5, bold: true, color: [0.4, 0.4, 0.46] });
    rightText(cc, 'Amount', 430, yy, 8.5, true);
    rightText(cc, 'Balance', 547, yy, 8.5, true);
    line(cc, 48, yy + 6, 547);
  };
  header(c, y);
  y += 20;

  for (const r of rows) {
    if (y > 790) {
      // Deliberately no repeated header on the continuation page. An extractor that
      // finds columns by looking for a header row will lose the second half of the table.
      page = pdf.addPage([595, 842]);
      c = ctxFor(page, font, bold);
      y = 60;
    }
    balance += r.amount;
    text(c, r.date, 48, y, { size: 9 });
    text(c, r.desc, 140, y, { size: 9 });
    // Negative amounts in parentheses, the accounting convention that defeats parseFloat.
    rightText(c, r.amount < 0 ? `(${Math.abs(r.amount).toFixed(2)})` : r.amount.toFixed(2), 430, y, 9);
    rightText(c, balance.toFixed(2), 547, y, 9);
    y += 15;
  }

  const file = `statement-${n}.pdf`;
  emit(file, await pdf.save());
  docs.push({
    file, kind: 'statement', vendor: 'Rivermeet Bank',
    truth: { account, transactions: rows.length, closing_balance: Number(balance.toFixed(2)) },
    notes: ['table spans a page break', 'continuation page has no header', 'negatives in parentheses'],
  });
}

/** Something that is not a form at all, to check clustering does not force a schema on it. */
async function letter(n: number) {
  const { pdf, font, bold } = await newDoc();
  const page = pdf.addPage([595, 842]);
  const c = ctxFor(page, font, bold);
  text(c, 'Orenda Systems', 48, 60, { size: 14, bold: true });
  text(c, formatDate(dateFrom(n * 5), 'long'), 48, 100, { size: 10 });
  const body = [
    'Dear Supplier,',
    '',
    'Following our review of the current quarter we are consolidating purchasing',
    'across the Bengaluru and Pune sites. Existing agreements remain in force until',
    'the end of the term. Please direct future correspondence to the address below.',
    '',
    'We appreciate your continued partnership.',
    '',
    'Regards,',
    'Procurement',
  ];
  body.forEach((l, i) => text(c, l, 48, 140 + i * 17, { size: 10.5 }));

  const file = `letter-${n}.pdf`;
  emit(file, await pdf.save());
  docs.push({
    file, kind: 'letter', vendor: 'Orenda Systems',
    truth: {}, notes: ['prose, not a form — should not be forced into a schema'],
  });
}

// ---------------------------------------------------------------------------

/**
 * Build the whole corpus in memory, deterministically.
 *
 * Seeded, so the same forty documents come out byte-identical on every machine — which is
 * what lets the accuracy harness compare against recorded ground truth rather than a
 * fresh guess each run.
 */
export async function generateCorpus(): Promise<{ files: CorpusFile[]; truth: Doc[] }> {
  // Both module-level accumulators are reset here, so calling this twice in one process
  // (the app can) yields one corpus rather than two stapled together.
  sink = [];
  docs.length = 0;
  seed = 42;

  let n = 0;
  // Several documents per vendor, so reconciliation has enough evidence to work from
  // and clustering has real groups rather than singletons.
  for (const v of VENDORS) for (let i = 0; i < 6; i++) await invoice(v, n++);

  // One rotated, because scanners do this constantly.
  await invoice(VENDORS[0]!, n++, { rotate: true });

  for (let i = 0; i < 5; i++) await receipt(n++);
  await statement(n++);
  await statement(n++);
  await letter(n++);
  await letter(n++);

  return { files: sink, truth: docs.map((d) => ({ ...d })) };
}
