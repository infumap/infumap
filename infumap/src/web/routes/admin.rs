// Copyright (C) 2023 The Infumap Authors
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

use std::sync::Mutex;
use rocket::{State, serde::json::Json};
use serde::Serialize;
use crate::storage::db::Db;


#[derive(Serialize)]
pub struct InstallationStateResponse {
  #[serde(rename="hasRootUser")]
  pub has_root_user: bool
}

#[post("/admin/installation-state")]
pub fn installation_state(db: &State<Mutex<Db>>) -> Json<InstallationStateResponse> {
  let db = db.lock().unwrap();
  Json(InstallationStateResponse {
    has_root_user: db.user.get_by_username("root").is_some()
  })
}
