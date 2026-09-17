import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePdf } from '../../src/lib/parse/pdf';
import { analyseDocument } from '../../src/lib/infer/fields';

async function main() {
  const dir = 'corpus';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.pdf')).sort();
  const labelCounts = new Map<string, number>();
  let totalFields = 0;
  const perDoc: { file: string; n: number; tables: number }[] = [];

  for (const f of files) {
    const doc = await parsePdf(new Uint8Array(await readFile(join(dir, f))));
    const { fields, tables } = analyseDocument(doc.pages);
    totalFields += fields.length;
    perDoc.push({ file: f, n: fields.length, tables: tables.length });
    for (const fl of fields) labelCounts.set(fl.label, (labelCounts.get(fl.label) ?? 0) + 1);
  }

  console.log(`${files.length} documents, ${totalFields} field candidates\n`);
  console.log('distinct labels seen across the pile:');
  for (const [l, n] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x  ${JSON.stringify(l)}`);
  }
  const empty = perDoc.filter((d) => d.n === 0);
  console.log(`\ndocuments with no fields: ${empty.length} (${empty.map((e) => e.file).join(', ')})`);
}
main().catch(e => { console.error(e); process.exit(1); });
