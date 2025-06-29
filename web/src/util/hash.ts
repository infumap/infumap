/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Uid } from './uid';
import * as xxhash from 'xxhashjs';


/**
 * Converts a string to a UID using xxHash64 in a collision-resistant way
 */
export function hashStringToUid(s: string): Uid {
  const hash = xxhash.h64(s, 0).toString(16); // seed 0 to match Rust

  // Pad to 16 characters (64-bit hex), then duplicate to get 32 characters
  const paddedHash = hash.padStart(16, '0');
  const doubledHash = paddedHash + paddedHash;

  return doubledHash.substring(0, 32);
}

/**
 * Converts a number to a UID using xxHash64 in a collision-resistant way
 */
export function hashI64ToUid(value: number): Uid {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigInt64(0, BigInt(value), true); // little-endian to match Rust

  // Hash the byte array using xxHash64
  const hash = xxhash.h64(buffer, 0).toString(16); // seed 0 to match Rust

  // Pad to 16 characters (64-bit hex), then duplicate to get 32 characters
  const paddedHash = hash.padStart(16, '0');
  const doubledHash = paddedHash + paddedHash;

  return doubledHash.substring(0, 32);
}

/**
 * Converts a f64 number to a UID using xxHash64 in a collision-resistant way
 */
export function hashF64ToUid(value: number): Uid {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true); // little-endian to match Rust

  // Hash the byte array using xxHash64
  const hash = xxhash.h64(buffer, 0).toString(16); // seed 0 to match Rust

  // Pad to 16 characters (64-bit hex), then duplicate to get 32 characters
  const paddedHash = hash.padStart(16, '0');
  const doubledHash = paddedHash + paddedHash;

  return doubledHash.substring(0, 32);
}

/**
 * Converts a byte array to a UID using xxHash64 in a collision-resistant way
 */
export function hashU8VecToUid(bytes: Uint8Array): Uid {
  // Convert to ArrayBuffer for xxhash compatibility
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  // Hash the byte array using xxHash64
  const hash = xxhash.h64(buffer, 0).toString(16); // seed 0 to match Rust

  // Pad to 16 characters (64-bit hex), then duplicate to get 32 characters
  const paddedHash = hash.padStart(16, '0');
  const doubledHash = paddedHash + paddedHash;

  return doubledHash.substring(0, 32);
}

/**
 * Combines multiple hash values to create a new hash in a commutative way using XOR
 * The operation is naturally commutative: combineHashes([a, b]) === combineHashes([b, a])
 * Optimized for performance - O(n) complexity with minimal memory allocation
 */
export function combineHashes(hashes: Uid[]): Uid {
  if (hashes.length === 0) {
    return "00000000000000000000000000000000";
  }

  if (hashes.length === 1) {
    return hashes[0];
  }

  // XOR all hashes together - naturally commutative and very fast
  const result = new Uint8Array(16); // 32 hex chars = 16 bytes

  for (const hash of hashes) {
    // Convert hex string to bytes and XOR with result
    for (let i = 0; i < 16 && i * 2 < hash.length; i++) {
      const hexPair = hash.substring(i * 2, i * 2 + 2);
      const byteVal = parseInt(hexPair, 16);
      if (!isNaN(byteVal)) {
        result[i] ^= byteVal;
      }
    }
  }

  // Convert back to hex string
  return Array.from(result)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
