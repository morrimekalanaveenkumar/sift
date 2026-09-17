import { withDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const row = await withDb(async (c) => {
    const { rows } = await c.query<{ content: Buffer; filename: string }>(
      `SELECT content, filename FROM documents WHERE id = $1`, [documentId],
    );
    return rows[0];
  });
  if (!row) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(row.content), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      // Documents never change once ingested, so the viewer can cache them hard. This is
      // what lets moving between cells on the same document feel instant.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
