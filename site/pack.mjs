/**
 * Refresh `vendor/` from the sibling project, which has no git remote:
 *
 *   vendor/game/index.html      ~/projects/conductor-game  (npm run build there first)
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
const VENDOR = join(HERE, 'vendor');

const packGame = async () => {
  await rm(join(VENDOR, 'game'), { recursive: true, force: true });
  await mkdir(join(VENDOR, 'game'), { recursive: true });
  await cp(join(GAME_DIST, 'index.html'), join(VENDOR, 'game', 'index.html'));
};

await packGame();
console.log(`vendor/game/index.html from ${GAME_DIST}`);
