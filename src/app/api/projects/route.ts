import { handle } from '@/lib/api';
import { ensureSchema, withDb } from '@/lib/db/client';
import { ingest, type IngestFile, type Progress } from '@/lib/extract/ingest';

export const dynamic = 'force-dynamic';
// Ingestion parses every file before it can analyse any of them, so a large pile takes
// a while. Ask for the longest slice the host allows.
export const maxDuration = 300;

export async function GET() {
  return handle(async () => {
    await ensureSchema();
    return withDb(async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.name, p.status, p.created_at,
                (SELECT count(*) FROM documents d WHERE d.project_id = p.id)::int AS documents,
                (SELECT count(*) FROM kinds k WHERE k.project_id = p.id)::int AS kinds
           FROM projects p ORDER BY p.created_at DESC`,
      );
      return { projects: rows };
    });
  });
}

/**
 * Ingest a pile, streaming progress as it goes.
 *
 * A plain JSON response would be simpler, and for a forty-document pile it would even be
 * fast enough. It is still the wrong answer: a spinner for ten seconds is indistinguishable
 * from a spinner for a hundred, and the stages this thing goes through — parse every
 * document, *then* analyse them together, then group, then reconcile — are the explanation
 * of why it cannot just stream one document at a time. Showing them costs nothing and
 * teaches the user what the system is doing.
 *
 * NDJSON rather than server-sent events: one line per progress report, and the last line
 * carries the result or the error. SSE would give nothing extra here and needs its own
 * client.
 */
export async function POST(request: Request) {
  await ensureSchema();

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim() || 'Untitled pile';
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: 'Add at least one document.' }, { status: 400 });
  }

  // Read the uploads before opening the stream. A failure here should still be an
  // ordinary error response rather than an error buried in a 200.
  const payload: IngestFile[] = [];
  for (const file of files) {
    payload.push({ filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  }

  const projectId = await withDb(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`, [name],
    );
    return rows[0]!.id;
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The client navigated away. Ingestion carries on to completion regardless —
          // half a project in the database is worse than a wasted second of CPU.
        }
      };

      try {
        const result = await ingest(projectId, payload, (p: Progress) => send({ progress: p }));
        send({ done: { projectId, ...result } });
      } catch (e) {
        console.error('[sift:ingest]', e);
        send({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Without this, nginx and friends buffer the whole response and the stream arrives
      // as one lump at the end — which looks exactly like not having built it.
      'X-Accel-Buffering': 'no',
    },
  });
}
