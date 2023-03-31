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


pub type Uid = String;

pub fn uid_chars() -> Vec<&'static str> {
  vec!["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]
}

pub fn new_uid() -> Uid {
  uuid::Uuid::new_v4().to_string().replace("-", "")
}

pub fn is_uid(id_maybe: &str) -> bool {
  // TODO (LOW): check this is valid v4 uuid, or the empty UID.
  if id_maybe.len() != 32 { return false; }
  for c in id_maybe.chars() {
    if !c.is_ascii_hexdigit() {
      return false;
    }
  }
  true
}
