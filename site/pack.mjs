/**
 * Refresh `vendor/` from the sibling projects, which have no git remote:
 *
 *   vendor/game/index.html      ~/projects/conductor-game  (npm run build there first)
 *   vendor/study/**             ~/projects/CROR/internal-tools (npm run build there first),
 *                               sealed under STUDY_AID_PASSWORD
 *
 * CI cannot see either project, so `vendor/` is committed and `build.mjs` only
 * assembles it. Run this locally whenever the game or the study aid changes:
 *
 *   STUDY_AID_PASSWORD='…' npm run pack
 *
 * What the study aid becomes:
 *   shell.<rev>.js          __studyAidShell(salt, sealed gzipped study-aid.html)
 *   chunks/<id>.js          __studyAidChunk(id, __studyAidOpen(id, sealed payload))
 *   lock.json               { format, shell } — which shell file build.mjs points at
 *
 * Chunk ids and file names stay as the study aid expects them, so its own lazy
 * loader still asks for `chunks/deck/questions.js` when a page needs it and never
 * learns that anything was encrypted. Figures (TSB report images, public) are
 * copied as they are: an <img> cannot wait for a decrypt.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  FORMAT, NONCE_BYTES, OPEN_CALLBACK, SALT_BYTES, SHELL_CALLBACK,
  deriveKey, fromBase64, seal, toBase64,
} from './src/lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = join(HERE, '..', '..', '..');
const GAME_DIST = process.env.GAME_DIST ?? join(PROJECTS, 'conductor-game', 'packages', 'game', 'dist');
const STUDY_DIST = process.env.STUDY_DIST ?? join(PROJECTS, 'CROR', 'internal-tools', 'dist');
const VENDOR = join(HERE, 'vendor');

const CHUNK = /^__studyAidChunk\(("(?:[^"\\]|\\.)*"),"([A-Za-z0-9+/=]*)"\);\s*$/;

const walk = async (dir) => {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
};

const packGame = async () => {
  await rm(join(VENDOR, 'game'), { recursive: true, force: true });
  await mkdir(join(VENDOR, 'game'), { recursive: true });
  await cp(join(GAME_DIST, 'index.html'), join(VENDOR, 'game', 'index.html'));
};

const packStudy = async (password) => {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const key = await deriveKey(password, salt);
  const nonce = () => new Uint8Array(randomBytes(NONCE_BYTES));
  const out = join(VENDOR, 'study');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'chunks'), { recursive: true });

  const html = await readFile(join(STUDY_DIST, 'study-aid.html'));
  const shell = seal(key, 'shell', new Uint8Array(gzipSync(html, { level: 9 })), nonce());
  const rev = createHash('sha256').update(shell).digest('hex').slice(0, 12);
  const shellFile = `shell.${rev}.js`;
  await writeFile(join(out, shellFile), `${SHELL_CALLBACK}(${JSON.stringify(toBase64(salt))},${JSON.stringify(toBase64(shell))});\n`);

  const chunkFiles = await walk(join(STUDY_DIST, 'chunks'));
  for (const file of chunkFiles) {
    const match = CHUNK.exec(await readFile(file, 'utf8'));
    if (!match) throw new Error(`${file} is not a study aid chunk script`);
    const id = JSON.parse(match[1]);
    const box = seal(key, `chunk:${id}`, fromBase64(match[2]), nonce());
    const target = join(out, 'chunks', relative(join(STUDY_DIST, 'chunks'), file));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `__studyAidChunk(${match[1]},${OPEN_CALLBACK}(${match[1]},${JSON.stringify(toBase64(box))}));\n`);
  }

  await cp(join(STUDY_DIST, 'figures'), join(out, 'figures'), { recursive: true }).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await writeFile(join(out, 'lock.json'), `${JSON.stringify({ format: FORMAT, shell: shellFile }, null, 2)}\n`);
  return { chunks: chunkFiles.length, shellFile };
};

const password = process.env.STUDY_AID_PASSWORD;
if (!password) {
  console.error('Set STUDY_AID_PASSWORD: the study aid is sealed under it.');
  process.exit(1);
}
await packGame();
const study = await packStudy(password);
console.log(`vendor/game/index.html from ${GAME_DIST}`);
console.log(`vendor/study: ${study.shellFile} + ${study.chunks} sealed chunks from ${STUDY_DIST}`);
