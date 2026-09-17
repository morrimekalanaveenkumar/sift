import { loadEnv } from '../../src/lib/env';
import { withDb } from '../../src/lib/db/client';
import { commitKind } from '../../src/lib/extract/ingest';
loadEnv();
async function main() {
  const kinds = await withDb(async (c) => (await c.query<{id:string;name:string}>(
    `SELECT k.id, k.name FROM kinds k JOIN projects p ON p.id=k.project_id WHERE p.name='Demo pile'`)).rows);
  for (const k of kinds) {
    if (k.name === 'Unstructured documents') continue;
    const r = await commitKind(k.id);
    console.log(`${k.name} -> table ${r.table}, ${r.rows} rows`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
