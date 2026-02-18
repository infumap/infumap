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

use std::{path::PathBuf, io::Cursor};

use byteorder::{ReadBytesExt, BigEndian};
use clap::{Command, Arg, ArgMatches};
use infusdk::util::infu::InfuResult;
use tokio::{fs::{File, OpenOptions}, io::AsyncWriteExt};

use crate::util::crypto::decrypt_file_data;


pub fn make_clap_subcommand() -> Command {
  Command::new("restore")
    .about("Restore user database logs from a backup file.")
    .arg(Arg::new("backup_file")
      .short('b')
      .long("backup-file")
      .help("Backup file taken from S3 compatible backup object store. File should not be renamed.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("encryption_key")
      .short('k')
      .long("key")
      .help("The 32 byte hex encoded encryption key (64 chars) that was used to encrypt the backup.")
      .num_args(1)
      .required(true))
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  let path = sub_matches.get_one::<String>("backup_file").ok_or("Backup file must be specified.")?;
  let path = PathBuf::from(path);
  let filename = path.file_name().ok_or("No filename present.")?.to_str().ok_or("Filename is empty.")?;
  let parts = filename.split("_").into_iter().map(|s| String::from(s)).collect::<Vec<String>>();
  if parts.len() != 2 {
    return Err(format!("Invalid backup filename: '{}'.", filename).into());
  }
  let user_id = parts.iter().nth(0).unwrap();
  let _timestamp = parts.iter().nth(1).unwrap();

  let encryption_key = sub_matches.get_one::<String>("encryption_key").unwrap();

  let mut f = File::open(&path).await?;
  let mut buffer = vec![0; tokio::fs::metadata(&path).await?.len() as usize];
  tokio::io::AsyncReadExt::read_exact(&mut f, &mut buffer).await?;

  process_backup(&buffer, "items.json", "user.json", encryption_key, user_id, filename).await
}


pub async fn process_backup(buffer: &Vec<u8>, items_path: &str, user_path: &str, encryption_key: &str, user_id: &str, backup_filename: &str) -> InfuResult<()> {
  let unencrypted = decrypt_file_data(&encryption_key, &buffer, backup_filename)?;

  let (compression_type, compressed_data) = if unencrypted.len() > 4 && &unencrypted[0..4] == b"IMZ1" {
    (1u8, &unencrypted[4..])
  } else if unencrypted.len() > 4 && &unencrypted[0..4] == b"IMB0" {
    (0u8, &unencrypted[4..])
  } else {
    (0u8, &unencrypted[..]) // legacy: no header, brotli
  };

  let mut uncompressed = vec![];
  match compression_type {
    1 => {
      let mut zstd_decoder = zstd::stream::Decoder::new(compressed_data)?;
      std::io::copy(&mut zstd_decoder, &mut uncompressed)?;
    },
    _ => {
      let mut u_cursor = std::io::Cursor::new(compressed_data);
      brotli::BrotliDecompress(&mut u_cursor, &mut uncompressed)
        .map_err(|e| format!("Failed to decompress backup data for user {}: {}", user_id, e))?;
    }
  }

  let mut rdr = Cursor::new(&mut uncompressed[0..8]);
  let isize = rdr.read_u64::<BigEndian>()? as usize;
  let mut rdr = Cursor::new(&mut uncompressed[(8+isize)..(16+isize)]);
  let usize = rdr.read_u64::<BigEndian>()? as usize;

  let mut file = OpenOptions::new()
    .create_new(true)
    .write(true)
    .open(items_path).await?;
  file.write_all(&uncompressed[8..(8+isize)]).await?;
  file.flush().await?;

  let mut file = OpenOptions::new()
    .create_new(true)
    .write(true)
    .open(user_path).await?;
  file.write_all(&uncompressed[(16+isize)..(16+isize+usize)]).await?;
  file.flush().await?;

  Ok(())
}
