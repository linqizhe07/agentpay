import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable file primitives for the two wallet files the budget depends on.
 * Both are what `remaining()` is computed from after a restart (the ledger
 * rebuilds the counters, mandates.json caches them), so their writes must
 * survive a power cut, not only a process crash: a rename or append that only
 * reached the page cache can come back empty or short and would fail open.
 */

function writeAll(fd: number, data: string): void {
  const buf = Buffer.from(data, 'utf8');
  let written = 0;
  while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
}

/** Best effort: makes the directory entry durable after a rename or create (not every platform lets a directory be opened). */
function fsyncDir(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch {
    /* Windows and some filesystems refuse; the data itself is already fsynced */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Appends one already newline-terminated line and fsyncs it before returning. */
export function appendDurableSync(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeAll(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(path);
}

/** Writes `data` to `tmp`, fsyncs it, renames it over `path` and fsyncs the directory: readers see the old file or the new one. */
export function replaceDurableSync(path: string, tmp: string, data: string): void {
  const fd = openSync(tmp, 'w');
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(path);
}
