// Copyright (C) 2022 The Infumap Authors
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

use std::io::Cursor;
use std::sync::Arc;
use byteorder::{WriteBytesExt, BigEndian};
use log::info;

use crate::util::infu::InfuResult;
use self::item_db::ItemDb;
use self::session_db::SessionDb;
use self::user_db::UserDb;
use self::pending_user_db::PendingUserDb;

use super::backup::BackupStore;

pub mod user;
pub mod user_db;
pub mod pending_user_db;
pub mod session;
pub mod session_db;
pub mod item;
pub mod item_db;
pub mod kv_store;

// pub struct BackupIterator {
//   users: Vec<String>,
//   index: usize,
// }

// impl Iterator for BackupIterator {
//   type Item = Vec<u8>;
//   fn next(&mut self) -> Option<i8> {
//       let result = match self.index {
//           0 => self.pixel.r,
//           1 => self.pixel.g,
//           2 => self.pixel.b,
//           _ => return None,
//       };
//       self.index += 1;
//       Some(result)
//   }
// }



pub struct Db {
  pub user: UserDb,
  pub pending_user: PendingUserDb,
  pub item: ItemDb,
  pub session: SessionDb
}

impl Db {
  pub async fn new(data_dir: &str) -> InfuResult<Db> {
    Ok(Db {
      user: UserDb::init(data_dir).await
        .map_err(|e| format!("Failed to initialize UserDb: {}", e))?,
      pending_user: PendingUserDb::init(data_dir).await
        .map_err(|e| format!("Failed to initialize Pending UserDb: {}", e))?,
      session: SessionDb::init(),
      item: ItemDb::init(data_dir),
    })
  }

  pub async fn backup_iter(&self, _object_store: Arc<BackupStore>) -> InfuResult<()> {
    for user_id in self.item.all_loaded_users() {
      let isize = self.item.get_backup_size_for_user(&user_id).await? as usize;
      let usize = self.user.get_backup_size_for_user(&user_id).await? as usize;
      let buf_size = isize + usize + 8 * 2;
      let mut buf = vec![0; buf_size];
      info!("Backup size for user {}: {}", user_id, buf_size);

      let mut wtr = Cursor::new(&mut buf[0..8]);
      wtr.write_u64::<BigEndian>(isize as u64)?;
      self.item.backup_user(&user_id, &mut buf[8..(8+isize)]).await
        .map_err(|e| format!("Failed to get user log backup for user {}: {}", user_id, e))?;

      let mut wtr = Cursor::new(&mut buf[(8+isize)..(16+isize)]);
      wtr.write_u64::<BigEndian>(usize as u64)?;
      self.user.backup_user(&user_id, &mut buf[(16+isize)..(16+isize+usize)]).await
        .map_err(|e| format!("Failed to get item log backup for user {}: {}", user_id, e))?;

      let mut compressed = Vec::with_capacity(buf_size);
      brotli::BrotliCompress(&mut &buf[..], &mut compressed, &Default::default())
        .map_err(|e| format!("Failed to compress backup data for user {}: {}", user_id, e))?;

      println!("Backup compressed size for user {}: {}", user_id, compressed.len());
    }
    Ok(())
  }
}
