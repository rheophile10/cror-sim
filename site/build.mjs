/**
 * Assemble the published site in `dist/`:
 *
 *   index.html          the menu — no scripts; each option is its own page, so
 *                       nothing behind it is loaded until it is picked
 *   sim/index.html      the current viewer, from ../world-sim-app/dist (build it first)
 *   game/index.html     the conductor game, from vendor/
 *   ballast/index.html  the test system, from vendor/ (built in ~/projects/ballast)
 *   tutorial/index.html the Ballast tutorial, from vendor/ (built in ~/projects/ballast/tutorial)
 *
 * Every link is a relative path to a named file, so the folder works from
 * file:// as well as from cror.ca.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const SIM_DIST = join(HERE, '..', 'world-sim-app', 'dist');
const VENDOR = join(HERE, 'vendor');

const fill = (template, slots) =>
  Object.entries(slots).reduce((html, [slot, value]) => html.replace(`/*${slot}*/`, () => value), template);

const style = await readFile(join(HERE, 'src', 'style.css'), 'utf8');


await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'sim'), { recursive: true });
await writeFile(join(DIST, 'index.html'), fill(await readFile(join(HERE, 'index.html'), 'utf8'), { STYLE: style }));
await cp(join(SIM_DIST, 'index.html'), join(DIST, 'sim', 'index.html'));
await cp(join(VENDOR, 'game'), join(DIST, 'game'), { recursive: true });
await cp(join(VENDOR, 'ballast'), join(DIST, 'ballast'), { recursive: true });
await cp(join(VENDOR, 'tutorial'), join(DIST, 'tutorial'), { recursive: true });
await cp(join(VENDOR, 'reader'), join(DIST, 'reader'), { recursive: true });
console.log('dist/: menu, sim, game, ballast, tutorial, reader');
