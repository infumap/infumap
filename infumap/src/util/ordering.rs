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

pub type Ordering = Vec<u8>;

const N: u8 = 1;


pub fn new_ordering() -> Ordering {
  vec![128]
}


pub fn new_ordering_after(end: &Ordering) -> Ordering {
  let mut r = vec![];

  for i in 0..end.len() {
    if *end.get(i).unwrap() == 255 {
      r.push(255);
      continue;
    }
    if *end.get(i).unwrap() > 255 - N {
      r.push(end.get(i).unwrap() + 1);
      return r;
    }
    r.push(*end.get(i).unwrap() + N);
    return r;
  }

  r.push(N);
  r
}


// 0: if (x==y), -1: if (x < y), 1: if (x > y)
pub fn compare_orderings(p1: &Vec<u8>, p2: &Vec<u8>) -> i8 {
  let len = std::cmp::min(p1.len(), p2.len());
  for i in 0..len {
    if p1[i] < p2[i] { return -1; }
    if p1[i] > p2[i] { return 1; }
  }
  if p2.len() > p1.len() { return -1; }
  if p2.len() < p1.len() { return 1; }
  return 0;
}


pub fn new_ordering_at_end(orderings: Vec<Vec<u8>>) -> Vec<u8> {
  if orderings.len() == 0 { return new_ordering(); }
  let mut highest = &orderings[0];
  for i in 1..orderings.len() {
    if compare_orderings(highest, &orderings[i]) <= 0 { highest = &orderings[i]; }
  }
  return new_ordering_after(highest);
}
