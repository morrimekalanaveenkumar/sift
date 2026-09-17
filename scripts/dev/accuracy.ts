import { loadEnv } from '../../src/lib/env';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureSchema, withDb } from '../../src/lib/db/client';
import { commitKind, ingest, quote } from '../../src/lib/extract/ingest';
loadEnv();

type Truth = { file: string; kind: string; truth: Record<string, string | number | null> };

/** Ground-truth key -> the column the discovered schema chose for it. */
const MAP: Record<string, string> = {
  invoice_number: 'invoice_no', invoice_date_iso: 'invoice_date', customer: 'bill_to',
  subtotal: 'subtotal', tax: 'sales_tax', total: 'total_due',
};

const norm = (v: unknown) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v.toFixed(2);
  const s = String(v).trim();
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  if (/^-?[\d,]+\.?\d*$/.test(s.replace(/[^0-9.,-]/g, '')) && Number.isFinite(n) && /\d/.test(s)) {
    return n.toFixed(2);
  }
  return s;
};

async function main() {
  const truth: Truth[] = JSON.parse(await readFile('corpus/ground-truth.json', 'utf8'));

  // Ingest a private pile of its own, measure it, and throw it away.
  //
  // Reading whatever is in the Demo pile would measure the wrong thing twice over: an
  // earlier run leaves a committed table behind, and anyone who has used the review screen
  // has *corrected* cells — so a value a person fixed by hand would be scored as the
  // extractor getting it right. This number is supposed to say how good extraction is
  // before a human touches it, which means it has to start from the PDFs every time.
  await ensureSchema();

  const files = (await readdir('corpus')).filter((f) => f.endsWith('.pdf')).sort();
  const payload = [];
  for (const f of files) {
    payload.push({ filename: f, bytes: new Uint8Array(await readFile(join('corpus', f))) });
  }

  const projectId = await withDb(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`accuracy run ${new Date().toISOString()}`],
    );
    return rows[0]!.id;
  });

  let table: string;
  try {
    await ingest(projectId, payload);
    const kindId = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM kinds WHERE project_id = $1 AND name ILIKE 'invoice%' LIMIT 1`,
        [projectId],
      );
      if (!rows[0]) throw new Error('Clustering produced no invoice kind.');
      return rows[0].id;
    });
    ({ table } = await commitKind(kindId));
    await measure(table, truth);
  } finally {
    await withDb(async (c) => {
      const { rows } = await c.query<{ table_name: string | null }>(
        `SELECT table_name FROM kinds WHERE project_id = $1 AND table_name IS NOT NULL`,
        [projectId],
      );
      for (const r of rows) if (r.table_name) await c.query(`DROP TABLE IF EXISTS ${quote(r.table_name)}`);
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    });
  }
}

async function measure(table: string, truth: Truth[]) {
  const rows = await withDb(async (c) =>
    (await c.query(`SELECT * FROM ${table}`)).rows as Record<string, unknown>[]);
  const byDoc = new Map(rows.map((r) => [String(r.document), r]));

  let checked = 0, correct = 0, missing = 0;
  const wrong: string[] = [];

  for (const t of truth.filter((t) => t.kind === 'invoice')) {
    const row = byDoc.get(t.file);
    if (!row) { missing++; continue; }
    for (const [key, expected] of Object.entries(t.truth)) {
      const col = MAP[key];
      if (!col || !(col in row)) continue;
      checked++;
      const got = row[col];
      // Dates: ground truth is the vendor's rendering, the column is canonical ISO.
      if (col.endsWith('_date')) {
        // Ground truth carries the ISO date the vendor meant, so this compares the
        // parser against the intent rather than against the harness's own guess at how
        // to read a slash date.
        const iso = got instanceof Date ? got.toISOString().slice(0, 10) : String(got ?? '');
        if (iso === String(expected)) correct++;
        else wrong.push(`${t.file} ${col}: got ${iso}, expected ${expected}`);
        continue;
      }
      if (norm(got) === norm(expected)) correct++;
      else wrong.push(`${t.file} ${col}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  }

  console.log(`invoices in table: ${rows.length}/31   documents missing: ${missing}`);
  console.log(`field values checked: ${checked}`);
  console.log(`correct: ${correct}  (${((correct / checked) * 100).toFixed(1)}%)`);
  if (wrong.length) {
    console.log(`\nfirst 12 mismatches:`);
    for (const w of wrong.slice(0, 12)) console.log('  ' + w);
    const cols = new Map<string, number>();
    for (const w of wrong) { const c = w.split(' ')[1]!.replace(':',''); cols.set(c, (cols.get(c) ?? 0) + 1); }
    console.log('\nby column: ' + [...cols].map(([c, n]) => `${c}=${n}`).join('  '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
