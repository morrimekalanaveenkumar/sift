/**
 * Write the generated corpus to `corpus/`.
 *
 * The documents themselves are built by `src/lib/corpus/generate.ts` — see that file for
 * why each awkwardness in them exists. This script is only the part that puts them on a
 * disk, so the same generator can serve the deployed app, which has no disk to put them
 * on and ingests the bytes directly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCorpus } from '../src/lib/corpus/generate';

const OUT = join(process.cwd(), 'corpus');

async function main() {
  await mkdir(OUT, { recursive: true });

  const { files, truth } = await generateCorpus();
  for (const file of files) await writeFile(join(OUT, file.filename), file.bytes);
  await writeFile(join(OUT, 'ground-truth.json'), JSON.stringify(truth, null, 2));

  const byKind = truth.reduce<Record<string, number>>(
    (a, d) => ({ ...a, [d.kind]: (a[d.kind] ?? 0) + 1 }), {},
  );
  console.log(`Wrote ${truth.length} documents to corpus/`);
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v}`);
  console.log('  5 vendors, each naming the same fields differently');
}

main().catch((e) => { console.error(e); process.exit(1); });
