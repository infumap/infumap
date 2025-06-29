// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use twox_hash::XxHash64;
use std::hash::Hasher;
use super::uid::Uid;


/// Converts a string to a UID using xxHash64 in a collision-resistant way
pub fn hash_string_to_uid(s: &str) -> Uid {
    let mut hasher = XxHash64::with_seed(0);
    hasher.write(s.as_bytes());
    let hash = hasher.finish();

    // Convert to hex string and pad to 32 characters to match UID format
    format!("{:016x}{:016x}", hash, hash)[..32].to_string()
}

/// Converts an i64 to a UID using xxHash64 in a collision-resistant way
pub fn hash_i64_to_uid(value: i64) -> Uid {
    let mut hasher = XxHash64::with_seed(0);
    hasher.write(&value.to_le_bytes());
    let hash = hasher.finish();

    // Convert to hex string and pad to 32 characters to match UID format
    format!("{:016x}{:016x}", hash, hash)[..32].to_string()
}

/// Converts an f64 to a UID using xxHash64 in a collision-resistant way
pub fn hash_f64_to_uid(value: f64) -> Uid {
    let mut hasher = XxHash64::with_seed(0);
    hasher.write(&value.to_le_bytes());
    let hash = hasher.finish();

    // Convert to hex string and pad to 32 characters to match UID format
    format!("{:016x}{:016x}", hash, hash)[..32].to_string()
}

/// Converts a byte vector to a UID using xxHash64 in a collision-resistant way
pub fn hash_u8_vec_to_uid(bytes: &[u8]) -> Uid {
    let mut hasher = XxHash64::with_seed(0);
    hasher.write(bytes);
    let hash = hasher.finish();

    // Convert to hex string and pad to 32 characters to match UID format
    format!("{:016x}{:016x}", hash, hash)[..32].to_string()
}

/// Combines multiple hash values to create a new hash in a commutative way using XOR
pub fn combine_hashes(hashes: &[&Uid]) -> Uid {
  if hashes.is_empty() {
    return "00000000000000000000000000000000".to_string();
  }

  if hashes.len() == 1 {
    return (*hashes[0]).clone();
  }

  // XOR all hashes together - naturally commutative and very fast
  let mut result = [0u8; 16]; // 32 hex chars = 16 bytes

  for hash in hashes {
    // Convert hex string to bytes and XOR with result
    for (i, chunk) in hash.chars().collect::<Vec<_>>().chunks(2).enumerate() {
      if i >= 16 { break; } // Only use first 32 hex chars (16 bytes)
      let hex_str: String = chunk.iter().collect();
      if let Ok(byte_val) = u8::from_str_radix(&hex_str, 16) {
        result[i] ^= byte_val;
      }
    }
  }

  // Convert back to hex string
  result.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}
