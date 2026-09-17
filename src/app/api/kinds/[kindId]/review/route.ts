import { handle } from '@/lib/api';
import { withDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * The review queue.
 *
 * Ordered by confidence ascending: the least certain value is the one most worth a
 * human's attention, and a queue that opens on the worst thing in the pile is a queue
 * people finish. Documents are returned alongside so the viewer can prefetch the next
 * one — moving between cells should never wait on a download.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kindId: string }> }) {
  return handle(async () => {
    const { kindId } = await params;
    const url = new URL(request.url);
    const includeReviewed = url.searchParams.get('all') === '1';

    return withDb(async (c) => {
      const { rows: cells } = await c.query(
        `SELECT ce.id, ce.raw, ce.corrected_to, ce.value, ce.confidence, ce.page,
                ce.box, ce.label_box, ce.status, ce.source_label,
                f.id AS field_id, f.name AS field_name, f.type AS field_type,
                d.id AS document_id, d.filename, d.pages
           FROM cells ce
           JOIN fields f ON f.id = ce.field_id
           JOIN documents d ON d.id = ce.document_id
          WHERE f.kind_id = $1 AND f.included
            AND ($2 OR (ce.status = 'unreviewed' AND ce.confidence < 0.75))
          ORDER BY ce.confidence ASC, d.filename, f.position`,
        [kindId, includeReviewed],
      );

      const { rows: summary } = await c.query(
        `SELECT
            count(*) FILTER (WHERE ce.status = 'unreviewed' AND ce.confidence < 0.75)::int AS pending,
            count(*) FILTER (WHERE ce.status IN ('confirmed','corrected'))::int AS reviewed,
            count(*)::int AS total
           FROM cells ce JOIN fields f ON f.id = ce.field_id
          WHERE f.kind_id = $1 AND f.included`,
        [kindId],
      );

      return { cells, summary: summary[0] };
    });
  });
}
