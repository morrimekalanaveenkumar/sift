import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePdf } from '../../src/lib/parse/pdf';
import { analyseDocument } from '../../src/lib/infer/fields';
import { collectCooccurrence, collectLabelStats, scoreMerge, type DocumentObservation } from '../../src/lib/infer/reconcile';

async function main() {
  const files = (await readdir('corpus')).filter((f) => f.startsWith('invoice')).sort();
  const obs: DocumentObservation[] = [];
  for (const f of files) {
    const doc = await parsePdf(new Uint8Array(await readFile(join('corpus', f))));
    obs.push({ docId: f, fields: analyseDocument(doc.pages).fields, pageWidth: doc.pages[0]!.width, pageHeight: doc.pages[0]!.height });
  }
  const stats = collectLabelStats(obs);
  const co = collectCooccurrence(obs);
  const want: [string, string][] = [
    ['Bill To', 'Sold To'], ['Account', 'Sold To'],
    ['Raised on', 'Invoice Date'], ['Issued', 'Invoice Date'],
    ['Settle by', 'Due Date'], ['Payment Due', 'Due Date'],
    ['Balance Due', 'Total Due'],
  ];
  for (const [a, b] of want) {
    const sa = stats.get(a), sb = stats.get(b);
    if (!sa || !sb) { console.log(`${a} / ${b}: MISSING`); continue; }
    const ev = scoreMerge(sa, sb, co);
    console.log(`${(a + ' / ' + b).padEnd(30)} ${ev.score.toFixed(2)} ${ev.blocked ? 'BLOCKED' : ''}`);
    console.log(`   rank ${sa.rank.toFixed(2)}/${sb.rank.toFixed(2)}  pos (${sa.position.x.toFixed(2)},${sa.position.y.toFixed(2)})/(${sb.position.x.toFixed(2)},${sb.position.y.toFixed(2)})  shapes ${sa.shapes[0]} / ${sb.shapes[0]}`);
    console.log(`   ${ev.reasons.join(' | ') || '(no reasons)'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
