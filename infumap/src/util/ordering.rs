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

/// An ordering before `start`. Matches `newOrderingBefore` in the client's ordering.ts.
pub fn new_ordering_before(start: &Ordering) -> Ordering {
  let mut r = vec![];
  for &value in start {
    if value == 0 {
      r.push(0);
      continue;
    }
    if value > N {
      r.push(value - N);
      return r;
    }
    let to_add = value - 1;
    if to_add > 0 {
      r.push(to_add);
      return r;
    }
    r.push(0);
    r.push(255 - N);
    return r;
  }
  // Should never happen, but a longer string of 0s is defined to be before a shorter one.
  r.push(0);
  r
}

/// An ordering before all of `orderings`.
pub fn new_ordering_at_beginning(orderings: Vec<Vec<u8>>) -> Vec<u8> {
  let Some(mut lowest) = orderings.first() else {
    return new_ordering();
  };
  for ordering in &orderings[1..] {
    if compare_orderings(lowest, ordering) >= 0 {
      lowest = ordering;
    }
  }
  new_ordering_before(lowest)
}

// 0: if (x==y), -1: if (x < y), 1: if (x > y)
pub fn compare_orderings(p1: &Vec<u8>, p2: &Vec<u8>) -> i8 {
  let len = std::cmp::min(p1.len(), p2.len());
  for i in 0..len {
    if p1[i] < p2[i] {
      return -1;
    }
    if p1[i] > p2[i] {
      return 1;
    }
  }
  if p2.len() > p1.len() {
    return -1;
  }
  if p2.len() < p1.len() {
    return 1;
  }
  return 0;
}

pub fn new_ordering_at_end(orderings: Vec<Vec<u8>>) -> Vec<u8> {
  if orderings.len() == 0 {
    return new_ordering();
  }
  let mut highest = &orderings[0];
  for i in 1..orderings.len() {
    if compare_orderings(highest, &orderings[i]) <= 0 {
      highest = &orderings[i];
    }
  }
  return new_ordering_after(highest);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ordering_at_beginning_sorts_first() {
    for orderings in [vec![vec![128]], vec![vec![1]], vec![vec![0, 3], vec![200]], vec![vec![0, 0, 1], vec![5]]] {
      let first = new_ordering_at_beginning(orderings.clone());
      assert!(
        orderings.iter().all(|ordering| compare_orderings(&first, ordering) < 0),
        "{:?} vs {:?}",
        first,
        orderings
      );
    }
    assert_eq!(new_ordering_at_beginning(vec![]), new_ordering());
  }
}
