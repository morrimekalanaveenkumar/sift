import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePdf } from '../../src/lib/parse/pdf';
import { analyseCorpus } from '../../src/lib/infer/fields';
import { clusterDocuments, signatureOf } from '../../src/lib/infer/cluster';
import { reconcileFields, type DocumentObservation } from '../../src/lib/infer/reconcile';

async function main() {
  const files = (await readdir('corpus')).filter((f) => f.endsWith('.pdf')).sort();
  const parsed = [];
  for (const f of files) {
    parsed.push({ id: f, doc: await parsePdf(new Uint8Array(await readFile(join('corpus', f)))) });
  }
  const analyses = analyseCorpus(parsed.map((p) => ({ id: p.id, pages: p.doc.pages })));
  const items = parsed.map((p) => {
    const analysis = analyses.get(p.id)!;
    return { file: p.id, doc: p.doc, analysis, sig: signatureOf(p.doc, analysis) };
  });

  const clusters = clusterDocuments(items, (i) => i.sig);
  console.log(`\n${items.length} documents -> ${clusters.length} kinds\n`);

  for (const c of clusters) {
    const kinds = new Set(c.members.map((m) => m.file.split('-')[0]));
    console.log(`── kind ${c.id}: ${c.members.length} documents  [${[...kinds].join(', ')}]`);
    const obs: DocumentObservation[] = c.members.map((m) => ({
      docId: m.file,
      fields: m.analysis.fields,
      pageWidth: m.doc.pages[0]?.width ?? 595,
      pageHeight: m.doc.pages[0]?.height ?? 842,
    }));
    const { fields } = reconcileFields(obs);
    for (const f of fields) {
      if (f.coverage < 0.1) continue;
      const alias = f.aliases.length ? `   ← ${f.aliases.map((a) => JSON.stringify(a)).join(', ')}` : '';
      console.log(`   ${f.name.padEnd(18)} ${f.type.padEnd(10)} ${(f.coverage * 100).toFixed(0).padStart(3)}%${alias}`);
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
