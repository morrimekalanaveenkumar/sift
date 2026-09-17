import { readFile } from 'node:fs/promises';
import { parsePdf } from '../../src/lib/parse/pdf';

async function main() {
  const file = process.argv[2]!;
  const doc = await parsePdf(new Uint8Array(await readFile(file)));
  console.log(`${file}: ${doc.pageCount} page(s), ${doc.charCount} chars`);
  const p = doc.pages[Number(process.argv[4] ?? 0)]!;
  console.log(`  page0: ${p.width.toFixed(0)}x${p.height.toFixed(0)} rot=${p.rotation} cols=${p.columns.length} ocr=${p.needsOcr}`);
  console.log(`  tokens=${p.tokens.length} words=${p.words.length} lines=${p.lines.length}`);
  for (const l of p.lines.slice(0, Number(process.argv[3] ?? 14))) {
    console.log(`   y=${l.box.y.toFixed(0).padStart(4)} ` + l.segments.map((sg) => JSON.stringify(sg.text.slice(0, 32))).join('  |  '));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
