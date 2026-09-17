import { keccak256, stringToBytes } from 'viem';
import type { Hex } from './types.js';

/** keccak256 over the utf8 bytes of a resource string ('GET /predict'). */
export function hashResource(resource: string): Hex {
  return keccak256(stringToBytes(resource));
}

export function randomBytes32(): Hex {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

/** 'im_3f9a1c…' style identifiers for off-chain records. */
export function newId(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Buffer.from(bytes).toString('hex')}`;
}

/** '0x12345678..abcd' style shortening for log lines. */
export function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 10)}..${value.slice(-4)}`;
}
