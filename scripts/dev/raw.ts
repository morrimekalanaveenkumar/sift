import { readFile } from 'node:fs/promises';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function main() {
  const data = new Uint8Array(await readFile(process.argv[2]!));
  const doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  console.log('viewport', { w: vp.width, h: vp.height, rot: vp.rotation, transform: vp.transform });
  const tc = await page.getTextContent();
  for (const it of tc.items.slice(0, 10) as any[]) {
    const m = Util.transform(vp.transform, it.transform);
    console.log(JSON.stringify({
      str: it.str, width: it.width, height: it.height,
      transform: it.transform.map((n: number) => +n.toFixed(2)),
      composed: m.map((n: number) => +n.toFixed(2)),
    }));
  }
  await doc.destroy();
}
main().catch(e => { console.error(e); process.exit(1); });
