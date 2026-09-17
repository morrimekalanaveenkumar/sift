/**
 * Walk the whole product in a real browser, screenshotting as it goes.
 *
 * Two jobs in one script. It produces the images in `docs/screenshots`, and it is a smoke
 * test of every user-facing flow: upload with live progress, schema discovery, review,
 * correcting a value and generalising the correction, the query surface, and deleting a
 * pile. If any of it breaks, the shot it produces shows exactly how — which is a better
 * failure report than an assertion, and the reason this is a script rather than a test.
 *
 *   npm run setup            # start from the demo pile
 *   node scripts/dev/shots.mjs
 *
 * Needs the app running (`npm run dev` or `npm start`). Any console error in any page
 * fails the run.
 */
import { chromium } from 'playwright';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = process.env.SIFT_URL ?? 'http://127.0.0.1:3000';
const out = process.env.SHOT_DIR ?? 'docs/screenshots';
const chromiumPath = process.env.CHROMIUM_PATH; // unset = Playwright's own download

await mkdir(out, { recursive: true });

const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('·', name);
};
const json = async (path) => (await fetch(base + path)).json();

// ---------------------------------------------------------------------------
// 1. Upload — a mixed pile, plus one non-PDF so the "ignored" notice shows.
// ---------------------------------------------------------------------------

await page.goto(base, { waitUntil: 'networkidle' });
await shot('00-home');

const pdfs = (await readdir('corpus')).filter((f) => f.endsWith('.pdf')).sort();
const pile = [
  ...pdfs.filter((f) => f.startsWith('invoice-northwind')),
  ...pdfs.filter((f) => f.startsWith('invoice-kestrel')),
  ...pdfs.filter((f) => f.startsWith('receipt')),
  ...pdfs.filter((f) => f.startsWith('statement')),
].map((f) => join('corpus', f));

await page.locator('input[type=file]').setInputFiles([...pile, 'package.json']);
await page.waitForTimeout(400);
await shot('08-upload');

await page.getByLabel('Name this pile').fill('Uploaded pile');

// Catch the progress panel mid-stream. Ingest is fast enough that this is a race, so poll
// tightly and shoot the instant it exists rather than waiting for a nicer frame.
let sawProgress = false;
const catchProgress = (async () => {
  for (let i = 0; i < 60; i++) {
    if (await page.locator('[role=status]').count()) {
      await page.screenshot({ path: `${out}/09-ingesting.png` }).catch(() => {});
      sawProgress = true;
      return;
    }
    await page.waitForTimeout(40);
  }
})();

await page.getByRole('button', { name: 'Sift it' }).click();
await catchProgress;
console.log(sawProgress ? '· 09-ingesting' : '! progress panel never appeared');

await page.waitForURL(/\/p\//, { timeout: 120_000 });
await page.waitForTimeout(1000);
await shot('10-after-upload');

// ---------------------------------------------------------------------------
// 2. The demo pile: schema, review, generalisation, data.
// ---------------------------------------------------------------------------

const { projects } = await json('/api/projects');
const demo = projects.find((p) => p.name === 'Demo pile') ?? projects.at(-1);
if (!demo) throw new Error('No pile to walk through — run `npm run setup` first.');

await page.goto(`${base}/p/${demo.id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const build = page.getByRole('button', { name: /^Build table$/ });
if (await build.count()) { await build.first().click(); await page.waitForTimeout(2500); }
await shot('01-schema');

await page.getByRole('button', { name: 'Why?' }).nth(2).click();
await page.waitForTimeout(400);
await shot('02-why');

const { kinds } = await json(`/api/projects/${demo.id}`);
const invoices = kinds.find((k) => /invoice/i.test(k.name)) ?? kinds[0];

await page.goto(`${base}/p/${demo.id}/review/${invoices.id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await shot('03-review');

// Correct one value and let it offer to fix the rest of the class.
const target = page.locator('button', { hasText: 'Halcyon Retail Pvt Ltd' }).first();
if (await target.count()) {
  await target.click();
  await page.waitForTimeout(1200);
  const input = page.getByLabel(/^Value for /);
  await input.fill('Halcyon Retail');
  await input.press('Enter');
  await page.waitForTimeout(900);
  await shot('04-generalise');

  const apply = page.getByRole('button', { name: /Apply to all/ });
  if (await apply.count()) {
    await apply.click();
    await page.waitForTimeout(900);
    await shot('05-applied');
  } else {
    console.log('! no generalisation offered');
  }
} else {
  console.log('! nothing in the queue to correct — skipping 04/05');
}

await page.goto(`${base}/p/${demo.id}/data/${invoices.id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shot('06-data');

await page.getByLabel('Search').first().fill('Orenda');
await page.waitForTimeout(800);
await shot('07-data-search');

// ---------------------------------------------------------------------------
// 3. Deleting a pile — the uploaded one, so the demo pile survives.
// ---------------------------------------------------------------------------

await page.goto(base, { waitUntil: 'networkidle' });
const uploaded = page.locator('a[href^="/p/"]').filter({ hasText: 'Uploaded pile' }).first();
if (await uploaded.count()) {
  await uploaded.hover();
  await page.waitForTimeout(250);
  await shot('11-pile-hover');

  await page.locator('button[aria-label="Delete Uploaded pile"]').first().click();
  await page.waitForTimeout(300);
  await shot('12-pile-confirm');

  const before = await page.locator('a[href^="/p/"]').count();
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await page.waitForTimeout(1800);
  const after = await page.locator('a[href^="/p/"]').count();
  console.log(`· 13-pile-deleted  (${before} piles -> ${after})`);
  await shot('13-pile-deleted');
}

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 8)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors');
