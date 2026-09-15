/**
 * The assembled dist/ played in Chromium, from file:// and over http.
 *
 *   npm run build --prefix ../world-sim-app
 *   STUDY_AID_PASSWORD=… npm run pack && npm run build
 *   STUDY_AID_PASSWORD=… npm test
 */
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PASSWORD = process.env.STUDY_AID_PASSWORD;
if (!PASSWORD) throw new Error('Set STUDY_AID_PASSWORD to the password vendor/study was packed under');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png' };
const serve = () =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = join(DIST, decodeURIComponent(req.url.split('?')[0]));
      const file = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, 'index.html') : path;
      if (!statSync(file, { throwIfNoEntry: false })) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

test('nothing of the study aid is readable in dist/study', () => {
  const needles = ['CROR study tools', 'Canadian Rail Operating Rules', 'Center the reverser'];
  for (const file of walk(join(DIST, 'study')).filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    const text = readFileSync(file, 'utf8');
    for (const n of needles) assert.ok(!text.includes(n), `${file} contains "${n}"`);
    // a chunk's payload must not be the study aid's plain gzip either
    for (const [, b64] of text.matchAll(/"([A-Za-z0-9+/=]{200,})"/g)) {
      assert.throws(() => gunzipSync(Buffer.from(b64, 'base64')), `${file} carries a plain gzip payload`);
    }
  }
});

let browser;
let server;
before(async () => {
  browser = await chromium.launch();
  server = await serve();
});
after(async () => {
  await browser?.close();
  server?.close();
});

for (const transport of ['file', 'http']) {
  describe(`over ${transport}`, () => {
    const base = () =>
      transport === 'file' ? pathToFileURL(DIST).href + '/' : `http://127.0.0.1:${server.address().port}/`;

    const page = async () => {
      const context = await browser.newContext();
      const p = await context.newPage();
      const errors = [];
      const scripts = [];
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('request', (r) => r.resourceType() === 'script' && scripts.push(r.url()));
      return { p, errors, scripts };
    };

    test('the menu offers three places and loads none of them', async () => {
      const { p, errors, scripts } = await page();
      await p.goto(base() + 'index.html');
      const links = await p.locator('a.option').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      assert.deepEqual(links, ['sim/index.html', 'game/index.html', 'study/index.html']);
      assert.deepEqual(scripts, []);
      assert.deepEqual(errors, []);
      await p.context().close();
    });

    test('the current site opens from the menu as it is', async () => {
      const { p, errors } = await page();
      await p.goto(base() + 'index.html');
      await p.locator('a.option', { hasText: 'Whiteshell' }).click();
      await p.waitForLoadState('load');
      assert.equal(await p.title(), 'Whiteshell Subdivision');
      assert.deepEqual(errors, []);
      await p.context().close();
    });

    test('the game opens from the menu', async () => {
      const { p, errors } = await page();
      await p.goto(base() + 'index.html');
      await p.locator('a.option', { hasText: 'Conductor game' }).click();
      await p.waitForLoadState('load');
      await p.waitForTimeout(1000);
      assert.match(p.url(), /game\/index\.html$/);
      assert.ok((await p.locator('body *').count()) > 5, 'the game drew something');
      assert.deepEqual(errors, []);
      await p.context().close();
    });

    test('the study aid refuses a wrong password, opens on the right one, and lazy-loads sealed chunks', async () => {
      const { p, errors, scripts } = await page();
      await p.goto(base() + 'index.html');
      await p.locator('a.option', { hasText: 'Study aid' }).click();
      await p.waitForLoadState('load');
      assert.deepEqual(scripts.filter((s) => s.includes('/study/')), [], 'nothing sealed is fetched before a password');

      await p.fill('#password', PASSWORD + 'x');
      await p.click('#go');
      await p.locator('#status.bad', { hasText: 'Wrong password' }).waitFor({ timeout: 30_000 });
      assert.equal(await p.evaluate(() => typeof window.__studyAidOpen), 'undefined');

      await p.fill('#password', PASSWORD);
      await p.click('#go');
      await p.waitForFunction(() => document.title === 'CROR study tools', null, { timeout: 30_000 });
      await p.waitForFunction(() => !!document.querySelector('.nav') && document.body.dataset.rendered === location.hash, null, { timeout: 60_000 });
      assert.ok(!scripts.some((s) => s.includes('chunks/rulebook/GOI')), 'the GOI is not loaded at boot');

      await p.evaluate(() => { location.hash = '#/progress?tab=cards&deck=questions&status=all&tag=goi%3A8.4.6.13'; });
      await p.waitForFunction(() => document.body.dataset.rendered === location.hash, null, { timeout: 60_000 });
      const row = p.locator('.row').first();
      await row.locator('.row-title').click();
      await row.locator('.rulepanel', { hasText: 'GOI 8.4.6.13' }).locator('.rulelink').click();
      await row.locator('.rule-inline', { hasText: 'Center the reverser' }).first().waitFor({ timeout: 30_000 });
      assert.ok(scripts.some((s) => s.includes('chunks/rulebook/GOI')), 'the GOI arrived on demand');

      await p.reload();
      await p.waitForFunction(() => document.title === 'CROR study tools', null, { timeout: 30_000 });
      assert.deepEqual(errors, []);
      await p.context().close();
    });
  });
}
