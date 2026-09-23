/**
 * From a pile of files to a discovered schema, in one pass.
 *
 * The order matters and is not negotiable: every document has to be parsed before any
 * document can be analysed properly, because telling a label from a value needs the whole
 * pile (see infer/fields.ts). So this is deliberately a batch operation rather than a
 * per-file pipeline — a design constraint that falls straight out of the problem and is
 * worth stating rather than hiding.
 */

import type { PoolClient } from 'pg';
import { parsePdf } from '../parse/pdf';
import { analyseCorpus, selfDescription, type DocumentFields } from '../infer/fields';
import { clusterDocuments, signatureOf, type DocumentSignature } from '../infer/cluster';
import { reconcileFields, type DocumentObservation, type ReconciledField } from '../infer/reconcile';
import { typeColumn, type ValueType } from '../infer/value';
import { withTx } from '../db/client';
import { COLUMN_TYPES, toColumnName, toTableName } from '../db/schema';
import type { ParsedDocument } from '../parse/types';

export type IngestFile = { filename: string; bytes: Uint8Array };

export type Progress = {
  stage: 'parsing' | 'analysing' | 'clustering' | 'reconciling' | 'storing' | 'done';
  done: number;
  total: number;
  message: string;
};

export async function ingest(
  projectId: string,
  files: IngestFile[],
  onProgress?: (p: Progress) => void,
): Promise<{ kinds: number; documents: number; fields: number }> {
  const report = (p: Progress) => onProgress?.(p);

  // --- parse ---------------------------------------------------------------
  const parsed: { filename: string; bytes: Uint8Array; doc: ParsedDocument }[] = [];
  const unreadable: { filename: string; reason: string }[] = [];

  for (const [i, file] of files.entries()) {
    report({ stage: 'parsing', done: i, total: files.length, message: file.filename });
    try {
      // Hand pdf.js a *copy*. It transfers ownership of the array to its worker, which
      // detaches the original — so the bytes we were about to store become a zero-length
      // buffer, and the document renders as "this PDF is empty" long after ingestion
      // looked like it succeeded. The parse works fine either way, which is what makes
      // this one hard to spot.
      parsed.push({ ...file, doc: await parsePdf(new Uint8Array(file.bytes)) });
    } catch (err) {
      // One unreadable file must not lose the other thirty-nine. It is recorded with no
      // pages, which surfaces in the UI as "could not be read" rather than vanishing.
      parsed.push({
        ...file,
        doc: { pageCount: 0, pages: [], charCount: 0 },
      });
      unreadable.push({ filename: file.filename, reason: (err as Error).message });
      console.error(`[sift] could not parse ${file.filename}:`, (err as Error).message);
    }
  }

  // One unreadable file among forty is a bad file. *Every* file unreadable is a broken
  // install, and the two must not look the same from outside. Swallowing both produces
  // the worst possible outcome: a pile with no text clusters into a single kind, gets
  // named "Unstructured documents", and reports success — so the system confidently
  // tells you your invoices are prose. A deployment where the PDF library could not load
  // its fonts did exactly that, and the only trace was a console line nobody reads.
  if (files.length > 0 && unreadable.length === files.length) {
    throw new Error(
      `None of the ${files.length} documents could be read, so there is nothing to `
      + `structure. This usually means the PDF library is not working in this `
      + `environment rather than that the documents are bad. First failure — `
      + `${unreadable[0]!.filename}: ${unreadable[0]!.reason}`,
    );
  }

  // --- analyse (two passes over the whole pile) -----------------------------
  // The whole-pile stages report `total: 1` rather than the document count. They are one
  // operation over all of the documents at once, not a loop, and a counter that says
  // "0/40" for the entire duration of a stage reads as a stall.
  report({ stage: 'analysing', done: 0, total: 1, message: 'finding labels and tables' });
  const analyses = analyseCorpus(parsed.map((p) => ({ id: p.filename, pages: p.doc.pages })));

  // --- cluster -------------------------------------------------------------
  report({ stage: 'clustering', done: 0, total: 1, message: 'grouping into kinds' });
  const items = parsed.map((p) => ({
    ...p,
    analysis: analyses.get(p.filename)!,
    signature: signatureOf(p.doc, analyses.get(p.filename)!),
  }));
  const clusters = clusterDocuments(items, (i) => i.signature);

  // --- reconcile + store ---------------------------------------------------
  report({ stage: 'reconciling', done: 0, total: 1, message: `${clusters.length} kind${clusters.length === 1 ? '' : 's'}` });

  let fieldCount = 0;
  await withTx(async (c) => {
    const takenTableNames = new Set<string>();

    for (const [index, cluster] of clusters.entries()) {
      const obs: DocumentObservation[] = cluster.members.map((m) => ({
        docId: m.filename,
        fields: m.analysis.fields,
        pageWidth: m.doc.pages[0]?.width ?? 595,
        pageHeight: m.doc.pages[0]?.height ?? 842,
      }));
      const { fields } = reconcileFields(obs);

      // Fields carried by only a sliver of the cluster are usually noise rather than an
      // optional field. They are dropped from the schema but the values survive in the
      // cells table, so nothing is lost — it just does not become a column.
      const kept = fields.filter((f) => f.coverage >= 0.15);

      const kindName = nameCluster(cluster.members, index, kept);
      const { rows: kindRows } = await c.query<{ id: string }>(
        `INSERT INTO kinds (project_id, name, signature) VALUES ($1, $2, $3) RETURNING id`,
        [projectId, kindName, JSON.stringify(cluster.signature)],
      );
      const kindId = kindRows[0]!.id;
      toTableName(kindName, takenTableNames);

      const takenColumns = new Set<string>();
      const fieldIds = new Map<string, { id: string; field: ReconciledField }>();
      for (const [position, field] of kept.entries()) {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO fields (kind_id, name, column_name, aliases, type, coverage, rationale, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            kindId, field.name, toColumnName(field.name, takenColumns),
            field.aliases, field.type, field.coverage,
            JSON.stringify(field.rationale), position,
          ],
        );
        fieldIds.set(field.id, { id: rows[0]!.id, field });
        fieldCount++;
      }

      // Resolve each document's raw candidates onto the reconciled fields.
      const labelToField = new Map<string, { id: string; field: ReconciledField }>();
      for (const [, entry] of fieldIds) {
        for (const label of [entry.field.name, ...entry.field.aliases]) labelToField.set(label, entry);
      }

      for (const member of cluster.members) {
        const { rows: docRows } = await c.query<{ id: string }>(
          `INSERT INTO documents (project_id, filename, content, page_count, pages, kind_id, needs_ocr)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            projectId, member.filename, Buffer.from(member.bytes),
            member.doc.pageCount,
            JSON.stringify(member.doc.pages.map((p) => ({
              index: p.index, width: p.width, height: p.height,
              rotation: p.rotation, textRotationCorrected: p.textRotationCorrected,
            }))),
            kindId,
            member.doc.pages.some((p) => p.needsOcr),
          ],
        );
        const documentId = docRows[0]!.id;

        const seen = new Set<string>();
        for (const candidate of member.analysis.fields) {
          const target = labelToField.get(candidate.label);
          if (!target || seen.has(target.id)) continue;
          seen.add(target.id);
          await c.query(
            `INSERT INTO cells (document_id, field_id, raw, confidence, page, box, label_box, source_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (document_id, field_id) DO NOTHING`,
            [
              documentId, target.id, candidate.value, candidate.confidence,
              candidate.page, JSON.stringify(candidate.valueBox), JSON.stringify(candidate.labelBox),
              candidate.label,
            ],
          );
        }

        // A field the schema expects but this document did not supply is recorded as
        // empty rather than omitted. A missing row and a missing value look identical in
        // a join, and only one of them is a fact about the document.
        for (const [, entry] of fieldIds) {
          if (seen.has(entry.id)) continue;
          await c.query(
            `INSERT INTO cells (document_id, field_id, raw, confidence, status)
             VALUES ($1, $2, NULL, 0, 'empty') ON CONFLICT DO NOTHING`,
            [documentId, entry.id],
          );
        }
      }
    }

    await c.query(`UPDATE projects SET status = 'discovered' WHERE id = $1`, [projectId]);
  });

  // --- canonicalise values column by column --------------------------------
  // Done after everything is stored, because deciding whether a column is day-first or
  // month-first needs every value in that column (see infer/value.ts).
  report({ stage: 'storing', done: 0, total: 1, message: 'canonicalising values' });
  await canonicaliseAll(projectId);

  report({ stage: 'done', done: files.length, total: files.length, message: 'ready' });
  return { kinds: clusters.length, documents: files.length, fields: fieldCount };
}

/**
 * Parse every cell of every field into its canonical form.
 *
 * Column-at-a-time rather than cell-at-a-time, because that is the level at which the
 * ambiguous cases resolve: one row with a day over twelve settles the whole column's date
 * convention, and a cell on its own has no way to know.
 */
export async function canonicaliseAll(projectId: string): Promise<void> {
  await withTx(async (c) => {
    const { rows: fields } = await c.query<{ id: string; type: ValueType }>(
      `SELECT f.id, f.type FROM fields f
         JOIN kinds k ON k.id = f.kind_id
        WHERE k.project_id = $1`,
      [projectId],
    );

    for (const field of fields) {
      const { rows: cells } = await c.query<{ id: string; raw: string | null; source_label: string | null }>(
        `SELECT id, COALESCE(corrected_to, raw) AS raw, source_label FROM cells WHERE field_id = $1`,
        [field.id],
      );
      const withValues = cells.filter((r) => r.raw !== null);
      if (withValues.length === 0) continue;

      // Group by the label the value was found under, not by the field as a whole.
      //
      // A reconciled field gathers values from every vendor in the pile, and vendors do
      // not agree on how to write a date. Resolving the convention across the merged
      // column sees proof of both orders, concludes correctly that it cannot tell, and
      // then has to guess — getting four documents wrong in this corpus.
      //
      // The label is the way out. A vendor uses one wording consistently, so all the
      // values under "DATE" came from the same source as each other, and one unambiguous
      // value among them settles the rest. It is the same trick as resolving a column
      // from one row with a day over twelve, applied at the right grain.
      const groups = new Map<string, typeof withValues>();
      for (const cell of withValues) {
        const key = cell.source_label ?? '';
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(cell);
      }

      let unresolvedDates = false;

      for (const [, group] of groups) {
        const { typed, style } = typeColumn(group.map((r) => r.raw!));
        for (const [i, cell] of group.entries()) {
          const t = typed[i]!;
          await c.query(
            `UPDATE cells SET value = $2::jsonb,
                              confidence = GREATEST(confidence * 0.6 + $3 * 0.4, 0)
               WHERE id = $1`,
            [cell.id, JSON.stringify(t.value), t.confidence],
          );
        }
        // A group whose convention could not be settled is only a problem for the values
        // that were actually ambiguous. "09 Feb 2026" names its month and is certain
        // whatever the rest of the column looks like — clamping the whole group would
        // send six hundred perfectly good dates to review and teach the reviewer that the
        // confidence score means nothing.
        //
        // parseDateLoose already scores an unresolved ambiguous date low, so the per-value
        // confidence written above is the right signal on its own.
        if (field.type === 'date' && style === 'unknown') {
          unresolvedDates = group.some((_, i) => (typed[i]?.confidence ?? 1) < 0.5);
        }
      }

      if (unresolvedDates) {
        console.warn(`[sift] date convention unresolved for some values of field ${field.id}`);
      }
    }
  });
}

/**
 * Give a cluster a name a person would recognise.
 *
 * **This is the only place in the codebase that knows what an invoice is, and nothing
 * depends on it.** The clustering, the field discovery and the reconciliation are all
 * domain-blind — they would behave identically on lab reports or shipping manifests. This
 * function exists purely so the UI can say "Invoices" instead of "Kind 1", and every
 * branch falls through to a name derived from the data.
 *
 * The distinction matters. A word list inside the *algorithm* would be a tool that works
 * on documents I happened to think of; a word list inside the *labels* is a convenience
 * that degrades to something sensible when it misses.
 */
/**
 * What should this kind be called?
 *
 * A kind is a structural cluster, so nothing about it carries a name — but the documents
 * in it almost always announce themselves, and `selfDescription` reads that announcement
 * off the page. Requiring the same announcement from most of the cluster is what keeps a
 * one-off from naming the whole pile.
 *
 * The vocabulary check below it is a fallback for documents that announce nothing, and is
 * the only place in Sift where a domain word is hard-coded. It changes what a kind is
 * *called* and nothing about what was extracted — if it is wrong, the user renames it.
 */
function nameCluster(
  members: { filename: string; doc: ParsedDocument }[],
  index: number,
  fields: ReconciledField[],
): string {
  if (fields.length === 0) return 'Unstructured documents';

  const counts = new Map<string, { n: number; text: string }>();
  for (const member of members) {
    const first = member.doc.pages[0];
    const said = first ? selfDescription(first) : null;
    if (!said) continue;
    const key = said.toLowerCase();
    const entry = counts.get(key) ?? { n: 0, text: said };
    entry.n++;
    counts.set(key, entry);
  }

  const recurring = [...counts.values()]
    .filter((c) => c.n >= Math.max(2, Math.ceil(members.length * 0.6)))
    .sort((a, b) => b.n - a.n)[0];
  if (recurring) return pluralise(titleCase(recurring.text));

  const vocabulary = fields.flatMap((f) => [f.name, ...f.aliases]).join(' ').toLowerCase();
  for (const [needle, label] of [
    ['invoice', 'Invoices'], ['receipt', 'Receipts'], ['statement', 'Statements'],
    ['purchase order', 'Purchase orders'], ['policy', 'Policies'], ['report', 'Reports'],
  ] as const) {
    if (vocabulary.includes(needle)) return label;
  }

  // Nothing recognised. Name the kind after the field that best identifies it: the one
  // every document has, preferring an identifier, since that is usually the thing the
  // document *is*. "Consignment No." becomes "Consignment No. documents" — clumsy, and
  // considerably more use than "Kind 3".
  const identifying =
    fields.find((f) => f.coverage >= 0.9 && f.type === 'identifier') ??
    fields.find((f) => f.coverage >= 0.9) ??
    fields[0];
  return identifying ? `${identifying.name} documents` : `Kind ${index + 1}`;
}

/** "ACCOUNT STATEMENT" -> "Account Statement"; leave deliberate mixed case alone. */
const titleCase = (s: string) =>
  s.split(/\s+/)
    .map((w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');

const pluralise = (s: string) =>
  /s$/i.test(s) ? s : /(ch|sh|x|z)$/i.test(s) ? `${s}es` : /[^aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`;

/**
 * Commit a kind's schema: create the real table and fill it.
 *
 * This is the moment the pile becomes data. Everything before it is provisional — the
 * user can rename fields, drop them, change types — and the table is only built once
 * they say so, from whatever the schema looks like at that point.
 */
export async function commitKind(kindId: string): Promise<{ table: string; rows: number }> {
  return withTx(async (c) => {
    const { rows: kindRows } = await c.query<{ id: string; name: string; project_id: string }>(
      `SELECT id, name, project_id FROM kinds WHERE id = $1`,
      [kindId],
    );
    const kind = kindRows[0];
    if (!kind) throw new Error('Kind not found');

    const { rows: fields } = await c.query<{
      id: string; column_name: string; type: string; name: string;
    }>(
      `SELECT id, column_name, type, name FROM fields
        WHERE kind_id = $1 AND included ORDER BY position`,
      [kindId],
    );
    if (fields.length === 0) throw new Error('This kind has no fields to commit.');

    const table = `extract_${kind.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const columns = fields
      .map((f) => `${quote(f.column_name)} ${COLUMN_TYPES[f.type] ?? 'text'}`)
      .join(',\n  ');

    await c.query(`DROP TABLE IF EXISTS ${quote(table)}`);
    await c.query(
      `CREATE TABLE ${quote(table)} (
         document   text NOT NULL,
         ${columns},
         _needs_review integer NOT NULL DEFAULT 0
       )`,
    );

    // Build each row from the cells, casting text to the column's type. A value that
    // will not cast becomes NULL and is counted as needing review rather than aborting
    // the commit — one bad cell should not cost you the other nine hundred.
    const { rows: docs } = await c.query<{ id: string; filename: string }>(
      `SELECT id, filename FROM documents WHERE kind_id = $1 ORDER BY filename`,
      [kindId],
    );

    let inserted = 0;
    for (const doc of docs) {
      const { rows: cells } = await c.query<{
        field_id: string; value: unknown; raw: string | null; corrected_to: string | null;
        confidence: number; status: string;
      }>(
        `SELECT field_id, value, raw, corrected_to, confidence, status
           FROM cells WHERE document_id = $1`,
        [doc.id],
      );
      const byField = new Map(cells.map((r) => [r.field_id, r]));

      const values: unknown[] = [doc.filename];
      for (const f of fields) {
        const cell = byField.get(f.id);
        values.push(cell?.value ?? null);
      }
      const needsReview = cells.filter(
        (r) => r.status === 'unreviewed' && r.confidence < 0.75,
      ).length;
      values.push(needsReview);

      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      await c.query(
        `INSERT INTO ${quote(table)} (document, ${fields.map((f) => quote(f.column_name)).join(', ')}, _needs_review)
         VALUES (${placeholders})`,
        values,
      );
      inserted++;
    }

    await c.query(`UPDATE kinds SET table_name = $2 WHERE id = $1`, [kindId, table]);
    await c.query(`UPDATE projects SET status = 'committed' WHERE id = $1`, [kind.project_id]);

    return { table, rows: inserted };
  });
}

/** Quote an identifier. Table and column names come from user data and cannot be parameterised. */
export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export type { DocumentFields, DocumentSignature };
