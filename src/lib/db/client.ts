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

/**
 * Check out a connection, put it on the right schema, and run everything in one
 * transaction.
 *
 * The schema part used to be a connection option — `options: -c search_path=sift,public`
 * — which is the neat way to do it and works perfectly against a Postgres you connect to
 * directly. It does not survive a connection pooler. PgBouncer, which is what sits in
 * front of Neon and most hosted Postgres, rejects unknown startup parameters outright:
 *
 *     unsupported startup parameter in options: search_path
 *
 * The obvious repair — issue `SET search_path` once per checkout — is worse, because it
 * fails silently rather than loudly. A pooler in *transaction* mode hands each
 * transaction whichever server connection is free, so a session-level SET applies to a
 * connection that the next query may not get. It works on a quiet machine and starts
 * losing tables under concurrency, which is the worst way for a bug to behave.
 *
 * `SET LOCAL` inside a transaction is the version that holds everywhere: the transaction
 * pins one server connection for its whole life, so the setting cannot drift away from
 * the queries it applies to. The cost is that every database access is now a transaction,
 * including reads — which are cheap, and which arguably should have been transactional
 * anyway.
 */
async function connect<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await db().connect();
  } catch (e) {
    throw explain(e);
  }

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path = ${SCHEMA}, public`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // The rollback is best-effort: if the failure was the connection itself dropping,
    // this throws too, and the original error is the one worth reporting.
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Run queries against the database. Transactional — see `connect` for why. */
export const withDb = connect;

/**
 * Run queries in a transaction. Identical to `withDb` now that everything is
 * transactional; kept as a separate name because at the call sites it says something
 * true and useful — that this block must not half-happen.
 */
export const withTx = connect;

export async function ensureSchema(): Promise<void> {
  await withTx(async (c) => { await c.query(SCHEMA_SQL); });
}
