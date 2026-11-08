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

use container_sync::ContainerSyncState;
use infusdk::util::infu::InfuResult;
use ingest_session_db::IngestSessionDb;
use log::debug;
use users_extra_db::UsersExtraDb;

use self::item_db::ItemDb;
use self::pending_user_db::PendingUserDb;
use self::session_db::SessionDb;
use self::user_db::UserDb;

pub mod container_sync;
pub mod ingest_session;
pub mod ingest_session_db;
pub mod item_db;
pub mod pending_user_db;
pub mod session;
pub mod session_db;
pub mod user;
pub mod user_db;
pub mod users_extra;
pub mod users_extra_db;

pub struct Db {
  pub user: UserDb,
  pub user_extra: UsersExtraDb,
  pub pending_user: PendingUserDb,
  pub item: ItemDb,
  pub session: SessionDb,
  pub ingest_session: IngestSessionDb,
  pub container_sync: ContainerSyncState,
}

impl Db {
  pub async fn new(data_dir: &str) -> InfuResult<Db> {
    Ok(Db {
      user: UserDb::init(data_dir).await.map_err(|e| format!("Failed to initialize UserDb: {}", e))?,
      pending_user: PendingUserDb::init(data_dir)
        .await
        .map_err(|e| format!("Failed to initialize Pending UserDb: {}", e))?,
      user_extra: UsersExtraDb::init(data_dir)
        .await
        .map_err(|e| format!("Failed to initialize UsersExtraDb: {}", e))?,
      session: SessionDb::init(data_dir).await.map_err(|e| format!("Failed to initialize SessionDb: {}", e))?,
      ingest_session: IngestSessionDb::init(data_dir)
        .await
        .map_err(|e| format!("Failed to initialize IngestSessionDb: {}", e))?,
      item: ItemDb::init(data_dir),
      container_sync: ContainerSyncState::new(),
    })
  }

  pub fn all_dirty_user_ids(&mut self) -> Vec<String> {
    self.item.all_dirty_user_ids()
  }

  pub async fn create_user_backup_raw(&self, user_id: &str) -> InfuResult<Vec<u8>> {
    let bytes =
      crate::storage::backup::create_raw_backup(&self.item.log_path(user_id)?, &self.user.log_path(user_id)?).await?;
    debug!("Created database log backup for user {} with uncompressed size {} bytes.", user_id, bytes.len());
    Ok(bytes)
  }
}
