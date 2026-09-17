import { handle } from '@/lib/api';
import { withDb, withTx } from '@/lib/db/client';
import { quote } from '@/lib/extract/ingest';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handle(async () => {
    const { projectId } = await params;
    return withDb(async (c) => {
      const { rows: projects } = await c.query(
        `SELECT id, name, status, created_at FROM projects WHERE id = $1`, [projectId],
      );
      if (!projects[0]) throw new Error('Project not found');

      // One query for the whole overview. The review counts are the numbers a person
      // actually looks at, so they are computed here rather than derived in the client
      // from a list it would otherwise have to fetch in full.
      const { rows: kinds } = await c.query(
        `SELECT k.id, k.name, k.table_name,
                (SELECT count(*) FROM documents d WHERE d.kind_id = k.id)::int AS documents,
                (SELECT count(*) FROM fields f WHERE f.kind_id = k.id AND f.included)::int AS field_count,
                (SELECT count(*) FROM cells ce JOIN fields f ON f.id = ce.field_id
                  WHERE f.kind_id = k.id AND ce.status = 'unreviewed' AND ce.confidence < 0.75)::int AS needs_review,
                (SELECT count(*) FROM cells ce JOIN fields f ON f.id = ce.field_id
                  WHERE f.kind_id = k.id)::int AS cell_count
           FROM kinds k WHERE k.project_id = $1
          ORDER BY (SELECT count(*) FROM documents d WHERE d.kind_id = k.id) DESC`,
        [projectId],
      );

      const { rows: fields } = await c.query(
        `SELECT f.id, f.kind_id, f.name, f.column_name, f.aliases, f.type,
                f.coverage, f.rationale, f.position, f.included
           FROM fields f JOIN kinds k ON k.id = f.kind_id
          WHERE k.project_id = $1 ORDER BY f.kind_id, f.position`,
        [projectId],
      );

      return { project: projects[0], kinds, fields };
    });
  });
}

/**
 * Delete a pile and everything derived from it.
 *
 * The foreign keys cascade, so one `DELETE FROM projects` clears the documents, kinds,
 * fields, cells and corrections. What they cannot clear is the tables Sift *built* —
 * `sift.extract_invoices` is a real table created by `CREATE TABLE`, and no constraint
 * ties it back to the project that produced it. Leaving those behind is how a database
 * accumulates orphaned tables that look like real data and answer stale queries, which
 * is worse than not offering delete at all.
 *
 * In a transaction, because dropping half the tables and then failing would leave exactly
 * the mess this is meant to avoid.
 */
export async function DELETE(_: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handle(async () => {
    const { projectId } = await params;
    return withTx(async (c) => {
      const { rows } = await c.query<{ table_name: string | null }>(
        `SELECT table_name FROM kinds WHERE project_id = $1 AND table_name IS NOT NULL`,
        [projectId],
      );
      for (const row of rows) {
        if (row.table_name) await c.query(`DROP TABLE IF EXISTS ${quote(row.table_name)}`);
      }
      const { rowCount } = await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      if (!rowCount) throw new Error('Project not found');
      return { deleted: true, tablesDropped: rows.length };
    });
  });
}
