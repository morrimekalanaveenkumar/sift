import { ensureSchema, withDb } from '@/lib/db/client';
import { generateCorpus } from '@/lib/corpus/generate';
import { ingest, type Progress } from '@/lib/extract/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Build the demo pile on the server, so a fresh deployment has something to show.
 *
 * Without this, the first thing anyone who opens a deployed URL sees is an empty upload
 * box — a tool that cannot demonstrate itself until the visitor goes and finds forty
 * documents. The seeding step exists either way; putting it behind a button just means
 * the person who runs it doesn't need a checkout and a database URL.
 *
 * The corpus is generated in memory rather than read from disk: `corpus/` is not
 * committed (it is deterministic, so there is nothing to gain from committing 40 PDFs)
 * and a serverless filesystem is read-only anyway.
 *
 * Streams progress in the same NDJSON shape as an upload, so the client reuses one
 * reader and one progress panel.
 */
export async function POST() {
  await ensureSchema();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // Client navigated away. Seeding finishes regardless — a half-ingested demo
          // pile is worse than a wasted second.
        }
      };

      try {
        // Already seeded: hand back the existing pile instead of making a second one.
        // The button is easy to double-click, and two identical demo piles is a
        // confusing result for something whose whole job is explaining itself. This
        // answers in the same NDJSON shape as a real run rather than switching to a
        // plain body, so the client has one protocol to read and not two.
        const existing = await withDb(async (c) => {
          const { rows } = await c.query<{ id: string }>(
            `SELECT id FROM projects WHERE name = 'Demo pile' ORDER BY created_at DESC LIMIT 1`,
          );
          return rows[0]?.id ?? null;
        });
        if (existing) {
          send({ done: { projectId: existing, documents: 0, kinds: 0, fields: 0 } });
          return;
        }

        send({ progress: { stage: 'parsing', done: 0, total: 40, message: 'drawing 40 documents' } });
        const { files } = await generateCorpus();

        const projectId = await withDb(async (c) => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO projects (name) VALUES ('Demo pile') RETURNING id`,
          );
          return rows[0]!.id;
        });

        const result = await ingest(projectId, files, (p: Progress) => send({ progress: p }));
        send({ done: { projectId, ...result } });
      } catch (e) {
        console.error('[sift:demo]', e);
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
      'X-Accel-Buffering': 'no',
    },
  });
}
