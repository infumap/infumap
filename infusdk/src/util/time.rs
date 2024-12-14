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

use std::time::SystemTime;

use super::infu::InfuResult;


pub fn unix_now_secs_i64() -> InfuResult<i64> {
  Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64)
}

pub fn unix_now_secs_u64() -> InfuResult<u64> {
  Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs())
}
