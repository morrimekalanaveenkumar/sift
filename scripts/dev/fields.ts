import { readFile } from 'node:fs/promises';
import { parsePdf } from '../../src/lib/parse/pdf';
import { analyseDocument } from '../../src/lib/infer/fields';

async function main() {
  for (const file of process.argv.slice(2)) {
    const doc = await parsePdf(new Uint8Array(await readFile(file)));
    const { fields, tables, narrative } = analyseDocument(doc.pages);
    console.log(`\n${file}`);
    console.log(`  tables: ${tables.length}${tables[0] ? ` (header: ${JSON.stringify(tables[0].header)}, ${tables[0].rows.length} rows)` : ''}`);
    for (const f of fields) {
      console.log(`  ${f.relation.padEnd(5)} ${f.type.padEnd(10)} ${JSON.stringify(f.label).padEnd(22)} = ${JSON.stringify(f.value)}  (${f.confidence.toFixed(2)})`);
    }
    if (narrative.length) console.log(`  narrative: ${narrative.length} line(s)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
