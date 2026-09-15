/**
 * The study aid's lock: one format, used by `pack.mjs` in Node to seal and by
 * `unlock.ts` in the browser to open.
 *
 * The primitives are browser-crypto's (~/projects/browser-crypto), with its
 * protocol constants copied rather than imported, because that package ships no
 * built `dist/` a CI checkout could install:
 *
 *   kdf     Argon2id, t=3, m=64 MiB, p=1, 32-byte key — memory-hard, because the
 *           ciphertext is public and anyone can guess passwords at it offline
 *   cipher  XChaCha20-Poly1305, random 24-byte nonce, SYNCHRONOUS — a chunk script
 *           must hand the study aid its payload before the script's load event
 *           fires, so there is no room to await WebCrypto
 *
 * Every sealed piece is bound to its own name as associated data, so a chunk
 * cannot be swapped for another one and still open.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2id } from 'hash-wasm';

export const FORMAT = 1;
export const NONCE_BYTES = 24;
export const SALT_BYTES = 16;
const KDF = { parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 };

/** The global a sealed chunk calls to turn its ciphertext back into the study aid's payload. */
export const OPEN_CALLBACK = '__studyAidOpen';
/** The global the sealed shell script calls with the salt and the sealed page. */
export const SHELL_CALLBACK = '__studyAidShell';

const utf8 = (s) => new TextEncoder().encode(s);

export const deriveKey = async (password, salt) =>
  argon2id({ password: utf8(password), salt, ...KDF, outputType: 'binary' });

export const seal = (key, name, plaintext, nonce) => {
  const sealed = xchacha20poly1305(key, nonce, utf8(name)).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE_BYTES);
  return out;
};

/** Throws on a wrong key, a tampered byte, or a piece opened under the wrong name. */
export const open = (key, name, box) =>
  xchacha20poly1305(key, box.subarray(0, NONCE_BYTES), utf8(name)).decrypt(box.subarray(NONCE_BYTES));

export const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export const fromBase64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
