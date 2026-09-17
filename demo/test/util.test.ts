import { describe, expect, it } from 'vitest';
import { parseOnly, short } from '../src/util.js';

describe('demo util', () => {
  it('parses --only in both spellings', () => {
    expect(parseOnly(['--only', 'batch'])).toBe('batch');
    expect(parseOnly(['--only=batch'])).toBe('batch');
    expect(parseOnly([])).toBeUndefined();
  });
  it('shortens long hex strings only', () => {
    expect(short('0x1234')).toBe('0x1234');
    expect(short(`0x${'a'.repeat(64)}`)).toBe('0xaaaaaaaa..aaaa');
  });
});
