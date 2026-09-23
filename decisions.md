# Decisions

What I chose, what I chose against, and what I deliberately did not build.

---

## 1. Reading the problem

> **Turn messy documents into structured, queryable data.** Build a system that takes
> unstructured or semi-structured documents and converts them into clean, structured data
> that can be searched and queried.

There are two ways to read that statement, and they are very different projects.

**The easy reading.** Pick a document type — invoices, say — write down the fields an
invoice has, and extract them. This is a solved shape of problem. You end up with a list
of field names, a pile of regular expressions or an LLM prompt containing that same list,
and a system that works beautifully until someone uploads a delivery note.

**The hard reading.** The statement does not say what the documents are. So: accept an
arbitrary pile, work out **what kinds of document are in it**, work out **what fields each
kind has**, and only then extract. The schema is an output, not an input.

I built the hard reading. Nothing that decides *what gets extracted* knows anything about
invoices. There are exactly two places where domain-ish words appear at all, and both are
worth naming so you can judge them:

- **`nameCluster`'s fallback word list** (`invoice`, `receipt`, `statement`, …). It decides
  what a group of documents is *called* in the UI and nothing else. It is a last resort
  behind a rule that reads the document type off the page, and on this corpus it never
  fires.
- **A twelve-entry abbreviation table** in label normalisation: `no → number`,
  `qty → quantity`, `inv → invoice`. These are the generic clippings any English form uses.
  The temptation is to keep adding entries until the corpus passes, at which point the list
  *is* the algorithm — so the table is deliberately small and contains no invoice
  vocabulary beyond expanding a clipping back to its own word.

Everything else — which documents are the same kind, which labels mean the same field, what
type a value is, which date convention a vendor uses — is derived from the pile.

This is the main decision in the project and everything below follows from it.

### Why that reading is worth the extra work

The easy reading fails on the thing that actually happens in a business. Nobody has a
folder of one document type. They have a folder, and in it are invoices from five vendors,
some receipts, a bank statement and two letters, and the five vendors call the invoice
number five different things:

| Vendor | Number | Date | Customer | Tax |
|---|---|---|---|---|
| Northwind | `Invoice No.` | `Invoice Date` | `Bill To` | `Sales Tax` |
| Blue Harbor | `Inv. Number` | `Date of Issue` | `Sold To` | `VAT` |
| Kestrel | `Reference` | `Raised on` | `Account` | `VAT @ 20%` |
| Meridian | `INVOICE NUMBER` | `DATE` | `CLIENT` | `Tax` |
| Cedarworks | `Invoice` | `Issued` | `Customer` | `GST (18%)` |

`Reference` and `Raised on` share no words with anything else in their columns. A person
reads that table and sees five names for one thing instantly. Getting a machine to agree,
without telling it what an invoice is, is the interesting sub-problem — and it is the one
the brief asks for when it says *"solve a hard sub-problem most people would skip."*

### What "queryable" was taken to mean

Literally. Not "searchable text" and not a JSON blob with a filter box over it, but a real
Postgres table with real column types — `date`, `numeric(16,2)`, `text` — that you can
point any SQL tool at. The search and sort in the UI are `WHERE` and `ORDER BY` against
that table, not array operations in the browser, precisely so that what you see in the app
is the same thing a downstream system would see.

---

## 2. No LLM in the extraction path

The brief permits AI tools, and a model would do a respectable job here. I did not use one
for extraction, and this is a deliberate decision rather than an omission.

**Why not:**

- **It answers the wrong question.** "Can a model read an invoice" is settled. "What is the
  structure of this pile, and how do I know" is not, and that is where the engineering is.
  Prompting a model would have produced a thinner project with nothing to reason about.
- **It cannot show its work.** Every field in the UI has a *Why?* button that prints the
  actual evidence for the decision: which labels merged, on what grounds, with what score.
  That comes from the reconciliation algorithm having reasons. A model's answer is a
  different kind of object — you can ask it to write an explanation, but the explanation is
  generated after the fact and is not what drove the result.
- **Determinism.** The same pile produces the same schema every time, so a test can assert
  on it and a regression is visible. 64 tests would be considerably less useful against a
  sampled output.
- **Cost and latency.** The full 40-document pile ingests in about **1.5 seconds** on a
  laptop. Per-document model calls would be two orders of magnitude slower and would meter.

**Where a model genuinely belongs, and where I would add one:**

- **OCR** for scanned documents. Sift detects a page with no text layer and says so
  (`needsOcr`) rather than silently returning nothing; that flag is the seam.
- **Naming.** `nameCluster` and the canonical name chosen for a merged field are cosmetic
  and a model would name them better than my heuristic does.
- **The last mile of reconciliation.** Pairs that score just under the merge threshold
  could be handed to a model as a tie-breaker, with the deterministic signals still doing
  the bulk of the work and the model's answer recorded as one more piece of evidence.

The structure of the code makes this straightforward: reconciliation already returns a
score with reasons, so an extra scorer slots in beside the existing ones.

---

## 3. Cluster on structure, not on field names

**Decision:** documents are grouped into kinds by a structural signature — page shape,
number of tables, widest table's column count, log-bucketed row count, field count, the
histogram of value *types*, and how many lines are prose.

**The alternative I rejected:** group by the set of labels a document contains. This is the
obvious approach, and on this corpus it puts every vendor in its own group — at which point
there is nothing for reconciliation to do, and the system has quietly become five
single-vendor extractors in a trench coat.

The five vendors share almost no label text. What they *do* share is shape: A4, one table
of four columns with a handful of rows, seven fields whose values are an identifier, two
dates, a name and three amounts. A bank statement has the same four-column table and
forty-six rows; a receipt is a quarter the size with no table at all; a letter has neither.
Those are different kinds under any naming scheme, and the same kind across any vendor.

The row count is log-bucketed rather than exact, because a 5-row line-item table and a
7-row one are the same kind of document, and a 5-row and a 46-row one are not.

---

## 4. Reconciling field names: five signals and one hard constraint

Once documents are grouped, their labels have to be merged. Sift scores every pair of
labels and unions the ones that clear a threshold. The signals:

| Signal | Weight | What it catches |
|---|---|---|
| Label token similarity, with abbreviation expansion | 0.45 (gate at 0.15) | `Invoice No.` ↔ `Inv. Number` |
| Value shape fingerprint (`A+-9+-9+`) | 0.18 | `Reference` ↔ `Invoice No.` — every invoice number looks alike whatever it is called |
| Same value type | 0.12 | weak on its own, useful with others |
| Ordinal rank among same-typed fields | 0.30 / 0.18 | the first of three amounts plays the same role on every vendor's page |
| Mean position on the page | ×0.15 | invoices are designed by people who have all seen invoices |

Two further rules matter more than the weights:

**A merge needs at least two independent signals.** One strong signal is how you get
`Subtotal` merged with `Total Due` — both money, both bottom-right, similar shapes. Two
unrelated signals agreeing is much harder to fake.

**Co-occurrence is a hard veto.** If two labels appear together in a single document, they
are definitely different fields, and no amount of score overrides that. This is the one
inviolable constraint in the system and it is what keeps `Subtotal`, `VAT` and `Total Due`
apart despite being three amounts in the same corner of the same page.

The veto is checked **transitively**, through the union-find, before each union. Merging A
with B when B is already grouped with C means A and C are now the same field too, so C's
co-occurrences have to be checked as well. Skipping that was a real bug: the constraint
held for every pair and still let a forbidden group form.

---

## 5. Labels recur across the pile; values do not

**Decision:** deciding whether a piece of text is a label or a value is a *corpus-level*
question, answered in two passes over the whole pile, not a per-document one.

Consider a receipt:

```
Marlow Stationery
Receipt R0400217
04/02/2026
Warehouse racking        47.87
Cold chain gel packs    572.06
TOTAL                  1122.84
```

Read one document in isolation and `Warehouse racking` is a perfectly good label with
`47.87` as its value. Read five and the answer is obvious: `TOTAL` appears on all of them
and `Warehouse racking` appears on one. Labels are the part the vendor's template prints;
values are the part that changes. So the first pass collects which strings recur across
documents, and the second pass uses that to decide.

Typography does the rest. Two further rules, neither of which knows any vocabulary:

- **A heading is not a label.** The shop name at the top of a receipt is short text sitting
  directly above another value — structurally identical to a label, until you notice it is
  set in 11pt on a page whose body is 8pt.
- **A value is rendered at least as large as its own label.** This is what rescues
  `Orenda Systems` as the value of `Sold To`. Asked in isolation, every customer name in
  the corpus looks like a label, and the customer field disappears from every document.

The same typographic rule, turned around, is how a kind gets its name: the largest text on
the page is the letterhead, and the line directly under it is the document saying what it
is — `INVOICE`, `Account Statement`, `Receipt R0400217`. That is derived, not looked up,
which is why the fallback word list exists but almost never fires.

---

## 6. Dates are resolved per source, not per column

`03/02/2026` is the 3rd of February or the 2nd of March and nothing in the string settles
it. Sift's answer has three levels:

1. **Per value.** If either component is over 12 the order is proved. Mark it resolved.
2. **Per column.** One proved row settles every ambiguous row in the same column.
3. **Per source label.** ← this one is the interesting bit.

Level 2 is the standard answer and it is wrong here. After reconciliation, one
`Invoice Date` column contains dates from five vendors who disagree with each other —
Meridian writes `02/27/2026` (month first), Northwind writes `19/01/2026` (day first). The
merged column therefore contains proof of *both* conventions, and any single answer for the
column is wrong for some of its rows.

So the resolution key is the **label the value was found under**, which survives
reconciliation as `cells.source_label`. `DATE` is Meridian's convention; `Invoice Date` is
Northwind's. Each resolves independently and correctly.

Concretely: this took extraction accuracy from **97.8% to 100%**. The four wrong values
were all Meridian dates that the merged column had out-voted.

Where nothing proves the order, Sift says so — the value is flagged, its confidence drops,
and it goes to the top of the review queue. Guessing gets it right about half the time and
never tells you which half.

---

## 7. One correction should fix the whole class

**Decision:** when a user corrects a value, classify *what kind of edit it was*, find every
other cell the same edit would apply to, and show them the list before changing anything.

Extraction mistakes are almost never one-offs. They come from a rule that was wrong, so the
same rule was wrong everywhere it applied. A person who corrects `Halcyon Retail Pvt Ltd`
to `Halcyon Retail` has not fixed one cell; they have said something true about seven.
Making them say it seven more times is the actual cost of most document tools.

The signature describes the edit, not the result: `remove the trailing " Pvt Ltd"`
generalises; `set it to "Halcyon Retail"` generalises to nothing. Five kinds are recognised
— strip prefix, strip suffix, strip both, date convention, and manual (which generalises to
nothing on purpose).

**The design is deliberately timid,** because the failure mode is much worse than the
inconvenience it saves:

- Nothing is written until the user has seen the exact list of changes. "We also changed 47
  things you did not look at" is only acceptable when they were shown the 47 first.
- A one-character edit never generalises — `remove the trailing "."` would match half of
  any corpus.
- A rule is refused on any cell where it would empty the value, or strip off the part that
  made the value typeable (`INV-2026-01042` → `INV` turns an identifier into a word).
- `read these dates as month-first` never touches a date that proved its own order.
  `13/02/2026` was never in doubt; rewriting it would invent a date.
- Cells somebody already confirmed are excluded, and the `UPDATE` re-checks that at the row
  level in case something changed between the preview and the click.
- The applied set comes from the explicit list the user approved, not from re-deriving the
  matches. If anything shifted in between, the recomputed set is not what they agreed to.

---

## 8. The parsing decisions that are not obvious

These cost the most time and none of them are visible in the UI.

**pdf.js reports `item.width` and `item.height` in user space, while the corners have to be
supplied in text space** because the transform will scale them. Transforming the reported
values directly re-applies the font scale: a 17pt heading gets a box 289pt tall, sitting
289pt above its baseline, and every line on the page overlaps every other. Dividing by the
matrix scale first is a two-line fix that took a long time to see, because text extraction
looks perfect the whole time — only the geometry is wrong, and the geometry is what the
entire layout analysis runs on.

**pdf.js detaches the buffer you hand it.** It transfers ownership of the array to its
worker, so the bytes you were about to store become a zero-length buffer. The parse
succeeds, ingestion reports success, and the document renders as "this PDF is empty" in the
viewer minutes later. Pass a copy.

**Segments, not columns.** My first layout pass detected column gutters and split lines on
them. It works on a two-column header and destroys an ordinary invoice, where the gap
between a description and its amount looks exactly like a gutter. The replacement is local:
inside a line, split wherever the gap between two words is wide relative to the local font
size. That one primitive handles label/value pairs, table cells and two-column headers,
because all three are the same shape — words, gap, more words — and there is no separate
table machinery anywhere in the codebase.

**`/Rotate` tells you how to turn the paper, not which way the text runs.** A scanner marks
a page rotated while the text was drawn horizontally; apply the rotation and the text now
runs vertically, and a page that should yield sixteen lines yields four. Sift measures the
dominant text direction from the text matrices themselves, weighted by run length, and
corrects the viewport against it. The viewer is handed the same corrected rotation the
parser used, so overlay boxes land on the right pixels.

**Fused label and value.** `Receipt R0400217` arrives as one text item, so there is no word
boundary to split on. Sift splits *inside* the item, interpolating the box by character
count, and scores each candidate cut by how confidently the tail types as a value — which
is how `Amount Payable INR 171120.70` cuts before `INR` (INR-qualified money, 0.95) rather
than after it (bare number, 0.7).

---

## 9. Three deployment traps worth writing down

**A CSS module re-exported from a client component silently disappears in a server one.**
`Shell.tsx` is a `'use client'` file and it used to end with `export { styles as shell }`,
which every client component imported happily. The home page is a *server* component, and
when a server component imports a value from a client module React hands it a client
reference proxy rather than the object — so `shell.wrap`, `shell.panel` and `shell.h1` all
evaluated to `undefined` and the page rendered with no classes at all. No error, no
warning, and it only affected the one page that crossed the boundary that way, so every
other screenshot looked correct. The fix is to import `shell.module.css` directly wherever
it is used; the re-export is gone and there is a comment in `Shell.tsx` saying why.

**A connection pooler rejects `options: -c search_path=...`.** Setting the schema as a
connection option is the neat way to do it, and it works perfectly against a Postgres you
connect to directly — which is every Postgres I tested against. PgBouncer, which sits in
front of Neon and most hosted Postgres, refuses unknown startup parameters outright, so
the first deployment came up with *"unsupported startup parameter in options:
search_path"*.

The obvious repair is worse than the bug: issuing `SET search_path` once per checkout
fails *silently*. A pooler in transaction mode hands each transaction whichever server
connection is free, so the setting applies to a connection the next query may not get. It
works on a quiet machine and starts losing tables under load. `SET LOCAL` inside a
transaction is the version that holds everywhere, because the transaction pins one server
connection for its whole life — so every database access is now transactional, including
reads, which are cheap and arguably should have been anyway.

**Streamed responses need `X-Accel-Buffering: no`.** Without it a reverse proxy buffers the
whole NDJSON body and delivers it in one lump at the end, which looks exactly like not
having built progress reporting at all — and looks that way only in deployment.

---

## 10. Ingest streams its progress

**Decision:** `POST /api/projects` returns NDJSON — one line per progress report, the last
line carrying the result or the error — rather than a single JSON body at the end.

A plain response would be simpler, and for a forty-document pile it is even fast enough.
It is still the wrong answer, for a reason specific to this system: a spinner for ten
seconds is indistinguishable from a spinner for a hundred, and the stages this thing goes
through are the explanation of why it *cannot* report per-document progress. Three of the
five need the whole pile at once. Naming them turns an unavoidable wait into an
explanation of the method.

Two details that are easy to get wrong and are tested (`tests/stream.test.ts`): a network
chunk boundary does not respect line boundaries, so the reader buffers across chunks; and
the decoder runs in streaming mode, because a three-byte `…` split across two chunks
otherwise decodes as replacement characters. Both fail only under load — which is to say,
in front of the user and never on the developer's laptop.

Ingestion also finishes even if the client navigates away. Half a project in the database
is worse than a wasted second of CPU.

---

## 11. Deleting a pile drops the tables it built

The foreign keys cascade, so one `DELETE FROM projects` clears documents, kinds, fields,
cells and corrections. What they cannot clear is what Sift *created*: `sift.extract_invoices`
is a real table made by `CREATE TABLE`, and no constraint ties it back to the project that
produced it. Leaving those behind is how a database accumulates orphaned tables that look
like real data and answer stale queries — worse than not offering delete at all. So the
delete handler drops each kind's table first, in the same transaction.

Confirmation is a second click on the same button rather than `confirm()`. A browser dialog
is modal, unstyled, and cannot be dismissed the way the rest of this UI can; "Delete, then
Delete everything" is the same two decisions without any of that.

---

## 12. A deployment seeds itself

The first thing anyone who opens a deployed URL used to see was an empty upload box: a tool
that cannot demonstrate itself until the visitor goes and finds forty documents. For a
take-home that is the wrong first frame, and for a real product it is worse.

So the corpus generator moved out of `scripts/` and into `src/lib/corpus/generate.ts`, and
an empty database now offers **Load the 40-document demo pile** — generated on the server
and ingested in about a second, streaming the same progress panel a real upload uses.

Three details that made it work rather than half-work. The corpus is generated in memory
rather than read from disk, because `corpus/` is not committed (it is deterministic, so
there is nothing to gain from committing forty PDFs) and a serverless filesystem is
read-only anyway. `pdf-lib` therefore moved from devDependencies to dependencies, since it
now runs in the deployed app. And the route answers in NDJSON even in the already-seeded
case, where there is nothing to stream — my first version returned a plain JSON body there
and special-cased it in the client, which promptly broke three stream tests. One protocol is
worth more than the four lines it saves.

---

## 13. A pile that reads as nothing is an error, not a finding

The first working deployment produced a confident wrong answer: forty invoices, receipts
and statements, clustered into a single kind named **"Unstructured documents"**, zero
fields, reported as a success.

The cause was two bugs stacked, and the second is the interesting one.

**The proximate cause.** `standardFontDataUrl` pointed pdf.js at its bundled copy of the
fourteen standard PDF fonts. Those are data files that nothing imports, so dependency
tracing does not follow them and the deployed build had the package without the
directory. Handing pdf.js a path that is not there is *worse* than handing it nothing: it
fails to load a font and the whole text extraction rejects. Every page came back empty.
Fixed by checking the directory exists before using it, and by naming the fonts in
`outputFileTracingIncludes` so they are actually deployed.

**The real bug.** The parse loop caught per-file failures and recorded an empty document,
so that one bad file among forty would not lose the other thirty-nine. That is right. But
it made "one bad file" and "nothing works at all" indistinguishable from outside — and
when everything fails, a pile with no text legitimately clusters into one kind, gets named
"Unstructured documents" by a rule that is behaving correctly, and reports success. Every
layer did its job and the system told the user their invoices were prose.

So: if *every* file fails, ingestion now throws and says so, naming the first failure and
pointing at the environment rather than the documents. The only trace before was a
`console.error` in a serverless log nobody reads.

The general lesson is about where to put tolerance. Per-item error recovery is good; the
same recovery applied to *every* item is a system that cannot tell success from total
failure. Anything that swallows errors per item needs a check on the aggregate.

---

## 14. Product decisions

**Show the document, not a form.** Every value in the review queue is shown on the page it
came from, with the value boxed, its label boxed, and a dotted line between them. The
highlight says *what* was extracted; the connector answers *why* — because that word over
there says so. Nothing else in the UI is as convincing about whether an extraction is
right.

**Worst first.** The queue is ordered by confidence ascending and grouped by field. Reviewing
in document order means reading forty documents to find four mistakes. A user should be
able to stop reviewing at any point and know that everything they did not look at is more
confident than everything they did.

**The keyboard is the interface.** `↑ ↓` / `j k` move, `Enter` confirms, `e` edits, `a`
applies a generalised correction. Review is the repetitive part of this job and a mouse
makes it slower.

**The schema is editable before it is built.** Discovery is a proposal, not a fact. You can
rename a field, change its type, drop it entirely — and only then click *Build table*. A
system that guesses your schema and immediately commits to it is a system you cannot
correct.

**Motion carries meaning or it does not ship.** Selecting a cell flies it to its position on
the page (a shared-element morph, hand-rolled on the Web Animations API), so the
relationship between list and document is shown rather than asserted. Rows leaving the
queue FLIP so the remaining ones slide instead of jumping. There are no decorative
transitions.

**Hold position while a suggestion is open.** Correcting a value normally advances to the
next one. It does not while the generalisation panel is up, because otherwise the panel
talks about one document while the viewer shows the next, and the user cannot judge the
rule against the wrong page.

---

## 15. What I deliberately cut

- **OCR.** A page with no text layer is detected and reported as needing OCR rather than
  silently returning nothing. Wiring in Tesseract is a day of plumbing and would not have
  taught the reviewer anything about how I think.
- **Authentication, multi-tenancy, background jobs.** Ingest is synchronous. At 1.5 seconds
  for 40 documents that is the correct trade for a demo; at 10,000 documents it is a queue,
  which is a known shape of problem and not this problem.
- **Handwriting, checkboxes, signature detection.** Different problem.
- **A join model across kinds.** Each kind becomes its own table. Relating invoices to the
  statement that paid them is real work and a different project.
- **Learning across piles.** Corrections are stored with their signatures, and using them
  to pre-empt the same mistake in the *next* upload is the obvious next feature. I built
  the storage and stopped there, because the within-pile version is what demonstrates the
  idea.
- **A hosted OCR-quality corpus.** The 40 test documents are generated by
  `scripts/make-corpus.ts` with known ground truth, which is what makes the 100% accuracy
  number checkable rather than asserted. Real scanned PDFs would be more impressive and
  less measurable.
- **Charts, exports, saved views.** The table is queryable by SQL; a BI tool does this
  better than I would in the time.
- **Editing the pile after ingest.** You can add a pile or delete one; you cannot add three
  more documents to an existing pile. Re-ingesting incrementally means deciding whether the
  new documents should be allowed to change the discovered schema, which is a genuinely
  interesting question and not a small one.

---

## 16. Known limits

- **Accuracy is measured against a generated corpus.** 186/186 on invoices is a real
  number, checked by a harness that rebuilds the table from the current schema every run so
  it cannot pass against stale data — but the corpus was written by me, and a corpus written
  by me is a corpus whose difficulties I chose. It includes a rotated scan, a table
  spanning a page break, accounting negatives, mixed date conventions, kerning-split text
  runs and fused label/value runs, which are the failures I have actually seen. It does not
  include a genuinely adversarial layout.
- **Structural clustering is sensitive to page size.** Two documents that are the same kind
  on A4 and Letter will bucket the same way, but an unusual format could split a cluster.
  The fix is to let the user merge kinds in the UI; it is not built.
- **Reconciliation thresholds are tuned on one corpus.** The signals are principled; the
  weights are fitted. On a very different pile they would need retuning, which is a real
  limitation and the strongest argument for adding a model as a tie-breaker.
- **Only one table per kind.** A document with two unrelated tables keeps the widest.
- **`nameCluster` has a hardcoded word list** as a last resort. It affects a caption.
