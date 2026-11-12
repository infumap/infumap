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


/** What an item is sorted by, under the value key. null is empty: no title, a missing cell, an unsortable item. */
export type SortValue = { number: number, text?: undefined } | { text: string, number?: undefined } | null;

// Only plain decimals. Anything else ("1,000", "3 kg", "1e3") is text.
const NUMBER_REGEX = /^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/;

/** The sort value of text a person typed: a number when it is just one, so "9" sorts before "10" and "-1". */
export function textSortValue(text: string): SortValue {
  const trimmed = text.trim();
  if (trimmed == "") { return null; }
  if (NUMBER_REGEX.test(trimmed)) { return { number: parseFloat(trimmed) }; }
  return { text: trimmed };
}

// numeric: digit runs compare as numbers, so "item 9" sorts before "item 10". Case is ignored, accents aren't.
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" });

/**
 * Compares sort values: numbers before text, and empty last whatever the direction, as in a spreadsheet.
 */
export function compareSortValues(a: SortValue, b: SortValue, descending: boolean): number {
  if (a == null || b == null) { return a == null ? (b == null ? 0 : 1) : -1; }
  let cmp: number;
  if (a.number != null) {
    cmp = b.number != null ? Math.sign(a.number - b.number) : -1;
  } else {
    cmp = b.number != null ? 1 : textCollator.compare(a.text!, b.text!);
  }
  return descending ? -cmp : cmp;
}

/** The direction orderChildrenBy sorts table column col by value in, or null if it doesn't sort by that column. */
export function columnSortDirection(orderChildrenBy: string | null, col: number): "asc" | "desc" | null {
  const order = parseSortOrder(orderChildrenBy);
  if (order == null || order.key != "value" || order.col != col) { return null; }
  return order.descending ? "desc" : "asc";
}
