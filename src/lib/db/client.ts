import { Pool, types, type PoolClient } from 'pg';
import { SCHEMA, SCHEMA_SQL } from './schema';

// A Postgres `date` has no time and no timezone, and node-pg turns it into a JavaScript
// Date at local midnight anyway. That is how an invoice dated the 1st arrives in the UI
// as "2026-03-31T18:30:00.000Z" for anyone east of Greenwich. Sift spent a lot of effort
// working out which day a document meant; handing it to a type that cannot represent a
// day would throw that away at the last step. 1082 is `date`.
types.setTypeParser(1082, (value) => value);

let pool: Pool | undefined;

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.SIFT_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'SIFT_DATABASE_URL is not set. Copy .env.example to .env, or run `npm run setup`.',
      );
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Set on the connection rather than qualifying every table name in every query —
      // one line, and no chance of a missed prefix writing to the wrong schema.
      options: `-c search_path=${SCHEMA},public`,
    });
    pool.on('error', (e) => console.error('[sift] idle client error', e));
  }
  return pool;
}

/**
 * Turn `pg`'s connection failures into something a person can act on.
 *
 * Every one of these is a first-five-minutes error, and `pg`'s own wording for them is
 * remarkably unhelpful — "client password must be a string" is what a stock Postgres says
 * when it wants a password and the URL has none, which is a sentence that tells you
 * nothing about what to do next. The three cases below are the three ways setup actually
 * fails, and the setup experience is the first thing anyone judges.
 */
export function explain(e: unknown): unknown {
  const message = e instanceof Error ? e.message : String(e);
  const url = process.env.SIFT_DATABASE_URL ?? '(unset)';
  const hint =
    /password must be a string|no password supplied/i.test(message)
      ? `Postgres is asking for a password and SIFT_DATABASE_URL has none.\n`
        + `  Put one in .env, e.g. postgres://postgres:yourpassword@127.0.0.1:5432/sift`
      : /ECONNREFUSED/i.test(message)
      ? `Nothing is listening at ${url}.\n`
        + `  Start Postgres, or point SIFT_DATABASE_URL at one that is running.`
      : /password authentication failed|role .* does not exist/i.test(message)
      ? `Postgres rejected the credentials in SIFT_DATABASE_URL.\n`
        + `  Check the username and password in .env.`
      : null;

  return hint ? new Error(`${hint}\n  (Postgres said: ${message})`) : e;
}

export async function withDb<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await db().connect();
  } catch (e) {
    throw explain(e);
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withDb(async (c) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

export async function ensureSchema(): Promise<void> {
  // In a transaction so the `SET LOCAL search_path` inside the script applies — outside
  // one it is a no-op and the tables land in `public`.
  await withTx(async (c) => { await c.query(SCHEMA_SQL); });
}
