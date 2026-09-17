/**
 * One command from a clean checkout to a working demo: create the database, build the
 * corpus if it is missing, and ingest it so the app opens on something worth looking at.
 */
import { Client } from 'pg';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../src/lib/env';
import { ensureSchema, explain, withDb } from '../src/lib/db/client';
import { ingest } from '../src/lib/extract/ingest';

loadEnv();
const URL_ = process.env.SIFT_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sift';

async function ensureDatabase() {
  const u = new URL(URL_);
  const name = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  const admin = new Client({ connectionString: u.toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw explain(e);
  }
  const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${name}"`);
    console.log(`  created database ${name}`);
  } else console.log(`  database ${name} already exists`);
  await admin.end();
}

async function main() {
  process.env.SIFT_DATABASE_URL = URL_;
  console.log('Sift setup\n');
  console.log('1. Database');
  await ensureDatabase();
  await ensureSchema();
  console.log('  schema applied');

  if (!existsSync('corpus/ground-truth.json')) {
    console.log('\n2. Building the document corpus');
    execFileSync('npx', ['tsx', 'scripts/make-corpus.ts'], { stdio: 'inherit' });
  } else {
    console.log('\n2. Corpus already present');
  }

  console.log('\n3. Ingesting');
  const files = (await readdir('corpus')).filter((f) => f.endsWith('.pdf')).sort();
  const payload = [];
  for (const f of files) payload.push({ filename: f, bytes: new Uint8Array(await readFile(join('corpus', f))) });

  const projectId = await withDb(async (c) => {
    await c.query(`DELETE FROM projects WHERE name = 'Demo pile'`);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Demo pile') RETURNING id`,
    );
    return rows[0]!.id;
  });

  let last = '';
  const result = await ingest(projectId, payload, (p) => {
    // Only the parsing stage is a loop worth counting; the rest are one pass over the
    // whole pile, and a fraction there just looks stuck.
    const count = p.total > 1 ? ` ${p.done}/${p.total}` : '';
    const line = `  ${p.stage}:${count} ${p.message}`;
    if (line !== last) { process.stdout.write(`\r${line.padEnd(78)}`); last = line; }
  });
  process.stdout.write('\n');

  console.log(`\n  ${result.documents} documents -> ${result.kinds} kinds, ${result.fields} fields`);

  await withDb(async (c) => {
    const { rows } = await c.query<{ name: string; n: string; fields: string }>(
      `SELECT k.name, count(DISTINCT d.id)::text AS n,
              (SELECT count(*)::text FROM fields WHERE kind_id = k.id) AS fields
         FROM kinds k LEFT JOIN documents d ON d.kind_id = k.id
        WHERE k.project_id = $1 GROUP BY k.id, k.name ORDER BY count(DISTINCT d.id) DESC`,
      [projectId],
    );
    for (const r of rows) console.log(`    ${r.name.padEnd(24)} ${r.n.padStart(3)} docs, ${r.fields} fields`);
  });

  console.log('\nNow run:  npm run dev');
  console.log('Then open http://localhost:3000\n');
  process.exit(0);
}
main().catch((e) => {
  console.error(`\nSetup failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
