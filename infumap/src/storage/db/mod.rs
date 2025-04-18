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

use std::io::Cursor;
use byteorder::{WriteBytesExt, BigEndian};
use infusdk::util::infu::InfuResult;
use log::debug;
use users_extra_db::UsersExtraDb;

use self::item_db::ItemDb;
use self::session_db::SessionDb;
use self::user_db::UserDb;
use self::pending_user_db::PendingUserDb;

pub mod user;
pub mod user_db;
pub mod users_extra;
pub mod users_extra_db;
pub mod pending_user_db;
pub mod session;
pub mod session_db;
pub mod item_db;


pub struct Db {
  pub user: UserDb,
  pub user_extra: UsersExtraDb,
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
      user_extra: UsersExtraDb::init(data_dir).await
        .map_err(|e| format!("Failed to initialize UsersExtraDb: {}", e))?,
      session: SessionDb::init(data_dir).await
        .map_err(|e| format!("Failed to initialize SessionDb: {}", e))?,
      item: ItemDb::init(data_dir),
    })
  }

  pub fn all_dirty_user_ids(&mut self) -> Vec<String> {
    self.item.all_dirty_user_ids()
  }

  pub async fn create_user_backup_raw(&self, user_id: &str) -> InfuResult<Vec<u8>> {
    let item_log_size_bytes = self.item.get_log_size_bytes_for_user(&user_id).await? as usize;
    let user_log_size_bytes = self.user.get_log_size_bytes_for_user(&user_id).await? as usize;
    let buf_size = item_log_size_bytes + user_log_size_bytes + 8 * 2;
    let mut buf = vec![0; buf_size];
    debug!("Creating database log backup for user {} with uncompressed size {} bytes.", user_id, buf_size);

    let mut wtr = Cursor::new(&mut buf[0..8]);
    wtr.write_u64::<BigEndian>(item_log_size_bytes as u64)?;
    self.item.backup_user(&user_id, &mut buf[8..(8+item_log_size_bytes)]).await
      .map_err(|e| format!("Failed to get user database log for user {}: {}", user_id, e))?;

    let mut wtr = Cursor::new(&mut buf[(8+item_log_size_bytes)..(16+item_log_size_bytes)]);
    wtr.write_u64::<BigEndian>(user_log_size_bytes as u64)?;
    self.user.backup_user(&user_id, &mut buf[(16+item_log_size_bytes)..(16+item_log_size_bytes+user_log_size_bytes)]).await
      .map_err(|e| format!("Failed to get item database log for user {}: {}", user_id, e))?;

    Ok(buf)
  }

}
