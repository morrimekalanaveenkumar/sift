import { NextResponse } from 'next/server';

/**
 * One error shape for the whole API, and errors passed through verbatim.
 *
 * The messages this system produces are written for people — "the date convention in this
 * column could not be resolved" — and replacing them with a generic 500 would throw away
 * the most useful thing the backend knows.
 */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sift:api]', err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
