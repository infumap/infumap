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

use crate::util::uid::Uid;


pub struct Session {
  pub id: Uid,
  pub user_id: Uid,
  pub expires: i64,
  pub username: String,
}

impl Clone for Session {
  fn clone(&self) -> Self {
    Self {
      id: self.id.clone(),
      user_id: self.user_id.clone(),
      expires: self.expires.clone(),
      username: self.username.clone(),
    }
  }
}
