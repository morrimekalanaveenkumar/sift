# Sift

**Turn a pile of documents into a table you can query.**

Sift takes documents of whatever kinds you happen to have, works out what they are, works
out which fields they share — even when every source names those fields differently — and
turns the pile into a real Postgres table with real column types, showing you exactly where
every value came from.

It is told nothing about invoices. The schema is discovered, not configured.

<p align="center">
  <img src="docs/screenshots/01-schema.png" width="880" alt="Four kinds discovered from a pile of forty documents; the invoice kind has seven fields, each showing the other names it was also called">
</p>

---

## Run it

Needs **Node 20+** and a **Postgres 14+** you can connect to.

```bash
npm install
cp .env.example .env          # edit if your Postgres is not on localhost
npm run setup                 # creates the database, generates a 40-document corpus, ingests it
npm run dev                   # http://localhost:3000
```

`npm run setup` is idempotent and takes a few seconds. It creates the database if it does
not exist, applies the schema, generates the test corpus if it is missing, and ingests it
— so the app opens on something worth looking at rather than an empty screen.

```
40 documents -> 4 kinds, 11 fields
  Invoices                  31 docs, 7 fields
  Receipts                   5 docs, 2 fields
  Account Statements         2 docs, 2 fields
  Unstructured documents     2 docs, 0 fields
```

Ingesting all 40 documents — parsing, layout analysis, clustering, reconciliation and
storage — takes about **1.5 seconds**.

```bash
npm test          # 64 tests
npm run typecheck
```

---

## The problem, and which version of it this solves

The brief says *"takes unstructured or semi-structured documents and converts them into
clean, structured data."* It does not say what the documents are.

So the interesting version is not "extract fields from an invoice" — it is: **here is a
folder, work out what is in it.** Five vendors, and every one of them names the same field
differently:

| Vendor | Number | Date | Customer | Tax |
|---|---|---|---|---|
| Northwind | `Invoice No.` | `Invoice Date` | `Bill To` | `Sales Tax` |
| Blue Harbor | `Inv. Number` | `Date of Issue` | `Sold To` | `VAT` |
| Kestrel | `Reference` | `Raised on` | `Account` | `VAT @ 20%` |
| Meridian | `INVOICE NUMBER` | `DATE` | `CLIENT` | `Tax` |
| Cedarworks | `Invoice` | `Issued` | `Customer` | `GST (18%)` |

`Reference` and `Raised on` share no words with anything else in their columns. Sift merges
all five into one field per column, without a word list and without a model. (The only
vocabulary anywhere in the pipeline is a twelve-entry table of generic English clippings —
`no → number`, `qty → quantity` — and a fallback list used to *name* a group of documents
in the UI, which never fires on this corpus. `decisions.md` §1 is explicit about both.)

[`decisions.md`](decisions.md) has the full reasoning, the alternatives I rejected, and
what I deliberately cut.

---

## How it works

```
PDF ─▶ parse ─▶ analyse ─▶ cluster ─▶ reconcile ─▶ review ─▶ CREATE TABLE
      geometry   labels,    by shape   field names   by hand    typed columns
                 values,                                        real SQL
                 tables
```

**1. Parse — geometry, not text.** Every word gets a box in a single normalised coordinate
space, with page rotation already applied. Words merge into lines; lines split into
*segments* wherever the gap between two words is wide relative to the local font size. That
one primitive covers label/value pairs, table cells and two-column headers, because all
three are the same shape — words, gap, more words. There is no separate table machinery
anywhere in the codebase.

**2. Analyse — what is a label and what is a value.** Answered across the whole pile rather
than per document, because *labels recur and values do not*. `TOTAL` appears on every
receipt; `Warehouse racking` appears on one. Typography settles the rest: a heading is set
larger than the body, and a value is rendered at least as large as its own label — which is
what rescues `Orenda Systems` as the value of `Sold To` rather than a label in its own
right.

**3. Cluster — group by structure, not by names.** Page shape, table count, column count,
log-bucketed row count, and the histogram of value *types*. Grouping by label text puts
every vendor in its own group, which leaves reconciliation nothing to do.

**4. Reconcile — decide that five names are one field.** Five weighted signals — label
similarity with abbreviation expansion, value shape fingerprints (`A+-9+-9+`), value type,
ordinal rank among same-typed fields, page position — with two rules that matter more than
the weights: **a merge needs at least two independent signals**, and **two labels appearing
together in one document can never merge**, checked transitively through the union-find.
That hard constraint is what keeps `Subtotal`, `VAT` and `Total Due` apart despite being
three amounts in the same corner of the same page.

**5. Review — cheap for a human.** Worst-confidence-first, grouped by field, keyboard-driven,
with every value shown on the page it came from.

**6. Build — a real table.** `CREATE TABLE sift.extract_invoices (...)` with `date`,
`numeric(16,2)` and `text` columns. Search and sort in the UI are `WHERE` and `ORDER BY`
against that table, so what you see is what a downstream system would get.

---

## The three problems worth reading the code for

### Two labels that share no words are the same field

`Reference` (Kestrel) and `Invoice No.` (Northwind) have nothing in common as strings. They
merge because every invoice number in the corpus has the shape `A+-9+-9+`, because both are
the first identifier on their page, and because both sit in the same region of it. Two
independent signals agreeing is much harder to fake than one strong one.

Press **Why?** on any field and it prints the actual evidence — not a generated
explanation, the reasons the algorithm used.

<p align="center">
  <img src="docs/screenshots/02-why.png" width="880" alt="The Why panel showing the evidence behind a merge">
</p>

### `03/02/2026` is a different date depending on who sent it

After reconciliation, one `Invoice Date` column contains dates from five vendors who
disagree with each other — Meridian writes month-first, Northwind writes day-first. The
standard answer (resolve the convention per column, from whichever rows prove their own
order) is *wrong* here, because the merged column contains proof of both.

Sift resolves per **source label** instead. The label a value was found under survives
reconciliation as `cells.source_label`, and it is a fingerprint for that vendor's
conventions. `DATE` is Meridian's; `Invoice Date` is Northwind's; each resolves separately.

This took extraction accuracy from **97.8% to 100%**. Where nothing proves the order, the
value is flagged and goes to the top of the review queue rather than being guessed.

### One correction should fix the whole class

Extraction mistakes are not one-offs — they come from a rule that was wrong, so the same
rule was wrong everywhere it applied. Correct one value and Sift classifies *what kind of
edit* it was, finds every other cell the same edit applies to, and shows you the list.

<p align="center">
  <img src="docs/screenshots/04-generalise.png" width="880" alt="After correcting one value, a panel offers to apply the same rule to seven others, showing each before and after">
</p>

Nothing is written until you have seen the exact changes. A one-character edit never
generalises. A rule is refused wherever it would empty a value or strip off the part that
made it typeable, and `read these dates as month-first` never touches a date that proved
its own order.

---

## Uploading

<p align="center">
  <img src="docs/screenshots/09-ingesting.png" width="880" alt="Ingestion in progress: five named stages, the active one spinning with the file it is on, completed ones ticked">
</p>

Ingestion streams its progress back as NDJSON, one line per stage, and the panel names the
stages rather than showing a bar. That is not decoration — it is the honest explanation of
why this cannot be a per-document progress bar. Three of the five stages need the whole
pile at once: you cannot tell a label from a value in one document, because the thing that
distinguishes them is *recurring across documents*.

Non-PDFs are named and ignored rather than silently dropped, files can be removed before
submitting, and a pile can be deleted afterwards — which drops the tables built from it in
the same transaction, because a `CREATE TABLE`d table has no foreign key tying it back to
the pile that produced it and orphaned tables that answer stale queries are worse than no
delete button at all.

---

## Review

<p align="center">
  <img src="docs/screenshots/03-review.png" width="880" alt="The review screen: a queue ordered worst-confidence-first, and the document with the value boxed, its label boxed, and a dotted line between them">
</p>

The queue is ordered by confidence ascending and grouped by field, so you can stop at any
point knowing that everything you did not look at is more confident than everything you
did. Selecting a cell flies it to its position on the page — a shared-element morph on the
Web Animations API — and rows leaving the queue FLIP so the rest slide rather than jump.

The highlight says *what* was extracted. The dotted connector answers *why*: because that
word over there says so.

| Key | |
|---|---|
| `↑` `↓` / `j` `k` | move through the queue |
| `Enter` | confirm |
| `e` | edit |
| `a` | apply a generalised correction |
| `Esc` | cancel |

---

## Query

<p align="center">
  <img src="docs/screenshots/06-data.png" width="880" alt="The committed table: typed columns, right-aligned amounts, ISO dates, and a per-row count of values still unchecked">
</p>

A real table with real types. Search runs as SQL across every column; sorting is
`ORDER BY`. The `unchecked` count on each row is how many of its values are both
low-confidence and unconfirmed by a person — so an analyst can see which rows to trust
without leaving the table, and `WHERE _needs_review = 0` is a usable filter downstream.

A value that will not cast to its column's type becomes `NULL` and is counted as needing
review rather than aborting the build. One bad cell should not cost you the other nine
hundred.

```sql
SELECT bill_to, sum(total_due)
  FROM sift.extract_invoices
 WHERE invoice_date >= '2026-02-01'
 GROUP BY 1 ORDER BY 2 DESC;
```

---

## Accuracy

```bash
npx tsx scripts/dev/accuracy.ts
```

```
invoices in table: 31/31   documents missing: 0
field values checked: 186
correct: 186  (100.0%)
```

The corpus is generated by `scripts/make-corpus.ts` with recorded ground truth, which is
what makes this number checkable rather than asserted. It is seeded, so it is byte-identical
on every machine, and it is not committed to the repo — `npm run setup` builds it.

The harness ingests a private pile of its own from the PDFs, measures it, and deletes it.
That matters for a reason that is easy to miss: reading the demo pile instead would score
*corrected* cells as extraction successes, so every value a person fixed by hand would
quietly inflate the number. This figure is what the extractor does before anyone touches
it. Run it as often as you like — it leaves nothing behind.

The ground truth records each invoice date as ISO as well as in the vendor's own rendering,
so the harness compares the parser against what the vendor *meant* rather than against its
own guess at how to read a slash date.

The corpus deliberately contains the failures I have actually seen in production PDFs:

| | |
|---|---|
| `invoice-northwind-30.pdf` | a page marked rotated 90° while its text was drawn horizontally |
| `statement-36.pdf` | a 46-row table crossing a page break, with no header on the second page |
| `statement-*.pdf` | accounting negatives — `(1312.90)` is −1312.90, and stripping punctuation turns every debit into a credit |
| `invoice-blue-*.pdf` | values split into several text runs by kerning: `BLU`, `-`, `2026`, `-`, `01012` |
| `receipt-*.pdf` | label and value fused into one text item: `Receipt R0400217` |
| `invoice-meridian-*.pdf` | labels above their values, not beside them, and a month-first date convention that disagrees with every other vendor |
| `invoice-kestrel-*.pdf` | a two-column header emitted interleaved in the content stream |
| `letter-*.pdf` | prose, which should produce no schema at all rather than an invented one |

---

## Tests

64 tests. The ones that matter run against the real corpus through the real parser, with
no mocks anywhere.

```
tests/parse.test.ts       reading a PDF the way a person sees it
tests/value.test.ts       typing, money, dates, and knowing when you cannot tell
tests/infer.test.ts       clustering, reconciliation, label/value discrimination, kind naming
tests/generalise.test.ts  what a generalised correction must refuse to do
tests/stream.test.ts      the progress reader, where chunk boundaries fall mid-line
```

They are written to assert on *properties* rather than on coordinates. The page-break test
does not check that page two has rows; it checks that the two pages together account for
every one of the 46 transactions, with none lost or duplicated at the seam. The table test
checks that quantity × unit price equals the amount, which is proof the cells line up
rather than having been shuffled.

The generalisation tests are mostly about what the system must decline to do, because
applying one person's correction to rows they never looked at is the most dangerous thing
in here.

---

## Layout

```
src/lib/parse/      pdf.ts          geometry: words, lines, segments, rotation correction
                    types.ts        the coordinate contract everything else depends on
src/lib/infer/      value.ts        typing and parsing; dates that admit ambiguity
                    fields.ts       labels, values, tables, headings; corpus-level analysis
                    cluster.ts      structural signatures and grouping
                    reconcile.ts    merging field names across sources
src/lib/extract/    ingest.ts       the pipeline; canonicalisation; CREATE TABLE
                    generalise.ts   correction signatures and blast-radius previews
src/lib/db/         schema.ts       the `sift` schema
src/components/     viewer/         pixel-aligned overlays on the rendered page
                    review/         the queue, the morph, the FLIP
                    DataView        the query surface
scripts/            setup.ts        one command to a working demo
                    make-corpus.ts  40 documents with recorded ground truth
                    dev/            probes used while building, and the screenshot walkthrough
```

### Development probes

Small scripts that print what a stage of the pipeline is thinking. They are how the thing
was built and they are the fastest way to answer "why did it do that".

```bash
npx tsx scripts/dev/raw.ts corpus/invoice-blue-12.pdf       # pdf.js text items, unprocessed
npx tsx scripts/dev/probe.ts corpus/invoice-blue-12.pdf     # lines and segments with boxes
npx tsx scripts/dev/fields.ts corpus/invoice-blue-12.pdf    # labels, values and tables found
npx tsx scripts/dev/survey.ts                               # the same across the whole corpus
npx tsx scripts/dev/pairs.ts                                # every merge decision and its score
npx tsx scripts/dev/infer.ts                                # clustering + reconciliation, no database
npx tsx scripts/dev/commit.ts                               # build every kind's table
npx tsx scripts/dev/accuracy.ts                             # measure against ground truth
node scripts/dev/shots.mjs                                  # walk every flow in a real browser
```

`shots.mjs` is both the source of the images in this README and a smoke test of the whole
product — upload, discovery, review, correction, generalisation, query, delete. It fails
the run on any console error in any page.

---

## Deploying

Any host that gives you Node and a Postgres will do. The app needs one environment
variable:

```
SIFT_DATABASE_URL=postgres://user:password@host:5432/dbname
```

The schema is applied on first request, so a fresh database needs no migration step. To
have the deployed instance open on the demo pile rather than an empty screen, run
`npm run setup` once against the same `SIFT_DATABASE_URL`.

```bash
npm run build && npm start        # PORT is respected
```

---

## Stack

Next.js 16 (App Router, React 19), TypeScript in strict mode, Postgres via `pg`,
`pdfjs-dist` for parsing, `pdf-lib` for generating the corpus, Vitest, Playwright for the
screenshots. No UI framework, no component library, no ORM, no CSS-in-JS — the styling is
CSS modules and custom properties.
