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

use serde::{Serialize, Deserialize};


pub const GRID_SIZE: i64 = 60;

#[derive(Debug, Serialize, Deserialize)]
pub struct Vector<T> {
  pub x: T,
  pub y: T
}

impl Clone for Vector<i64> {
  fn clone(&self) -> Self {
    Self { x: self.x.clone(), y: self.y.clone() }
  }
}

impl PartialEq for Vector<i64> {
  fn eq(&self, other: &Self) -> bool {
    self.x == other.x && self.y == other.y
  }
}


#[derive(Debug, Serialize, Deserialize)]
pub struct Dimensions<T> {
  pub w: T,
  pub h: T
}

impl Clone for Dimensions<i64> {
  fn clone(&self) -> Self {
    Self { w: self.w.clone(), h: self.h.clone() }
  }
}

impl PartialEq for Dimensions<i64> {
  fn eq(&self, other: &Self) -> bool {
    self.w == other.w && self.h == other.h
  }
}
