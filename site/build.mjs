/**
 * Assemble the published site in `dist/`:
 *
 *   index.html          the menu — no scripts; each option is its own page, so
 *                       nothing behind it is loaded until it is picked
 *   sim/index.html      the current viewer, from ../world-sim-app/dist (build it first)
 *   game/index.html     the conductor game, from vendor/
 *   study/index.html    the password page, with src/unlock.ts inlined
 *   study/**            the sealed study aid, from vendor/
 *
 * Every link is a relative path to a named file, so the folder works from
 * file:// as well as from cror.ca.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const SIM_DIST = join(HERE, '..', 'world-sim-app', 'dist');
const VENDOR = join(HERE, 'vendor');

const fill = (template, slots) =>
  Object.entries(slots).reduce((html, [slot, value]) => html.replace(`/*${slot}*/`, () => value), template);

const lock = JSON.parse(await readFile(join(VENDOR, 'study', 'lock.json'), 'utf8'));
const style = await readFile(join(HERE, 'src', 'style.css'), 'utf8');

const unlock = await build({
  entryPoints: [join(HERE, 'src', 'unlock.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  define: { SHELL_FILE: JSON.stringify(lock.shell) },
});
const unlockJs = unlock.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'sim'), { recursive: true });
await writeFile(join(DIST, 'index.html'), fill(await readFile(join(HERE, 'index.html'), 'utf8'), { STYLE: style }));
await cp(join(SIM_DIST, 'index.html'), join(DIST, 'sim', 'index.html'));
await cp(join(VENDOR, 'game'), join(DIST, 'game'), { recursive: true });
await cp(join(VENDOR, 'study'), join(DIST, 'study'), {
  recursive: true,
  filter: (src) => !src.endsWith('lock.json'),
});
await writeFile(
  join(DIST, 'study', 'index.html'),
  fill(await readFile(join(HERE, 'study.html'), 'utf8'), { STYLE: style, UNLOCK: unlockJs }),
);
console.log(`dist/: menu, sim, game, study (${lock.shell})`);
