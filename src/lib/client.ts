'use client';

export class ApiError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError('Could not reach the server.');
  }
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new ApiError(text.slice(0, 200)); }
  if (!response.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  get: <T,>(url: string) => request<T>(url),
  post: <T,>(url: string, body?: unknown) =>
    request<T>(url, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  patch: <T,>(url: string, body: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T,>(url: string) => request<T>(url, { method: 'DELETE' }),
};

/**
 * Read an NDJSON stream, calling `onLine` for each line as it arrives.
 *
 * Deliberately not part of `api` above: that returns a parsed body, and the whole point
 * here is that there is no single body. Splitting on newlines has to tolerate a chunk
 * boundary landing mid-line, which is the one thing everybody gets wrong.
 */
export async function stream<T>(
  url: string,
  body: FormData,
  onLine: (line: T) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', body });
  } catch {
    throw new ApiError('Could not reach the server.');
  }

  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = `Request failed (${response.status})`;
    try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* not JSON */ }
    throw new ApiError(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(JSON.parse(line) as T);
    }

    if (done) {
      const rest = buffer.trim();
      if (rest) onLine(JSON.parse(rest) as T);
      return;
    }
  }
}
