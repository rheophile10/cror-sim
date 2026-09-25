/**
 * The assembled dist/ played in Chromium, from file:// and over http.
 *
 *   npm run build --prefix ../world-sim-app
 *   npm run pack && npm run build
 *   npm test
 */
import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

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
      assert.deepEqual(links, ['sim/index.html', 'game/index.html', 'ballast/index.html']);
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

    test('ballast opens from the menu', async () => {
      const { p, errors } = await page();
      await p.goto(base() + 'index.html');
      await p.locator('a.option', { hasText: 'Ballast' }).click();
      await p.waitForLoadState('load');
      assert.equal(await p.title(), 'Ballast');
      await p.locator('text=Register crew').waitFor();
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

  });
}
