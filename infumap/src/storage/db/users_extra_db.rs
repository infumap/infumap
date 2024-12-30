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

use infusdk::db::kv_store::KVStore;
use infusdk::util::infu::InfuResult;
use infusdk::util::time::unix_now_secs_i64;
use infusdk::util::uid::Uid;

use crate::util::fs::expand_tilde;

use super::users_extra::{BackupStatus, UserExtra};

pub const CURRENT_USER_LOG_VERSION: i64 = 1;


/// Db for UserExtra instances.
/// Not thread safe.
pub struct UsersExtraDb {
  store: KVStore<UserExtra>,
}


impl UsersExtraDb {
  pub async fn init(db_dir: &str) -> InfuResult<UsersExtraDb> {
    let mut log_path = expand_tilde(db_dir).ok_or("Could not interpret path.")?;
    log_path.push("users_extra.json");

    let store: KVStore<UserExtra> = KVStore::init(log_path.as_path().to_str().unwrap(), CURRENT_USER_LOG_VERSION).await?;
    Ok(UsersExtraDb { store })
  }

  pub async fn update_backup_status(&mut self, id: &Uid, status: BackupStatus) -> InfuResult<()> {
    match self.get(id) {
      Some(existing) => {
        let mut updated = existing.clone();
        if status == BackupStatus::Failed {
          updated.last_failed_backup_time = unix_now_secs_i64()?;
        } else {
          updated.last_backup_time = unix_now_secs_i64()?;
        }
        self.store.update(updated).await
      },
      None => {
        let user_extra = UserExtra {
          id: id.clone(),
          last_backup_time: if status == BackupStatus::Failed { 0 } else { unix_now_secs_i64()? },
          last_failed_backup_time: if status == BackupStatus::Succeeded { 0 } else { unix_now_secs_i64()? }
        };
        self.store.add(user_extra).await
      }
    }
  }

  pub fn get(&self, id: &Uid) -> Option<&UserExtra> {
    self.store.get(id)
  }
}
