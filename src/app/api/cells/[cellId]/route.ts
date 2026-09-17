import { handle } from '@/lib/api';
import { withDb, withTx } from '@/lib/db/client';
import {
  classifyCorrection, describeSignature, previewGeneralisation, signatureKey,
} from '@/lib/extract/generalise';
import { typeValue } from '@/lib/infer/value';

export const dynamic = 'force-dynamic';

/**
 * Confirm or correct one cell.
 *
 * A correction does two things: it fixes this value, and it asks whether the same mistake
 * exists elsewhere. The second half returns a *preview* — nothing else is written until
 * the user agrees, because silently rewriting rows somebody never looked at is the one
 * unforgivable behaviour in a tool like this.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ cellId: string }> }) {
  return handle(async () => {
    const { cellId } = await params;
    const body = (await request.json()) as { action: 'confirm' | 'correct'; value?: string };

    return withTx(async (c) => {
      const { rows: existing } = await c.query<{
        id: string; raw: string | null; field_id: string; project_id: string;
      }>(
        `SELECT ce.id, ce.raw, ce.field_id, k.project_id
           FROM cells ce JOIN fields f ON f.id = ce.field_id JOIN kinds k ON k.id = f.kind_id
          WHERE ce.id = $1`,
        [cellId],
      );
      const cell = existing[0];
      if (!cell) throw new Error('Cell not found');

      if (body.action === 'confirm') {
        // Confirming does not change the value; it changes what we know about it. A
        // human looking at something is the strongest evidence available, so confidence
        // goes to certain rather than merely up.
        await c.query(
          `UPDATE cells SET status = 'confirmed', confidence = 1, reviewed_at = now() WHERE id = $1`,
          [cellId],
        );
        return { ok: true, suggestion: null };
      }

      const corrected = (body.value ?? '').trim();
      const typed = typeValue(corrected);
      await c.query(
        `UPDATE cells
            SET corrected_to = $2, value = $3::jsonb, status = 'corrected',
                confidence = 1, reviewed_at = now()
          WHERE id = $1`,
        [cellId, corrected, JSON.stringify(typed.value)],
      );

      const before = cell.raw ?? '';
      const signature = classifyCorrection(before, corrected);
      await c.query(
        `INSERT INTO corrections (project_id, field_id, cell_id, before_raw, after_value, signature)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cell.project_id, cell.field_id, cellId, before, corrected, signatureKey(signature)],
      );

      if (signature.kind === 'manual') return { ok: true, suggestion: null };

      // Look only at cells nobody has reviewed. A value a person already confirmed is
      // not a mistake waiting to be found, whatever a pattern says about it.
      const { rows: siblings } = await c.query<{ id: string; document: string; raw: string | null }>(
        `SELECT ce.id, d.filename AS document, ce.raw
           FROM cells ce JOIN documents d ON d.id = ce.document_id
          WHERE ce.field_id = $1 AND ce.status = 'unreviewed'`,
        [cell.field_id],
      );

      const candidates = previewGeneralisation(signature, siblings, cellId);
      return {
        ok: true,
        suggestion: candidates.length > 0
          ? { signature: signatureKey(signature), description: describeSignature(signature), candidates }
          : null,
      };
    });
  });
}
