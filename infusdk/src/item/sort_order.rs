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

//! How a container orders its children: its order_children_by field. "" is manual order, by the children's
//! orderings. Otherwise `<key>[@<col>][<ASC|DESC>]`, e.g. "value[ASC]", "type[DESC]", "value@2[DESC]":
//!  - key "value": what the child shows, as a SortValue: the title of a titled item, the number of a rating.
//!  - key "type": the child's type (its format, for data items), then its value within a type.
//!  - col: the cell of a table row the key applies to. 0, which is not written, is the row's item. n is its nth
//!    attachment.
//! Anything else means manual order. The web client mirrors this (items/base/sort-order.ts), keep the two in step.

use std::cmp::Ordering;

use super::{Item, ItemType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
  Value,
  Type,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SortOrder {
  pub key: SortKey,
  pub col: usize,
  pub descending: bool,
}

impl SortOrder {
  /// The sort order order_children_by gives, or None for manual order.
  pub fn parse(order_children_by: &str) -> Option<SortOrder> {
    let (rest, descending) = if let Some(rest) = order_children_by.strip_suffix("[ASC]") {
      (rest, false)
    } else {
      (order_children_by.strip_suffix("[DESC]")?, true)
    };
    let (key, col) = match rest.split_once('@') {
      Some((key, col)) => (key, Some(col)),
      None => (rest, None),
    };
    let key = match key {
      // "title" was the value key before item log v41. A page loaded before the server was upgraded may still write it.
      "value" | "title" => SortKey::Value,
      "type" => SortKey::Type,
      _ => return None,
    };
    let col = match col {
      None => 0,
      Some(col) => {
        if col.is_empty() || col.len() > 4 || col.starts_with('0') || !col.bytes().all(|c| c.is_ascii_digit()) {
          return None;
        }
        col.parse().ok()?
      }
    };
    Some(SortOrder { key, col, descending })
  }
}

/// What an item is sorted by, under the value key. None (as Option<SortValue>) is empty: no title, a missing cell,
/// an unsortable item.
#[derive(Debug, Clone, PartialEq)]
pub enum SortValue {
  Number(f64),
  Text(String),
}

/// The sort value of text a person typed: a number when it is just one, so "9" sorts before "10" and "-1".
pub fn text_sort_value(text: &str) -> Option<SortValue> {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return None;
  }
  if is_plain_decimal(trimmed) {
    if let Ok(number) = trimmed.parse::<f64>() {
      return Some(SortValue::Number(number));
    }
  }
  Some(SortValue::Text(trimmed.to_owned()))
}

/// Only plain decimals. Anything else ("1,000", "3 kg", "1e3") is text.
fn is_plain_decimal(text: &str) -> bool {
  let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
  let (integer, fraction) = match unsigned.split_once('.') {
    Some((integer, fraction)) => (integer, Some(fraction)),
    None => (unsigned, None),
  };
  let all_digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
  all_digits(integer)
    && fraction.is_none_or(all_digits)
    && (!integer.is_empty() || fraction.is_some_and(|fraction| !fraction.is_empty()))
}

/// What item shows, as it is sorted by value. A password's text is secret, so it has no value. Nor do items that
/// show nothing (dividers, placeholders).
pub fn item_sort_value(item: &Item) -> Option<SortValue> {
  match item.item_type {
    ItemType::Rating => item.rating.map(|rating| SortValue::Number(rating as f64)),
    ItemType::Page
    | ItemType::Table
    | ItemType::Composite
    | ItemType::Note
    | ItemType::File
    | ItemType::Text
    | ItemType::Image
    | ItemType::Search => item.title.as_deref().and_then(text_sort_value),
    ItemType::Password | ItemType::Link | ItemType::Divider | ItemType::Placeholder => None,
  }
}

/// Compares sort values: numbers before text, and empty last whatever the direction, as in a spreadsheet.
pub fn compare_sort_values(a: &Option<SortValue>, b: &Option<SortValue>, descending: bool) -> Ordering {
  let (a, b) = match (a, b) {
    (None, None) => return Ordering::Equal,
    (None, Some(_)) => return Ordering::Greater,
    (Some(_), None) => return Ordering::Less,
    (Some(a), Some(b)) => (a, b),
  };
  let cmp = match (a, b) {
    (SortValue::Number(a), SortValue::Number(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
    (SortValue::Number(_), SortValue::Text(_)) => Ordering::Less,
    (SortValue::Text(_), SortValue::Number(_)) => Ordering::Greater,
    (SortValue::Text(a), SortValue::Text(b)) => compare_text(a, b),
  };
  if descending { cmp.reverse() } else { cmp }
}

/// Text in natural order, ignoring case: digit runs compare as numbers, so "item 9" sorts before "item 10". The client
/// uses Intl.Collator, which also orders punctuation and accented letters by locale. Here they are in code point
/// order, so the two can differ for those.
fn compare_text(a: &str, b: &str) -> Ordering {
  let (a, b) = (a.to_lowercase(), b.to_lowercase());
  let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
  loop {
    match (a.peek().copied(), b.peek().copied()) {
      (None, None) => return Ordering::Equal,
      (None, Some(_)) => return Ordering::Less,
      (Some(_), None) => return Ordering::Greater,
      (Some(ac), Some(bc)) if ac.is_ascii_digit() && bc.is_ascii_digit() => {
        let take_digits = |chars: &mut std::iter::Peekable<std::str::Chars>| {
          let mut digits = String::new();
          while let Some(c) = chars.next_if(|c| c.is_ascii_digit()) {
            digits.push(c);
          }
          digits
        };
        let (ad, bd) = (take_digits(&mut a), take_digits(&mut b));
        let (an, bn) = (ad.trim_start_matches('0'), bd.trim_start_matches('0'));
        let cmp = an.len().cmp(&bn.len()).then_with(|| an.cmp(bn));
        if cmp != Ordering::Equal {
          return cmp;
        }
      }
      (Some(ac), Some(bc)) => {
        if ac != bc {
          return ac.cmp(&bc);
        }
        a.next();
        b.next();
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_sort_orders() {
    let order = |key, col, descending| Some(SortOrder { key, col, descending });
    assert_eq!(SortOrder::parse("value[ASC]"), order(SortKey::Value, 0, false));
    assert_eq!(SortOrder::parse("title[DESC]"), order(SortKey::Value, 0, true));
    assert_eq!(SortOrder::parse("type[ASC]"), order(SortKey::Type, 0, false));
    assert_eq!(SortOrder::parse("value@2[DESC]"), order(SortKey::Value, 2, true));
    assert_eq!(SortOrder::parse("type@12[ASC]"), order(SortKey::Type, 12, false));
    for manual in
      ["", "value", "value[asc]", "value@0[ASC]", "value@02[ASC]", "value@[ASC]", "value@12345[ASC]", "name[ASC]"]
    {
      assert_eq!(SortOrder::parse(manual), None, "{manual}");
    }
  }

  #[test]
  fn text_values_are_numbers_only_when_plain_decimals() {
    assert_eq!(text_sort_value("  42 "), Some(SortValue::Number(42.0)));
    assert_eq!(text_sort_value("-1.25"), Some(SortValue::Number(-1.25)));
    assert_eq!(text_sort_value(".5"), Some(SortValue::Number(0.5)));
    assert_eq!(text_sort_value("5."), Some(SortValue::Number(5.0)));
    for text in ["1,000", "3 kg", "1e3", ".", "-", "1.2.3"] {
      assert_eq!(text_sort_value(text), Some(SortValue::Text(text.to_owned())), "{text}");
    }
    assert_eq!(text_sort_value("   "), None);
  }

  #[test]
  fn compares_numbers_then_text_with_empty_last() {
    let values = ["b", "", "10", "item 10", "-1", "A", "9", "item 9", "1.5", "1.25"];
    let sorted = |descending| {
      let mut values = values.iter().map(|v| (v, text_sort_value(v))).collect::<Vec<_>>();
      values.sort_by(|a, b| compare_sort_values(&a.1, &b.1, descending));
      values.into_iter().map(|(v, _)| *v).collect::<Vec<_>>()
    };
    assert_eq!(sorted(false), ["-1", "1.25", "1.5", "9", "10", "A", "b", "item 9", "item 10", ""]);
    assert_eq!(sorted(true), ["item 10", "item 9", "b", "A", "10", "9", "1.5", "1.25", "-1", ""]);
  }
}
