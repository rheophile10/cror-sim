/**
 * Refresh `vendor/` from the sibling project, which has no git remote:
 *
 *   vendor/game/index.html      ~/projects/conductor-game  (npm run build there first)
 *   vendor/ballast/index.html   ~/projects/ballast         (node build.mjs there first)
 *   vendor/tutorial/index.html  ~/projects/ballast/tutorial (node tutorial/build.mjs there first)
 *
 * CI cannot see it, so `vendor/` is committed and `build.mjs` only assembles it.
 * Run this locally whenever the game changes:
 *
 *   npm run pack
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = join(HERE, '..', '..', '..');
const GAME_DIST = process.env.GAME_DIST ?? join(PROJECTS, 'conductor-game', 'packages', 'game', 'dist');
const BALLAST = process.env.BALLAST ?? join(PROJECTS, 'ballast');
const VENDOR = join(HERE, 'vendor');

const packGame = async () => {
  await rm(join(VENDOR, 'game'), { recursive: true, force: true });
  await mkdir(join(VENDOR, 'game'), { recursive: true });
  await cp(join(GAME_DIST, 'index.html'), join(VENDOR, 'game', 'index.html'));
};

await packGame();
await mkdir(join(VENDOR, 'ballast'), { recursive: true });
await cp(join(BALLAST, 'index.html'), join(VENDOR, 'ballast', 'index.html'));
await mkdir(join(VENDOR, 'tutorial'), { recursive: true });
await cp(join(BALLAST, 'tutorial', 'index.html'), join(VENDOR, 'tutorial', 'index.html')); // the tutorial embeds ../ballast/index.html
console.log(`vendor/ballast/index.html from ${BALLAST}`);
console.log(`vendor/game/index.html from ${GAME_DIST}`);
