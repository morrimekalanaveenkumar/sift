import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, stream } from '@/lib/client';

/**
 * The NDJSON reader, tested where it actually breaks.
 *
 * Splitting a stream on newlines is four lines of code and two of them are wrong in most
 * implementations, because a network chunk boundary does not respect line boundaries. The
 * bug only shows up under load or on a slow link — which is to say, in front of the user
 * and never on the developer's laptop — so it is worth pinning down here.
 */

const respond = (chunks: string[], init?: ResponseInit) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, init);
};

const collect = async (chunks: string[]) => {
  const seen: unknown[] = [];
  await stream<unknown>('/api/x', new FormData(), (line) => seen.push(line));
  return seen;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('reading a progress stream', () => {
  it('delivers each line as it arrives', async () => {
    vi.stubGlobal('fetch', async () => respond([
      '{"progress":{"done":1}}\n',
      '{"progress":{"done":2}}\n',
      '{"done":{"projectId":"p1"}}\n',
    ]));

    expect(await collect([])).toEqual([
      { progress: { done: 1 } },
      { progress: { done: 2 } },
      { done: { projectId: 'p1' } },
    ]);
  });

  it('survives a chunk boundary landing in the middle of a line', async () => {
    // The whole point. A naive reader parses `{"progress":{"do` and throws.
    vi.stubGlobal('fetch', async () => respond([
      '{"progress":{"do',
      'ne":1}}\n{"progress":',
      '{"done":2}}\n',
    ]));

    expect(await collect([])).toEqual([
      { progress: { done: 1 } },
      { progress: { done: 2 } },
    ]);
  });

  it('delivers a final line that arrives without a trailing newline', async () => {
    // The server closes the stream after its last write. Dropping the tail loses the one
    // line that carries the result, so the upload appears to hang at 100%.
    vi.stubGlobal('fetch', async () => respond(['{"done":{"projectId":"p1"}}']));
    expect(await collect([])).toEqual([{ done: { projectId: 'p1' } }]);
  });

  it('does not choke on blank lines or a chunk that is only a newline', async () => {
    vi.stubGlobal('fetch', async () => respond(['{"a":1}\n', '\n', '\n{"b":2}\n']));
    expect(await collect([])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reads a multi-byte character split across two chunks', async () => {
    // "…" is three bytes in UTF-8. Decoding each chunk independently turns a split one
    // into replacement characters, which is why the decoder is used in streaming mode.
    const bytes = new TextEncoder().encode('{"m":"canonicalising…"}\n');
    vi.stubGlobal('fetch', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 22));
          controller.enqueue(bytes.slice(22));
          controller.close();
        },
      });
      return new Response(body);
    });

    expect(await collect([])).toEqual([{ m: 'canonicalising…' }]);
  });

  it('raises the server’s own message when the request is refused', async () => {
    vi.stubGlobal('fetch', async () =>
      respond(['{"error":"Add at least one document."}'], { status: 400 }));

    await expect(collect([])).rejects.toThrow(ApiError);
    await expect(collect([])).rejects.toThrow('Add at least one document.');
  });

  it('says something useful when the server cannot be reached at all', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await expect(collect([])).rejects.toThrow('Could not reach the server.');
  });
});
