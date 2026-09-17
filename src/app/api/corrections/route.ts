import { handle } from '@/lib/api';
import { withTx } from '@/lib/db/client';
import { typeValue } from '@/lib/infer/value';

export const dynamic = 'force-dynamic';

/**
 * Apply a generalised correction to the cells the user just approved.
 *
 * Takes the explicit list of cell ids and their new values rather than re-deriving them
 * from the signature. The user agreed to a specific list of changes they were shown; if
 * anything shifted between the preview and the confirmation, applying a recomputed set
 * would apply something they never saw.
 *
 * The `status = 'unreviewed'` guard in the UPDATE is the same principle at the row level:
 * a cell somebody confirmed in the meantime is left alone.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = (await request.json()) as {
      signature: string;
      changes: { cellId: string; after: string }[];
    };
    if (!body.changes?.length) throw new Error('Nothing to apply');

    return withTx(async (c) => {
      let applied = 0;
      for (const change of body.changes) {
        const typed = typeValue(change.after);
        const { rowCount } = await c.query(
          `UPDATE cells
              SET corrected_to = $2, value = $3::jsonb, status = 'corrected',
                  confidence = 0.95, reviewed_at = now()
            WHERE id = $1 AND status = 'unreviewed'`,
          [change.cellId, change.after, JSON.stringify(typed.value)],
        );
        applied += rowCount ?? 0;
      }
      await c.query(
        `UPDATE corrections SET applied_to = $2
          WHERE id = (SELECT id FROM corrections WHERE signature = $1 ORDER BY created_at DESC LIMIT 1)`,
        [body.signature, applied],
      );
      return { applied };
    });
  });
}
