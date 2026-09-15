/**
 * The study aid's door. Nothing of the study aid is loaded until a password is
 * submitted; then:
 *
 *   1. the sealed shell script is injected (a classic <script src> is the one
 *      loader that works from file:// as well as over https)
 *   2. Argon2id turns the password and the shell's salt into the key
 *   3. the shell opens — or fails its tag, which is how a wrong password shows
 *   4. `__studyAidOpen` is installed, so each sealed chunk decrypts itself
 *      synchronously the moment the study aid's own lazy loader pulls it in
 *   5. the decrypted page replaces this one in place, keeping the URL, so its
 *      relative `chunks/` and `figures/` paths resolve next to this file
 *
 * The derived key is kept in sessionStorage, so a reload in the same tab does not
 * ask again; closing the tab forgets it.
 */
import { OPEN_CALLBACK, SHELL_CALLBACK, deriveKey, fromBase64, open, toBase64 } from './lock.mjs';

declare const SHELL_FILE: string;

type Sealed = { salt: string; shell: string };

const SESSION_KEY = 'cror.study-aid.key';
const g = globalThis as unknown as Record<string, unknown>;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const readSession = (): { salt: string; key: string } | null => {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
};

const writeSession = (salt: string, key: Uint8Array): void => {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ salt, key: toBase64(key) }));
  } catch {
    /* private window: ask again next time */
  }
};

let sealedShell: Promise<Sealed> | null = null;
const loadShell = (): Promise<Sealed> =>
  (sealedShell ??= new Promise<Sealed>((resolve, reject) => {
    g[SHELL_CALLBACK] = (salt: string, shell: string) => resolve({ salt, shell });
    const script = document.createElement('script');
    script.src = SHELL_FILE;
    script.onerror = () => {
      sealedShell = null;
      reject(new Error(`Could not load ${SHELL_FILE}`));
    };
    document.head.append(script);
  }));

const gunzip = async (bytes: Uint8Array): Promise<string> =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

/** Opens the shell or throws. Installs the chunk opener only once the key has proven right. */
const enter = async (sealed: Sealed, key: Uint8Array): Promise<void> => {
  const page = await gunzip(open(key, 'shell', fromBase64(sealed.shell)));
  g[OPEN_CALLBACK] = (id: string, box: string) => toBase64(open(key, `chunk:${id}`, fromBase64(box)));
  writeSession(sealed.salt, key);
  document.open();
  document.write(page);
  document.close();
};

const status = (text: string, bad = false): void => {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('bad', bad);
};

const busy = (on: boolean): void => {
  $<HTMLButtonElement>('go').disabled = on;
  $<HTMLInputElement>('password').disabled = on;
};

const submit = async (password: string): Promise<void> => {
  busy(true);
  try {
    status('Loading…');
    const sealed = await loadShell();
    status('Checking password…');
    const key = await deriveKey(password, fromBase64(sealed.salt));
    await enter(sealed, key).catch(() => {
      throw new Error('Wrong password.');
    });
  } catch (e) {
    busy(false);
    status((e as Error).message, true);
    $<HTMLInputElement>('password').select();
  }
};

/** A key remembered from earlier in this tab skips the prompt, if it still fits the shell. */
const resume = async (): Promise<void> => {
  const saved = readSession();
  if (!saved) return;
  busy(true);
  status('Opening…');
  try {
    const sealed = await loadShell();
    if (sealed.salt !== saved.salt) throw new Error('re-sealed since');
    await enter(sealed, fromBase64(saved.key));
  } catch {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* nothing to forget */
    }
    busy(false);
    status('');
  }
};

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submit($<HTMLInputElement>('password').value);
});
void resume();
