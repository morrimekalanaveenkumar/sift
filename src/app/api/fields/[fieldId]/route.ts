import { handle } from '@/lib/api';
import { withDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ fieldId: string }> }) {
  return handle(async () => {
    const { fieldId } = await params;
    const body = (await request.json()) as { name?: string; type?: string; included?: boolean };

    return withDb(async (c) => {
      // COALESCE so a patch can carry one key without clearing the others.
      const { rows } = await c.query(
        `UPDATE fields
            SET name     = COALESCE($2, name),
                type     = COALESCE($3, type),
                included = COALESCE($4, included)
          WHERE id = $1 RETURNING *`,
        [fieldId, body.name ?? null, body.type ?? null, body.included ?? null],
      );
      if (!rows[0]) throw new Error('Field not found');
      return { field: rows[0] };
    });
  });
}
