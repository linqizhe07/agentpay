/**
 * Saving a paid response body to a file (`pay --save`, `wallet_pay.save_to`).
 *
 * The body is the payee's bytes, written verbatim; nothing here interprets
 * it. The path is the model's (or the operator's) and the root is the host's
 * (`process.cwd()` for the CLI, a channel directory for a host process), so
 * the only question a save may answer is "does this path stay inside the
 * root": every way out (an absolute path, a `..` segment, a Windows drive or
 * UNC prefix, a symlinked directory pointing elsewhere) is a usage error
 * before anything is sent, and an existing file is never replaced unless
 * `overwrite` says so. A refused path costs nothing: it is checked before
 * the payment.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { ConfigError } from './config.js';

/** The largest body `--save` writes: a bigger one is paid for but not kept (`saved.error: body_too_large`). */
export const MAX_SAVE_BYTES = 32 * 1024 * 1024;
/** How much of a saved body the envelope carries back as `preview` (the model reads the file's shape, never the file). */
export const PREVIEW_BYTES = 1024;
/** The longest relative path `--save` accepts. */
export const MAX_SAVE_PATH_CHARS = 200;

export interface ResolvedSavePath {
  /** Absolute path of the file to write. */
  path: string;
  /** The path as given, POSIX-normalised (what a ledger label carries). */
  rel: string;
}

/** True when `child` is `root` or below it (string prefix on a separator boundary, both already resolved). */
function within(root: string, child: string): boolean {
  const r = relative(root, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * The real location a path would have once created: the realpath of its
 * nearest existing ancestor plus the rest. A symlinked directory inside the
 * root that points outside it resolves outside here, and is refused.
 */
function realIntent(abs: string): string {
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return abs; // nothing exists at all: the filesystem root itself is the ancestor
    tail.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }
  return tail.length === 0 ? realpathSync(existing) : resolve(realpathSync(existing), ...tail);
}

/** The nearest existing ancestor of `abs` (itself included), or undefined when nothing on the way exists. */
function nearestExisting(abs: string): string | undefined {
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return cur;
}

/**
 * Where `rel` lands under `saveRoot`, or a ConfigError naming the rule it
 * broke. `rel` is the caller's relative path (`massive/AAPL/2016.json`);
 * `saveRoot` is the host's directory (need not exist yet: the write creates
 * it). With `overwrite` an existing file may be replaced.
 */
export function resolveSavePath(saveRoot: string, rel: string, overwrite = false): ResolvedSavePath {
  const refuse = (why: string): never => {
    throw new ConfigError(`save path ${JSON.stringify(rel)} refused: ${why}`);
  };
  if (typeof rel !== 'string' || rel.length === 0) refuse('it is empty');
  if (rel.length > MAX_SAVE_PATH_CHARS) refuse(`longer than ${MAX_SAVE_PATH_CHARS} chars`);
  if (rel.includes('\0')) refuse('it contains a NUL byte');
  // A drive letter or a UNC prefix is an absolute path on Windows; on POSIX it would only hide a `\` in a file name.
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('//')) refuse('it starts with a Windows drive or UNC prefix');
  if (isAbsolute(rel) || win32.isAbsolute(rel) || rel.startsWith('\\')) refuse('it is absolute; give a path relative to the save directory');
  const slashed = rel.replace(/\\/g, '/');
  const normalised = posix.normalize(slashed);
  // Before and after normalisation: `a/b/..` would normalise to `a` and stay inside, but a model writing `..` is not writing a file name.
  if ([...slashed.split('/'), ...normalised.split('/')].some((seg) => seg === '..')) refuse('it contains a ".." segment');
  if (normalised === '.' || normalised.endsWith('/')) refuse('it names a directory, not a file');
  const root = resolve(saveRoot);
  const path = resolve(root, normalised);
  if (!within(root, path) || path === root) refuse('it leaves the save directory');
  // Symlink escape: a directory on the way may be a link to somewhere outside the root.
  if (!within(realIntent(root), realIntent(path))) refuse('it resolves (through a symlink) outside the save directory');
  // An ancestor that exists as a FILE (`massive/x.json/inner.json` after
  // `massive/x.json` was bought) would make the write's mkdir throw after the
  // payment, and a thrown fs error names the host's absolute root. Refuse
  // here, before anything is paid, in the caller's own words.
  const ancestor = nearestExisting(dirname(path));
  if (ancestor !== undefined && !statSync(ancestor).isDirectory()) refuse('a directory on the way is an existing file');
  if (existsSync(path) && !overwrite) refuse('the file exists; pass overwrite to replace it');
  return { path, rel: normalised };
}

export interface SavedFile {
  bytes: number;
  sha256: string;
}

/**
 * Writes `body` at `path` (creating the directories): a sibling temporary
 * file, then a rename, so a reader never sees a half-written file and a
 * crash leaves nothing at the final name.
 */
export function writeSaved(path: string, body: Uint8Array): SavedFile {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { bytes: body.byteLength, sha256: sha256Hex(body) };
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The first PREVIEW_BYTES of a body as UTF-8 text (a cut multi-byte character becomes U+FFFD, like the tool's body bound). */
export function previewOf(body: Uint8Array): { preview: string; preview_truncated: boolean } {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return { preview: buf.subarray(0, PREVIEW_BYTES).toString('utf8'), preview_truncated: buf.byteLength > PREVIEW_BYTES };
}
