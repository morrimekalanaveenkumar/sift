/**
 * Grouping a pile of documents into kinds, before anyone says what the kinds are.
 *
 * The obvious approach is to cluster on the labels a document contains: two documents
 * with the same field names are the same kind. It does not work here, and the reason is
 * the whole point of the exercise — five vendors' invoices share almost no label text,
 * so label-based clustering puts every vendor in its own group and there is nothing left
 * for reconciliation to reconcile.
 *
 * So clustering uses **structure**, which the vendors do share: a page of this shape,
 * carrying one table of four columns and a handful of fields whose values are an
 * identifier, two dates, a name and three amounts. A statement has the same table but
 * forty-six rows and two fields; a receipt is a quarter the size with no table; a letter
 * has neither. Those are different kinds under any naming.
 */

import type { ParsedDocument } from '../parse/types';
import type { DocumentFields } from './fields';
import type { ValueType } from './value';

export type DocumentSignature = {
  /** Page shape, bucketed — exact dimensions vary by a point or two and should not split a cluster. */
  shape: string;
  tableCount: number;
  /** Widest table's column count; 0 when there is no table. */
  tableColumns: number;
  /** Bucketed row count: a 5-row line-item table and a 46-row ledger are different kinds. */
  tableRowScale: number;
  fieldCount: number;
  /** How many fields of each value type, which is the closest thing to a fingerprint. */
  typeProfile: Partial<Record<ValueType, number>>;
  narrativeLines: number;
};

export function signatureOf(doc: ParsedDocument, analysis: DocumentFields): DocumentSignature {
  const page = doc.pages[0];
  const w = page?.width ?? 0;
  const h = page?.height ?? 0;

  const widest = analysis.tables.reduce<{ columnCount: number; rows: unknown[] } | null>(
    (best, t) => (!best || t.columnCount > best.columnCount ? t : best),
    null,
  );

  const typeProfile: Partial<Record<ValueType, number>> = {};
  for (const f of analysis.fields) typeProfile[f.type] = (typeProfile[f.type] ?? 0) + 1;

  return {
    shape: `${Math.round(w / 100)}x${Math.round(h / 100)}`,
    tableCount: analysis.tables.length,
    tableColumns: widest?.columnCount ?? 0,
    // Log-bucketed: 5 rows and 7 rows are the same kind of table; 5 and 46 are not.
    tableRowScale: widest ? Math.round(Math.log2(Math.max(1, widest.rows.length))) : 0,
    fieldCount: analysis.fields.length,
    typeProfile,
    narrativeLines: analysis.narrative.length,
  };
}

/** 0–1 agreement between two signatures. */
export function signatureSimilarity(a: DocumentSignature, b: DocumentSignature): number {
  let score = 0;
  let weight = 0;

  const add = (w: number, s: number) => { score += w * s; weight += w; };

  add(2, a.shape === b.shape ? 1 : 0);
  add(2, a.tableColumns === b.tableColumns ? 1 : a.tableColumns === 0 || b.tableColumns === 0 ? 0 : 0.4);
  add(1.5, a.tableRowScale === b.tableRowScale ? 1 : Math.max(0, 1 - Math.abs(a.tableRowScale - b.tableRowScale) / 3));
  add(1, similarCount(a.fieldCount, b.fieldCount));
  add(3, typeProfileSimilarity(a.typeProfile, b.typeProfile));
  add(1, similarCount(a.narrativeLines, b.narrativeLines));

  return weight === 0 ? 0 : score / weight;
}

const similarCount = (a: number, b: number) =>
  a === b ? 1 : 1 - Math.abs(a - b) / Math.max(1, a + b);

function typeProfileSimilarity(
  a: Partial<Record<ValueType, number>>,
  b: Partial<Record<ValueType, number>>,
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ValueType>;
  if (keys.size === 0) return 1;
  // Cosine over the type histogram: robust to one document having an extra field.
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export type Cluster<T> = { id: number; members: T[]; signature: DocumentSignature };

/**
 * Agglomerate documents whose signatures agree.
 *
 * Single-link clustering with a similarity floor, rather than k-means: nobody knows how
 * many kinds are in the pile, and being asked for k is exactly the question the user
 * cannot answer. The floor is the one parameter, and it means "how different do two
 * documents have to be before they are different kinds" — which is a question someone can
 * actually have an opinion about.
 */
export function clusterDocuments<T>(
  items: T[],
  signature: (item: T) => DocumentSignature,
  threshold = 0.82,
): Cluster<T>[] {
  const clusters: Cluster<T>[] = [];

  for (const item of items) {
    const sig = signature(item);
    let best: Cluster<T> | null = null;
    let bestScore = threshold;

    for (const cluster of clusters) {
      const score = signatureSimilarity(sig, cluster.signature);
      if (score >= bestScore) { best = cluster; bestScore = score; }
    }

    if (best) best.members.push(item);
    else clusters.push({ id: clusters.length, members: [item], signature: sig });
  }

  return clusters.sort((a, b) => b.members.length - a.members.length);
}
