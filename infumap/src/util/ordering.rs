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

/// An ordering between `p1` and `p2`, in either order. Matches `newOrderingBetween` in the client's ordering.ts.
pub fn new_ordering_between(p1: &Ordering, p2: &Ordering) -> Ordering {
  let (p1, p2) = match compare_orderings(p1, p2) {
    0 => return p1.clone(),
    c if c > 0 => (p2, p1),
    _ => (p1, p2),
  };
  let mut r = vec![];
  let mut halve_next = false;
  for i in 0..std::cmp::max(p1.len(), p2.len()) {
    let a = p1.get(i).map_or(0u16, |v| *v as u16);
    let b = p2.get(i).map_or(256u16, |v| *v as u16);
    if halve_next {
      // No room above 255 at this position, so carry on to the next.
      if a == 255 {
        r.push(255);
        continue;
      }
      r.push(((a + 256) / 2) as u8);
      return r;
    }
    let n = (a + b) / 2;
    r.push(n as u8);
    if a != n {
      return r;
    }
    if b != n {
      halve_next = true;
    }
  }
  r.push(128);
  r
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

  #[test]
  fn ordering_between_sorts_strictly_between() {
    let pairs: [(Vec<u8>, Vec<u8>); 7] = [
      (vec![128], vec![129]),
      (vec![128], vec![200]),
      (vec![1], vec![2]),
      (vec![128], vec![128, 1]),
      (vec![255], vec![255, 255, 1]),
      (vec![10, 255, 200], vec![11]),
      (vec![0], vec![0, 0, 1]),
    ];
    for (low, high) in pairs {
      for between in [new_ordering_between(&low, &high), new_ordering_between(&high, &low)] {
        assert!(compare_orderings(&low, &between) < 0, "{:?} < {:?} < {:?}", low, between, high);
        assert!(compare_orderings(&between, &high) < 0, "{:?} < {:?} < {:?}", low, between, high);
      }
    }
  }
}
