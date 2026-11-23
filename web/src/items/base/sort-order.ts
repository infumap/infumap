/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * How a container orders its children: its orderChildrenBy field. "" is manual order, by the children's orderings.
 * Otherwise `<key>[@<col>][<ASC|DESC>]`, e.g. "value[ASC]", "type[DESC]", "value@2[DESC]":
 *  - key "value": what the child shows, as a SortValue: the title of a titled item, the number of a rating.
 *  - key "type": the child's type (its format, for data items), then its value within a type.
 *  - col: the cell of a table row the key applies to. 0, which is not written, is the row's item. n is its nth
 *    attachment.
 * Anything else means manual order. The server mirrors this (infusdk::item::sort_order), keep the two in step.
 */
export type SortKey = "value" | "type";

export interface SortOrder {
  key: SortKey,
  col: number,
  descending: boolean,
}

// "title" was the value key before item log v41. A page loaded before the server was upgraded may still write it.
const SORT_ORDER_REGEX = /^(value|type|title)(?:@([1-9][0-9]{0,3}))?\[(ASC|DESC)\]$/;

/** The sort order orderChildrenBy gives, or null for manual order. */
export function parseSortOrder(orderChildrenBy: string | null): SortOrder | null {
  const match = orderChildrenBy == null ? null : SORT_ORDER_REGEX.exec(orderChildrenBy);
  if (match == null) { return null; }
  return {
    key: match[1] == "type" ? "type" : "value",
    col: match[2] == null ? 0 : parseInt(match[2]),
    descending: match[3] == "DESC",
  };
}

/** The orderChildrenBy value for order, "" for manual order (null). */
export function formatSortOrder(order: SortOrder | null): string {
  if (order == null) { return ""; }
  return order.key + (order.col > 0 ? "@" + order.col : "") + (order.descending ? "[DESC]" : "[ASC]");
}


/**
 * What an item is sorted by, under the value key: the number the text starts with, if any, and the text after it
 * (all of it when there is no number). null is empty: no title, a missing cell, an unsortable item.
 *
 * Text that is just a number and text that starts with one sort together, by the number first, so "20270102" sorts
 * before "20270102-20270105" and "9" before "9.5 kg" before "10". Splitting numbers from text instead, as a spreadsheet
 * does, put every bare date after every date range when descending. Comparing a number with text by the number's
 * digits alone was tried too, but isn't a consistent order: "-5" < "-7x" < "-10" < "-5".
 */
export type SortValue = { number: number | null, text: string } | null;

// A plain decimal at the start ("1,000" starts with 1, "1e3" with 1). Not part of a version or address: "1.10.0"
// starts with 1, so that the rest, ".10.0", sorts after ".9.0" in natural order.
const LEADING_NUMBER_REGEX = /^[-+]?(?:[0-9]+(?:\.[0-9]*(?![0-9]|\.[0-9]))?|\.[0-9]+(?![0-9]|\.[0-9]))/;

/** The sort value of text a person typed. */
export function textSortValue(text: string): SortValue {
  const trimmed = text.trim();
  if (trimmed == "") { return null; }
  const match = LEADING_NUMBER_REGEX.exec(trimmed);
  if (match == null) { return { number: null, text: trimmed }; }
  return { number: parseFloat(match[0]), text: trimmed.substring(match[0].length) };
}

// numeric: digit runs compare as numbers, so "item 9" sorts before "item 10". Case is ignored, accents aren't.
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });

/**
 * Compares sort values: text that starts with a number before text that doesn't, by the number then the rest, and
 * empty last whatever the direction, as in a spreadsheet.
 */
export function compareSortValues(a: SortValue, b: SortValue, descending: boolean): number {
  if (a == null || b == null) { return a == null ? (b == null ? 0 : 1) : -1; }
  let cmp: number;
  if (a.number != null && b.number != null) {
    cmp = Math.sign(a.number - b.number) || textCollator.compare(a.text, b.text);
  } else if (a.number != null || b.number != null) {
    cmp = a.number != null ? -1 : 1;
  } else {
    cmp = textCollator.compare(a.text, b.text);
  }
  return descending ? -cmp : cmp;
}

/** The direction orderChildrenBy sorts table column col by value in, or null if it doesn't sort by that column. */
export function columnSortDirection(orderChildrenBy: string | null, col: number): "asc" | "desc" | null {
  const order = parseSortOrder(orderChildrenBy);
  if (order == null || order.key != "value" || order.col != col) { return null; }
  return order.descending ? "desc" : "asc";
}
