/**
 * Render a scene to a PNG, headlessly, through Chrome.
 *
 * `npm run build` first, then:
 *   node scripts/render-png.mjs ../world-sim-app/scenes/mountain-loop.json out.png \
 *     --seconds=20 --yaw=38 --pitch=32 --zoom=2.2 --focus=560,650
 *
 * The page it writes is a real canvas driven by the real renderer — the same
 * code path the app uses, not a re-implementation — so a still from this is
 * evidence about the library and not about the harness. Useful for eyeballing a
 * scene from a terminal, and for catching a change that keeps the tests green
 * and still makes the picture wrong.
 *
 * The page loads from `file://`, where Chrome refuses module imports, so the
 * built modules are concatenated in dependency order with their import/export
 * lines stripped. That flattens every module into **one scope**, which has one
 * consequence worth knowing: two modules declaring the same top-level `const`
 * is a redeclaration error. It is caught and reported — the bundle is evaluated
 * through `new Function`, which turns what would be an uncatchable parse error
 * in a `<script>` into a normal exception that gets painted onto the canvas.
 * Without that, the symptom is a blank image and no message at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const scenePath = resolve(positional[0] ?? '../world-sim-app/scenes/mountain-loop.json');
const outPath = resolve(positional[1] ?? 'scene.png');
const width = flag('width', 1280);
const height = flag('height', 800);
const seconds = flag('seconds', 0);

const scene = readFileSync(scenePath, 'utf8');
const bundle = buildBundle();

const work = mkdtempSync(join(tmpdir(), 'world-sim-shot-'));
const page = join(work, 'shot.html');
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#0b0e11}canvas{display:block;width:${width}px;height:${height}px}</style>
<canvas id="c"></canvas>
<script>
// Anything thrown — including a syntax error in the concatenated bundle — is
// painted onto the canvas, where the screenshot will catch it. A silent black
// PNG is the worst possible way to report a broken render.
function fail(err) {
  var ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#3a0d0d';
  ctx.fillRect(0, 0, ${width}, ${height});
  ctx.fillStyle = '#ffb4ae';
  ctx.font = '16px monospace';
  String((err && err.stack) || err).split('\\n').slice(0, 20)
    .forEach(function (line, i) { ctx.fillText(line.slice(0, 120), 20, 40 + i * 22); });
  document.title = 'error';
}

try {
  var lib = new Function(${JSON.stringify(bundle)} + '\\nreturn { World: World, Renderer: Renderer };')();
  var world = lib.World.fromJSON(${scene});
  var canvas = document.getElementById('c');
  var r = new lib.Renderer(canvas, world);
${cameraLines()}
  r.camera.refresh();
  r.frameAll();
${framing()}
  for (var t = 0; t < ${seconds}; t += 0.02) world.step(0.02);
  r.render();
  document.title = 'ready';
} catch (err) {
  fail(err);
}
<\/script>`,
);

execFileSync(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    `--window-size=${width},${height}`,
    `--screenshot=${outPath}`,
    '--virtual-time-budget=4000',
    `file://${page}`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${outPath}`);

function cameraLines() {
  return ['yaw', 'pitch']
    .map((name) => {
      const hit = argv.find((a) => a.startsWith(`--${name}=`));
      return hit ? `  r.camera.${name} = ${Number(hit.split('=')[1])};` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** `--zoom=` and `--focus=x,y` override the automatic fit, for close-ups. */
function framing() {
  const out = [];
  const zoom = argv.find((a) => a.startsWith('--zoom='));
  const focus = argv.find((a) => a.startsWith('--focus='));
  if (zoom) out.push(`  r.camera.zoom = ${Number(zoom.split('=')[1])}; r.camera.refresh();`);
  if (focus) {
    const [x, y] = focus.split('=')[1].split(',').map(Number);
    out.push(`  r.lookAt(${x}, ${y}, world.terrain.heightAt(${x}, ${y}));`);
  }
  return out.join('\n');
}

/**
 * Concatenate the built library in dependency order.
 *
 * The order is derived by walking each module's own relative imports rather
 * than being listed here: a hand-written list is silently wrong the first time
 * a module is added.
 */
function buildBundle() {
  const dist = join(here, '..', 'dist');
  const seen = new Set();
  const chunks = [];

  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(dist, rel), 'utf8');
    // tsc emits double quotes; hand-written sources use single. Accept both.
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      visit(join(dirname(rel), m[1]).replaceAll('\\', '/'));
    }
    chunks.push(src);
  };
  visit('index.js');

  return chunks
    .join('\n')
    // Strip module syntax, including the multi-line forms tsc emits.
    .replace(/^import[\s\S]*?;$/gm, '')
    .replace(/^export\s+(\*|\{[\s\S]*?\})\s*(from[^;]*)?;$/gm, '')
    .replace(/^export /gm, '');
}
