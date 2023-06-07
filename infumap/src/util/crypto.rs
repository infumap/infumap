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

use std::time::{SystemTime, UNIX_EPOCH};
use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, OsRng, rand_core::RngCore, Payload};
use std::io::{Read, Write};
use super::infu::InfuResult;
use super::str::{encode_hex, decode_hex};


const INFUMAP_ENCRYPTED_FILE_VERSION: u8 = 0;
const INFUMAP_ENCRYPTED_FILE_IDENTIFIER: &[u8; 4] = b"infu";


fn generate_nonce() -> [u8; 12] {
  let mut nonce = [0u8; 12];
  OsRng.fill_bytes(&mut nonce);

  // 96 bits of random should be way more than enough to avoid collisions, however
  // I think using unix time as the first 32 bits + 64 bits of random is even better,
  // given that under typical usage I don't think there is really likely to be more
  // than one encrypt operation per second per key (user). Note that a combination
  // of random nonce + counter is a suggested strategy by NIST SP 800-38D. By the
  // birthday paradox, we need to start worrying about collisions at about sqrt(N).
  // Using 64 bits of random, that is 2^32 = 4,294,967,295. This is much bigger
  // than one.
  let mut time_u64 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
  let mut cnt = 0;
  let time = loop {
    match u32::try_from(time_u64) {
      Ok(v) => {
        break v;
      },
      Err(_) => {
        time_u64 -= u32::MAX as u64;
        cnt += 1;
        if cnt > 10 { panic!(); }
      }
    }
  };
  nonce[0] = ((time >> 24) & 0xff) as u8;
  nonce[1] = ((time >> 16) & 0xff) as u8;
  nonce[2] = ((time >> 8) & 0xff) as u8;
  nonce[3] = (time & 0xff) as u8;

  nonce
}


pub fn generate_key() -> String {
  let key = Aes256Gcm::generate_key(&mut OsRng);
  let key_slice = key.as_slice();
  encode_hex(key_slice)
}


pub fn encrypt_file_data(key: &str, data: &[u8], filename: &str) -> InfuResult<Vec<u8>> {
  let key = decode_hex(key)
    .map_err(|e| format!("Invalid hex encoded encryption key: {}.", e))?;
  let cipher = Aes256Gcm::new(key.as_slice().into());
  let nonce = generate_nonce();
  let ciphertext = cipher.encrypt(&nonce.into(), Payload { msg: data, aad: filename.as_bytes() })
    .map_err(|e| format!("Could not encrypt data: {}", e))?;
  let mut out = Vec::new();
  out.write_all(INFUMAP_ENCRYPTED_FILE_IDENTIFIER)?;
  out.write_all(&vec![INFUMAP_ENCRYPTED_FILE_VERSION])?;
  out.write_all(&nonce)?;
  out.write_all(&ciphertext)?;
  Ok(out)
}


pub fn decrypt_file_data(key: &str, data: &[u8], filename: &str) -> InfuResult<Vec<u8>> {
  let key = decode_hex(key)
    .map_err(|e| format!("Invalid hex encoded encryption key: {}.", e))?;
  let cipher = Aes256Gcm::new(key.as_slice().into());

  use std::io::Cursor;
  let mut databuf = Cursor::new(data);

  let mut file_id = [0u8; 4];
  databuf.read_exact(&mut file_id)?;
  let str = String::from_utf8(file_id.into())
    .map_err(|_e| format!("Invalid encrypted file identifier."))?;
  if String::from(str) != String::from_utf8(INFUMAP_ENCRYPTED_FILE_IDENTIFIER.as_slice().into()).unwrap() {
    return Err("Unexpected encrypted file identifier (expecting 'infu').".into());
  }

  let mut version = [0u8; 1];
  databuf.read_exact(&mut version)?;
  let mut nonce = [0u8; 12];
  databuf.read_exact(&mut nonce)?;
  let mut ciphertext = vec![];
  databuf.read_to_end(&mut ciphertext)?;

  Ok(cipher.decrypt(&nonce.into(), Payload { msg: &ciphertext, aad: filename.as_bytes() })
    .map_err(|e| format!("Could not decrypt data: {}", e))?)
}


fn _encrypt_string(_password: String, _key: &str, _data: &str) -> InfuResult<String> {
  // combine the user password with the users randomly generated encryption key,
  // then use a KDF to get the key to use to encrypt.
  // https://kerkour.com/rust-file-encryption-chacha20poly1305-argon2
  panic!();
}


fn _decrypt_string(_password: String, _key: &str, _data: &str) -> InfuResult<String> {
  panic!();
}
