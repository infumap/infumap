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

/// What an item is sorted by, under the value key: the number the text starts with, if any, and the text after it
/// (all of it when there is no number). None (as Option<SortValue>) is empty: no title, a missing cell, an unsortable
/// item. Text that is just a number and text that starts with one sort together, by the number first, so "20270102"
/// sorts before "20270102-20270105". The client's SortValue says why numbers aren't split from text.
#[derive(Debug, Clone, PartialEq)]
pub struct SortValue {
  pub number: Option<f64>,
  pub text: String,
}

/// The sort value of text a person typed.
pub fn text_sort_value(text: &str) -> Option<SortValue> {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return None;
  }
  let len = leading_number_len(trimmed);
  if len > 0 {
    if let Ok(number) = trimmed[..len].parse::<f64>() {
      return Some(SortValue { number: Some(number), text: trimmed[len..].to_owned() });
    }
  }
  Some(SortValue { number: None, text: trimmed.to_owned() })
}

/// The length of the plain decimal text starts with, 0 if none ("1,000" starts with 1, "1e3" with 1). Not part of a
/// version or address: "1.10.0" starts with 1, so that the rest, ".10.0", sorts after ".9.0" in natural order.
fn leading_number_len(text: &str) -> usize {
  let bytes = text.as_bytes();
  let digits_from = |i: usize| bytes[i..].iter().take_while(|c| c.is_ascii_digit()).count();
  let sign = usize::from(matches!(bytes.first(), Some(b'-' | b'+')));
  let integer = digits_from(sign);
  let mut end = sign + integer;
  if bytes.get(end) == Some(&b'.') {
    let fraction = digits_from(end + 1);
    let after = end + 1 + fraction;
    let dotted = bytes.get(after) == Some(&b'.') && bytes.get(after + 1).is_some_and(u8::is_ascii_digit);
    if !dotted && (integer > 0 || fraction > 0) {
      end = after;
    }
  }
  if end == sign { 0 } else { end }
}

/// What item shows, as it is sorted by value. A password's text is secret, so it has no value. Nor do items that
/// show nothing (dividers, placeholders).
pub fn item_sort_value(item: &Item) -> Option<SortValue> {
  match item.item_type {
    ItemType::Rating => item.rating.map(|rating| SortValue { number: Some(rating as f64), text: String::new() }),
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

/// Compares sort values: text that starts with a number before text that doesn't, by the number then the rest, and
/// empty last whatever the direction, as in a spreadsheet.
pub fn compare_sort_values(a: &Option<SortValue>, b: &Option<SortValue>, descending: bool) -> Ordering {
  let (a, b) = match (a, b) {
    (None, None) => return Ordering::Equal,
    (None, Some(_)) => return Ordering::Greater,
    (Some(_), None) => return Ordering::Less,
    (Some(a), Some(b)) => (a, b),
  };
  let cmp = match (a.number, b.number) {
    (Some(an), Some(bn)) => an.partial_cmp(&bn).unwrap_or(Ordering::Equal).then_with(|| compare_text(&a.text, &b.text)),
    (Some(_), None) => Ordering::Less,
    (None, Some(_)) => Ordering::Greater,
    (None, None) => compare_text(&a.text, &b.text),
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
  fn text_values_split_off_a_leading_plain_decimal() {
    let value = |number: Option<f64>, text: &str| Some(SortValue { number, text: text.to_owned() });
    assert_eq!(text_sort_value("  42 "), value(Some(42.0), ""));
    assert_eq!(text_sort_value("-1.25"), value(Some(-1.25), ""));
    assert_eq!(text_sort_value(".5"), value(Some(0.5), ""));
    assert_eq!(text_sort_value("5."), value(Some(5.0), ""));
    assert_eq!(text_sort_value("+5 kg"), value(Some(5.0), " kg"));
    assert_eq!(text_sort_value("20270102-20270105"), value(Some(20270102.0), "-20270105"));
    assert_eq!(text_sort_value("1,000"), value(Some(1.0), ",000"));
    assert_eq!(text_sort_value("1e3"), value(Some(1.0), "e3"));
    assert_eq!(text_sort_value("1.10.0"), value(Some(1.0), ".10.0"));
    assert_eq!(text_sort_value("10.0.0.2"), value(Some(10.0), ".0.0.2"));
    assert_eq!(text_sort_value("5..3"), value(Some(5.0), "..3"));
    for text in ["item 9", ".", "-", "- 5", ".5.3", "x1"] {
      assert_eq!(text_sort_value(text), value(None, text), "{text}");
    }
    assert_eq!(text_sort_value("   "), None);
  }

  fn sorted<'a>(values: &[&'a str], descending: bool) -> Vec<&'a str> {
    let mut values = values.iter().map(|v| (*v, text_sort_value(v))).collect::<Vec<_>>();
    values.sort_by(|a, b| compare_sort_values(&a.1, &b.1, descending));
    values.into_iter().map(|(v, _)| v).collect()
  }

  #[test]
  fn compares_numbers_then_text_with_empty_last() {
    let values = ["b", "", "10", "item 10", "-1", "A", "9", "item 9", "1.5", "1.25"];
    assert_eq!(sorted(&values, false), ["-1", "1.25", "1.5", "9", "10", "A", "b", "item 9", "item 10", ""]);
    assert_eq!(sorted(&values, true), ["item 10", "item 9", "b", "A", "10", "9", "1.5", "1.25", "-1", ""]);
  }

  #[test]
  fn text_starting_with_a_number_sorts_among_numbers() {
    let values =
      ["20270103", "20270102-20270105", "20261215-20261220", "20270102", "10", "9.5 kg", "9", "1.10.0", "1.9.0"];
    assert_eq!(
      sorted(&values, false),
      ["1.9.0", "1.10.0", "9", "9.5 kg", "10", "20261215-20261220", "20270102", "20270102-20270105", "20270103"]
    );
    assert_eq!(
      sorted(&values, true),
      ["20270103", "20270102-20270105", "20270102", "20261215-20261220", "10", "9.5 kg", "9", "1.10.0", "1.9.0"]
    );
  }

  #[test]
  fn mixed_values_sort_consistently() {
    // Comparing a number with text by its digits alone ordered these in a cycle: "-5" < "-7x" < "-10" < "-5".
    let values = ["-5", "-7x", "-10", "1.5", "1.20x", "1.25"];
    assert_eq!(sorted(&values, false), ["-10", "-7x", "-5", "1.20x", "1.25", "1.5"]);
  }
}
