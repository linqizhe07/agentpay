import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { MAX_SAVE_BYTES, PREVIEW_BYTES, previewOf, resolveSavePath, writeSaved } from '../src/save.js';

describe('save: resolveSavePath / writeSaved', () => {
  let dir: string;
  let root: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentpay-save-'));
    root = join(dir, 'root');
    mkdirSync(root);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports the documented limits', () => {
    expect(MAX_SAVE_BYTES).toBe(32 * 1024 * 1024);
    expect(PREVIEW_BYTES).toBe(1024);
  });

  it('resolves a relative path under the root, normalised, into directories that need not exist yet', () => {
    const r = resolveSavePath(root, 'massive/AAPL/./2016.json');
    expect(r.path).toBe(join(root, 'massive', 'AAPL', '2016.json'));
    expect(r.rel).toBe('massive/AAPL/2016.json');
    // A root that does not exist yet is fine too (the write creates it).
    const fresh = resolveSavePath(join(dir, 'later'), 'a.json');
    expect(fresh.path).toBe(join(dir, 'later', 'a.json'));
  });

  it('refuses every way out of the root as a ConfigError', () => {
    const refused = (rel: string, why: RegExp) => {
      expect(() => resolveSavePath(root, rel), rel).toThrow(ConfigError);
      expect(() => resolveSavePath(root, rel), rel).toThrow(why);
    };
    refused('', /empty/);
    refused('x'.repeat(201), /longer than 200/);
    refused('a\0b.json', /NUL/);
    refused('/etc/passwd', /absolute/);
    refused('\\windows\\x.json', /absolute/);
    refused('C:\\x.json', /Windows drive/);
    refused('c:x.json', /Windows drive/);
    refused('\\\\server\\share\\x.json', /Windows drive or UNC/);
    refused('//server/share/x.json', /Windows drive or UNC/);
    refused('../x.json', /"\.\." segment/);
    refused('a/../../x.json', /"\.\." segment/);
    refused('a/b/..', /"\.\." segment/);
    refused('..', /"\.\." segment/);
    refused('.', /directory/);
    refused('a/', /directory/);
    // 200 chars exactly is allowed.
    expect(resolveSavePath(root, 'y'.repeat(200)).rel).toBe('y'.repeat(200));
  });

  it('refuses a path that leaves the root through a symlinked directory', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'));
    expect(() => resolveSavePath(root, 'link/x.json')).toThrow(/symlink/);
    expect(() => resolveSavePath(root, 'link/deeper/x.json')).toThrow(/symlink/);
    // A symlink that stays inside the root is not an escape.
    mkdirSync(join(root, 'inside'));
    symlinkSync(join(root, 'inside'), join(root, 'inlink'));
    expect(resolveSavePath(root, 'inlink/x.json').path).toBe(join(root, 'inlink', 'x.json'));
  });

  it('refuses an existing file unless overwrite is set', () => {
    writeFileSync(join(root, 'have.json'), '{}');
    expect(() => resolveSavePath(root, 'have.json')).toThrow(/exists; pass overwrite/);
    expect(resolveSavePath(root, 'have.json', true).path).toBe(join(root, 'have.json'));
  });

  it('refuses a path whose ancestor is an existing file, before anything is paid', () => {
    writeFileSync(join(root, 'bought.json'), '{}');
    // `bought.json/inner.json`: mkdir would throw EEXIST after the payment and name the host's root.
    expect(() => resolveSavePath(root, 'bought.json/inner.json')).toThrow(/directory on the way is an existing file/);
    expect(() => resolveSavePath(root, 'bought.json/deeper/inner.json')).toThrow(/directory on the way is an existing file/);
    expect(resolveSavePath(root, 'fresh/inner.json').path).toBe(join(root, 'fresh', 'inner.json'));
  });

  it('writeSaved creates the directories, writes atomically and returns bytes + sha256', () => {
    const body = Buffer.from('{"hello":"world"}');
    const target = resolve(root, 'deep', 'er', 'file.json');
    const r = writeSaved(target, body);
    expect(r.bytes).toBe(body.byteLength);
    expect(r.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(readFileSync(target)).toEqual(body);
    // No temporary file is left behind beside it.
    expect(readdirSync(resolve(root, 'deep', 'er'))).toEqual(['file.json']);
    // Overwriting replaces the whole content.
    const r2 = writeSaved(target, Buffer.from('x'));
    expect(r2.bytes).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('x');
    expect(existsSync(`${target}.tmp-${process.pid}`)).toBe(false);
  });

  it('previewOf cuts at PREVIEW_BYTES and flags it', () => {
    const small = previewOf(Buffer.from('abc'));
    expect(small).toEqual({ preview: 'abc', preview_truncated: false });
    const big = previewOf(Buffer.from('y'.repeat(5000)));
    expect(big.preview_truncated).toBe(true);
    expect(Buffer.byteLength(big.preview, 'utf8')).toBe(PREVIEW_BYTES);
  });
});
