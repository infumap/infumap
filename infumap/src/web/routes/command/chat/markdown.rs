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

use infusdk::util::geometry::GRID_SIZE;
use infusdk::util::time::unix_now_secs_u64;
use infusdk::util::uid::{Uid, new_uid};
use serde_json::Value;

use crate::util::ordering::new_ordering_at_end;

const CHAT_RESPONSE_ITEM_WIDTH_GR: i64 = 30 * GRID_SIZE;
const CHAT_RESPONSE_TABLE_MAX_HEIGHT_BL: i64 = 12;
const CHAT_RESPONSE_TABLE_MIN_COLUMN_WIDTH_GR: i64 = 3 * GRID_SIZE;
const CHAT_RESPONSE_TABLE_TEXT_SCORE_CAP: usize = 120;
const CHAT_RESPONSE_TABLE_LONG_WORD_SCORE_CAP: usize = 40;
const NOTE_FLAG_HEADING3: i64 = 0x001;
const NOTE_FLAG_HEADING1: i64 = 0x004;
const NOTE_FLAG_HEADING2: i64 = 0x008;
const NOTE_FLAG_BULLET1: i64 = 0x010;
const NOTE_FLAG_CODE: i64 = 0x200;
const NOTE_FLAG_HEADING4: i64 = 0x1000;
const NOTE_FLAG_NUMBERED: i64 = 0x8000;
const NOTE_INLINE_MARK_BOLD: i64 = 0x001;
const NOTE_INLINE_MARK_ITALIC: i64 = 0x002;
const TABLE_FLAG_SHOW_COL_HEADER: i64 = 0x001;
const TABLE_FLAG_HIDE_TITLE: i64 = 0x002;

struct ChatMarkdownNote {
  title: String,
  flags: i64,
  inline_marks: Vec<i64>,
  urls: Vec<ChatMarkdownUrl>,
}

#[derive(Clone)]
struct ChatMarkdownInlineText {
  title: String,
  inline_marks: Vec<i64>,
  urls: Vec<ChatMarkdownUrl>,
}

#[derive(Clone)]
struct ChatMarkdownUrl {
  start: i64,
  end: i64,
  url: String,
}

struct ChatMarkdownTableRow {
  cells: Vec<ChatMarkdownInlineText>,
}

struct ChatMarkdownTable {
  columns: Vec<String>,
  rows: Vec<ChatMarkdownTableRow>,
}

enum ChatMarkdownItem {
  Note(ChatMarkdownNote),
  Divider,
  Table(ChatMarkdownTable),
}

pub(super) fn chat_response_items_json(owner_id: &Uid, assistant_text: &str) -> Value {
  let now = unix_now_secs_u64().unwrap();
  let composite_id = new_uid();
  let display_text = assistant_text.trim();
  let mut parsed_items = chat_markdown_items_from_text(display_text);

  if parsed_items.is_empty() {
    push_chat_markdown_note(&mut parsed_items, display_text, 0);
  }

  let mut items = Vec::with_capacity(parsed_items.len() + 1);
  items.push(serde_json::json!({
    "itemType": "composite",
    "ownerId": owner_id,
    "id": composite_id.clone(),
    "parentId": null,
    "relationshipToParent": "child",
    "groupId": null,
    "creationDate": now,
    "lastModifiedDate": now,
    "dateTime": now,
    "ordering": [],
    "spatialPositionGr": { "x": 0, "y": 0 },
    "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
    "title": "Assistant",
    "flags": 0x002,
    "orderChildrenBy": "",
  }));

  let mut child_orderings: Vec<Vec<u8>> = Vec::new();
  for parsed_item in parsed_items {
    let ordering = new_ordering_at_end(child_orderings.clone());
    child_orderings.push(ordering.clone());
    match parsed_item {
      ChatMarkdownItem::Note(note) => {
        items.push(chat_response_note_json(owner_id, &composite_id, "child", now, ordering, new_uid(), note))
      }
      ChatMarkdownItem::Divider => items.push(chat_response_divider_json(owner_id, &composite_id, now, ordering)),
      ChatMarkdownItem::Table(table) => {
        items.extend(chat_response_table_json(owner_id, &composite_id, now, ordering, table))
      }
    }
  }

  serde_json::json!({ "items": items })
}

fn chat_response_note_json(
  owner_id: &Uid,
  parent_id: &Uid,
  relationship_to_parent: &str,
  now: u64,
  ordering: Vec<u8>,
  item_id: Uid,
  note: ChatMarkdownNote,
) -> Value {
  serde_json::json!({
      "itemType": "note",
      "ownerId": owner_id,
      "id": item_id,
      "parentId": parent_id,
      "relationshipToParent": relationship_to_parent,
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "title": note.title,
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": 0,
      "flags": note.flags,
      "urls": note.urls.iter().map(|url| {
        serde_json::json!({
          "start": url.start,
          "end": url.end,
          "url": url.url,
        })
      }).collect::<Vec<Value>>(),
      "emoji": null,
      "iconMode": "auto",
      "inlineMarks": note.inline_marks,
  })
}

fn chat_response_divider_json(owner_id: &Uid, parent_id: &Uid, now: u64, ordering: Vec<u8>) -> Value {
  serde_json::json!({
      "itemType": "divider",
      "ownerId": owner_id,
      "id": new_uid(),
      "parentId": parent_id,
      "relationshipToParent": "child",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": GRID_SIZE,
      "dividerDirection": "horizontal",
  })
}

fn chat_response_table_json(
  owner_id: &Uid,
  parent_id: &Uid,
  now: u64,
  ordering: Vec<u8>,
  table: ChatMarkdownTable,
) -> Vec<Value> {
  let table_id = new_uid();
  let column_widths_gr = chat_response_table_column_widths_gr(CHAT_RESPONSE_ITEM_WIDTH_GR, &table);
  let row_count = table.rows.len() as i64;
  let mut items = vec![serde_json::json!({
      "itemType": "table",
      "ownerId": owner_id,
      "id": table_id.clone(),
      "parentId": parent_id,
      "relationshipToParent": "child",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
      "title": "",
      "spatialPositionGr": { "x": 0, "y": 0 },
      "spatialWidthGr": CHAT_RESPONSE_ITEM_WIDTH_GR,
      "spatialHeightGr": row_count.saturating_add(1).clamp(3, CHAT_RESPONSE_TABLE_MAX_HEIGHT_BL) * GRID_SIZE,
      "flags": TABLE_FLAG_SHOW_COL_HEADER | TABLE_FLAG_HIDE_TITLE,
      "tableColumns": table.columns.iter().enumerate().map(|(index, column)| {
        serde_json::json!({
          "name": column,
          "widthGr": column_widths_gr.get(index).copied().unwrap_or(GRID_SIZE),
        })
      }).collect::<Vec<Value>>(),
      "numberOfVisibleColumns": table.columns.len() as i64,
      "orderChildrenBy": "",
  })];

  let mut row_orderings: Vec<Vec<u8>> = Vec::new();
  for row in table.rows {
    let row_ordering = new_ordering_at_end(row_orderings.clone());
    row_orderings.push(row_ordering.clone());

    let row_id = new_uid();
    let first_cell = row.cells.first().cloned().unwrap_or_else(empty_chat_markdown_inline_text);
    items.push(chat_response_note_json(
      owner_id,
      &table_id,
      "child",
      now,
      row_ordering,
      row_id.clone(),
      ChatMarkdownNote {
        title: first_cell.title,
        flags: 0,
        inline_marks: first_cell.inline_marks,
        urls: first_cell.urls,
      },
    ));

    let mut attachment_orderings: Vec<Vec<u8>> = Vec::new();
    let last_cell_index = last_non_empty_chat_table_attachment_cell_index(&row);
    for cell_index in 1..=last_cell_index {
      let attachment_ordering = new_ordering_at_end(attachment_orderings.clone());
      attachment_orderings.push(attachment_ordering.clone());
      let cell = row.cells.get(cell_index).cloned().unwrap_or_else(empty_chat_markdown_inline_text);
      if cell.title.trim().is_empty() {
        items.push(chat_response_placeholder_json(owner_id, &row_id, now, attachment_ordering));
      } else {
        items.push(chat_response_note_json(
          owner_id,
          &row_id,
          "attachment",
          now,
          attachment_ordering,
          new_uid(),
          ChatMarkdownNote { title: cell.title, flags: 0, inline_marks: cell.inline_marks, urls: cell.urls },
        ));
      }
    }
  }

  items
}

fn chat_response_placeholder_json(owner_id: &Uid, parent_id: &Uid, now: u64, ordering: Vec<u8>) -> Value {
  serde_json::json!({
      "itemType": "placeholder",
      "ownerId": owner_id,
      "id": new_uid(),
      "parentId": parent_id,
      "relationshipToParent": "attachment",
      "groupId": null,
      "creationDate": now,
      "lastModifiedDate": now,
      "dateTime": now,
      "ordering": ordering,
  })
}

fn empty_chat_markdown_inline_text() -> ChatMarkdownInlineText {
  ChatMarkdownInlineText { title: "".to_owned(), inline_marks: Vec::new(), urls: Vec::new() }
}

fn last_non_empty_chat_table_attachment_cell_index(row: &ChatMarkdownTableRow) -> usize {
  for index in (1..row.cells.len()).rev() {
    if !row.cells[index].title.trim().is_empty() {
      return index;
    }
  }
  0
}

fn integer_column_widths_gr(total_width_gr: i64, column_count: usize) -> Vec<i64> {
  let safe_column_count = column_count.max(1);
  let integer_total_width_gr = total_width_gr.max(1);
  let base_width_gr = integer_total_width_gr / safe_column_count as i64;
  let remainder_gr = integer_total_width_gr - base_width_gr * safe_column_count as i64;
  (0..safe_column_count).map(|index| base_width_gr + if index < remainder_gr as usize { 1 } else { 0 }).collect()
}

fn weighted_integer_column_widths_gr(total_width_gr: i64, weights: &[f64], min_width_gr: i64) -> Vec<i64> {
  if weights.is_empty() {
    return Vec::new();
  }

  let integer_total_width_gr = total_width_gr.max(1);
  let safe_weights: Vec<f64> = weights.iter().map(|w| if w.is_finite() && *w > 0.0 { *w } else { 1.0 }).collect();
  let total_weight: f64 = safe_weights.iter().sum();
  if total_weight <= 0.0 {
    return integer_column_widths_gr(integer_total_width_gr, weights.len());
  }

  let integer_min_width_gr = min_width_gr.max(0);
  let effective_min_width_gr = integer_min_width_gr.min(integer_total_width_gr / weights.len() as i64);
  let remaining_width_gr = integer_total_width_gr - effective_min_width_gr * weights.len() as i64;
  let exact_widths_gr: Vec<f64> = safe_weights
    .iter()
    .map(|w| effective_min_width_gr as f64 + remaining_width_gr as f64 * *w / total_weight)
    .collect();
  let mut integer_widths_gr: Vec<i64> = exact_widths_gr.iter().map(|w| w.floor() as i64).collect();
  let remainder_gr = integer_total_width_gr - integer_widths_gr.iter().sum::<i64>();
  let mut fractional_order: Vec<(usize, f64)> =
    exact_widths_gr.iter().enumerate().map(|(index, width)| (index, width - width.floor())).collect();
  fractional_order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));

  for index in 0..remainder_gr as usize {
    integer_widths_gr[fractional_order[index % fractional_order.len()].0] += 1;
  }

  integer_widths_gr
}

fn chat_table_cell_text_width_score(text: &str) -> f64 {
  let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() {
    return 0.0;
  }

  let longest_word_length = normalized.split_whitespace().map(|word| word.encode_utf16().count()).max().unwrap_or(0);
  let capped_text_length = normalized.encode_utf16().count().min(CHAT_RESPONSE_TABLE_TEXT_SCORE_CAP);
  let capped_longest_word_length = longest_word_length.min(CHAT_RESPONSE_TABLE_LONG_WORD_SCORE_CAP);
  capped_text_length as f64 * 0.7 + capped_longest_word_length as f64 * 1.3
}

fn chat_table_column_text_weight(table: &ChatMarkdownTable, column_index: usize) -> f64 {
  let mut scores =
    vec![chat_table_cell_text_width_score(table.columns.get(column_index).map(String::as_str).unwrap_or(""))];
  for row in &table.rows {
    scores.push(chat_table_cell_text_width_score(
      row.cells.get(column_index).map(|cell| cell.title.as_str()).unwrap_or(""),
    ));
  }

  let non_empty_scores: Vec<f64> = scores.into_iter().filter(|score| *score > 0.0).collect();
  if non_empty_scores.is_empty() {
    return 1.0;
  }

  let max_score = non_empty_scores.iter().copied().fold(0.0, f64::max);
  let average_score = non_empty_scores.iter().sum::<f64>() / non_empty_scores.len() as f64;
  (max_score * 0.75 + average_score * 0.25).powf(0.8)
}

fn chat_response_table_column_widths_gr(total_width_gr: i64, table: &ChatMarkdownTable) -> Vec<i64> {
  let weights: Vec<f64> =
    table.columns.iter().enumerate().map(|(index, _)| chat_table_column_text_weight(table, index)).collect();
  weighted_integer_column_widths_gr(total_width_gr, &weights, CHAT_RESPONSE_TABLE_MIN_COLUMN_WIDTH_GR)
}

fn chat_markdown_items_from_text(markdown: &str) -> Vec<ChatMarkdownItem> {
  let mut items = Vec::new();
  let mut paragraph_lines: Vec<String> = Vec::new();
  let lines: Vec<&str> = markdown.lines().collect();
  let mut line_index = 0;

  while line_index < lines.len() {
    let line = lines[line_index];

    if line.trim().is_empty() {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      line_index += 1;
      continue;
    }

    if let Some(fence_marker) = markdown_code_fence_marker(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      line_index += 1;
      let mut code_lines = Vec::new();
      while line_index < lines.len() {
        let code_line = lines[line_index];
        if code_line.trim_start().starts_with(fence_marker) {
          break;
        }
        code_lines.push(code_line.to_owned());
        line_index += 1;
      }
      if line_index < lines.len() {
        line_index += 1;
      }
      push_chat_markdown_note(&mut items, &code_lines.join("\n"), NOTE_FLAG_CODE);
      continue;
    }

    if let Some((table, next_line_index)) = markdown_table_at(&lines, line_index) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      items.push(ChatMarkdownItem::Table(table));
      line_index = next_line_index;
      continue;
    }

    if markdown_divider_line(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      items.push(ChatMarkdownItem::Divider);
      line_index += 1;
      continue;
    }

    if let Some((flags, title)) = markdown_heading(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, title, flags);
      line_index += 1;
      continue;
    }

    if let Some((flags, title)) = markdown_list_item(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, title, flags);
      line_index += 1;
      continue;
    }

    if markdown_standalone_inline_heading(line) {
      flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
      push_chat_markdown_note(&mut items, line, 0);
      line_index += 1;
      continue;
    }

    paragraph_lines.push(line.to_owned());
    line_index += 1;
  }

  flush_chat_markdown_paragraph(&mut items, &mut paragraph_lines);
  items
}

fn flush_chat_markdown_paragraph(items: &mut Vec<ChatMarkdownItem>, paragraph_lines: &mut Vec<String>) {
  if paragraph_lines.is_empty() {
    return;
  }
  let paragraph = paragraph_lines.join("\n");
  paragraph_lines.clear();
  push_chat_markdown_note(items, &paragraph, 0);
}

fn push_chat_markdown_note(items: &mut Vec<ChatMarkdownItem>, raw_title: &str, flags: i64) {
  let title =
    if flags & NOTE_FLAG_CODE != 0 { raw_title.trim_matches('\n').to_owned() } else { raw_title.trim().to_owned() };
  if title.is_empty() {
    return;
  }

  let inline_text = if flags & NOTE_FLAG_CODE != 0 {
    ChatMarkdownInlineText { title, inline_marks: Vec::new(), urls: Vec::new() }
  } else {
    parse_markdown_inline(&title)
  };
  if inline_text.title.trim().is_empty() {
    return;
  }

  items.push(ChatMarkdownItem::Note(ChatMarkdownNote {
    title: inline_text.title,
    flags,
    inline_marks: inline_text.inline_marks,
    urls: inline_text.urls,
  }));
}

fn markdown_code_fence_marker(line: &str) -> Option<&'static str> {
  let trimmed = line.trim_start();
  if trimmed.starts_with("```") {
    Some("```")
  } else if trimmed.starts_with("~~~") {
    Some("~~~")
  } else {
    None
  }
}

fn markdown_table_at(lines: &[&str], index: usize) -> Option<(ChatMarkdownTable, usize)> {
  if index + 1 >= lines.len() {
    return None;
  }

  let header_cells = split_markdown_table_row(lines[index])?;
  let separator_cells = split_markdown_table_row(lines[index + 1])?;
  if separator_cells.len() < header_cells.len() || !markdown_table_separator_row(&separator_cells) {
    return None;
  }

  let column_count = header_cells.len();
  let mut rows = Vec::new();
  let mut row_index = index + 2;
  while row_index < lines.len() {
    let Some(row_cells) = split_markdown_table_row(lines[row_index]) else {
      break;
    };
    if markdown_table_separator_row(&row_cells) {
      break;
    }
    rows.push(ChatMarkdownTableRow { cells: normalize_markdown_table_inline_cells(&row_cells, column_count) });
    row_index += 1;
  }

  Some((
    ChatMarkdownTable {
      columns: normalize_markdown_table_cells(&header_cells, column_count)
        .iter()
        .map(|cell| parse_markdown_inline(cell).title)
        .collect(),
      rows,
    },
    row_index,
  ))
}

fn split_markdown_table_row(line: &str) -> Option<Vec<String>> {
  let mut body = line.trim();
  if body.is_empty() {
    return None;
  }

  if body.starts_with('|') {
    body = &body[1..];
  }
  if body.ends_with('|') && (body.len() < 2 || !body[..body.len() - 1].ends_with('\\')) {
    body = &body[..body.len() - 1];
  }

  let mut cells = Vec::new();
  let mut cell = String::new();
  let mut saw_separator = false;
  let mut chars = body.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch == '\\' && chars.peek() == Some(&'|') {
      cell.push('|');
      chars.next();
      continue;
    }
    if ch == '|' {
      cells.push(cell.trim().to_owned());
      cell.clear();
      saw_separator = true;
      continue;
    }
    cell.push(ch);
  }
  cells.push(cell.trim().to_owned());

  if !saw_separator || cells.len() < 2 {
    return None;
  }
  Some(cells)
}

fn markdown_table_separator_cell(cell: &str) -> bool {
  let trimmed = cell.trim();
  let body = trimmed.strip_prefix(':').unwrap_or(trimmed);
  let body = body.strip_suffix(':').unwrap_or(body);
  body.len() >= 3 && body.chars().all(|ch| ch == '-')
}

fn markdown_table_separator_row(cells: &[String]) -> bool {
  cells.len() >= 2 && cells.iter().all(|cell| markdown_table_separator_cell(cell))
}

fn normalize_markdown_table_cells(cells: &[String], column_count: usize) -> Vec<String> {
  let mut result = cells.iter().take(column_count).cloned().collect::<Vec<_>>();
  while result.len() < column_count {
    result.push("".to_owned());
  }
  result
}

fn normalize_markdown_table_inline_cells(cells: &[String], column_count: usize) -> Vec<ChatMarkdownInlineText> {
  normalize_markdown_table_cells(cells, column_count).iter().map(|cell| parse_markdown_inline(cell)).collect()
}

fn markdown_divider_line(line: &str) -> bool {
  let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
  if chars.len() < 3 {
    return false;
  }
  let divider_char = chars[0];
  matches!(divider_char, '-' | '_' | '*') && chars.iter().all(|c| *c == divider_char)
}

fn markdown_heading(line: &str) -> Option<(i64, &str)> {
  let trimmed = line.trim_start();
  let heading_level = trimmed.chars().take_while(|c| *c == '#').count();
  if heading_level == 0 || heading_level > 6 {
    return None;
  }
  let title = &trimmed[heading_level..];
  if !title.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
    return None;
  }
  let title = title.trim();
  if title.is_empty() {
    return None;
  }
  Some((
    match heading_level {
      1 => NOTE_FLAG_HEADING1,
      2 => NOTE_FLAG_HEADING2,
      3 => NOTE_FLAG_HEADING3,
      _ => NOTE_FLAG_HEADING4,
    },
    title,
  ))
}

fn markdown_list_item(line: &str) -> Option<(i64, &str)> {
  let trimmed = line.trim_start();
  let mut chars = trimmed.char_indices();
  if let Some((_, marker)) = chars.next() {
    if matches!(marker, '-' | '*' | '+') {
      if let Some((content_start, separator)) = chars.next() {
        if separator.is_whitespace() {
          return Some((NOTE_FLAG_BULLET1, trimmed[content_start..].trim_start()));
        }
      }
    }
  }

  let mut digit_end = 0;
  let mut has_digit = false;
  for (index, ch) in trimmed.char_indices() {
    if !ch.is_ascii_digit() {
      break;
    }
    has_digit = true;
    digit_end = index + ch.len_utf8();
  }
  if !has_digit || !trimmed[digit_end..].starts_with('.') {
    return None;
  }

  let content = &trimmed[digit_end + 1..];
  if !content.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
    return None;
  }
  Some((NOTE_FLAG_NUMBERED, content.trim_start()))
}

fn markdown_standalone_inline_heading(line: &str) -> bool {
  let trimmed = line.trim();
  for marker in ["***", "___", "**", "__"] {
    if trimmed.len() > marker.len() * 2 && trimmed.starts_with(marker) && trimmed.ends_with(marker) {
      return true;
    }
  }
  false
}

fn parse_markdown_inline(input: &str) -> ChatMarkdownInlineText {
  let mut output = String::new();
  let mut inline_marks = Vec::new();
  let mut urls = Vec::new();
  let mut index = 0;

  while index < input.len() {
    if let Some((escaped, len)) = markdown_escaped_ascii_punctuation(&input[index..]) {
      output.push(escaped);
      index += len;
      continue;
    }

    if input[index..].starts_with("`") {
      let content_start = index + 1;
      if let Some(content_end) = input[content_start..].find('`').map(|offset| content_start + offset) {
        output.push_str(&input[content_start..content_end]);
        index = content_end + 1;
        continue;
      }
    }

    if let Some((label, url, len)) = markdown_link_at(&input[index..]) {
      append_chat_linked_inline_text(&mut output, &mut inline_marks, &mut urls, label, url);
      index += len;
      continue;
    }

    if let Some((marker, flags)) = markdown_inline_marker(&input[index..]) {
      let content_start = index + marker.len();
      if let Some(content_end) = input[content_start..].find(marker).map(|offset| content_start + offset) {
        if content_end > content_start {
          append_chat_marked_inline_text(&mut output, &mut inline_marks, &input[content_start..content_end], flags);
          index = content_end + marker.len();
          continue;
        }
      }
    }

    let ch = input[index..].chars().next().unwrap();
    output.push(ch);
    index += ch.len_utf8();
  }

  ChatMarkdownInlineText { title: output, inline_marks, urls }
}

fn markdown_link_at(slice: &str) -> Option<(&str, String, usize)> {
  if !slice.starts_with('[') {
    return None;
  }

  let label_end = slice[1..].find("](").map(|offset| offset + 1)?;
  let label = &slice[1..label_end];
  if label.trim().is_empty() {
    return None;
  }

  let destination_start = label_end + 2;
  let destination_end = markdown_link_destination_end(&slice[destination_start..])?;
  let destination = markdown_link_destination(&slice[destination_start..destination_start + destination_end])?;
  Some((label, destination, destination_start + destination_end + 1))
}

fn markdown_link_destination_end(slice: &str) -> Option<usize> {
  let mut escaped = false;
  for (index, ch) in slice.char_indices() {
    if escaped {
      escaped = false;
      continue;
    }
    if ch == '\\' {
      escaped = true;
      continue;
    }
    if ch == ')' {
      return Some(index);
    }
  }
  None
}

fn markdown_link_destination(raw_destination: &str) -> Option<String> {
  let trimmed = raw_destination.trim();
  if trimmed.is_empty() {
    return None;
  }

  let destination = if let Some(body) = trimmed.strip_prefix('<') {
    let end = body.find('>')?;
    &body[..end]
  } else {
    trimmed.split_whitespace().next().unwrap_or("")
  };
  let destination = destination.trim();
  if destination.is_empty() { None } else { Some(destination.to_owned()) }
}

fn markdown_escaped_ascii_punctuation(slice: &str) -> Option<(char, usize)> {
  let mut chars = slice.chars();
  if chars.next()? != '\\' {
    return None;
  }

  let escaped = chars.next()?;
  if !escaped.is_ascii_punctuation() {
    return None;
  }

  Some((escaped, '\\'.len_utf8() + escaped.len_utf8()))
}

fn markdown_inline_marker(slice: &str) -> Option<(&'static str, i64)> {
  for (marker, flags) in [
    ("***", NOTE_INLINE_MARK_BOLD | NOTE_INLINE_MARK_ITALIC),
    ("___", NOTE_INLINE_MARK_BOLD | NOTE_INLINE_MARK_ITALIC),
    ("**", NOTE_INLINE_MARK_BOLD),
    ("__", NOTE_INLINE_MARK_BOLD),
    ("*", NOTE_INLINE_MARK_ITALIC),
    ("_", NOTE_INLINE_MARK_ITALIC),
  ] {
    if slice.starts_with(marker) {
      return Some((marker, flags));
    }
  }
  None
}

fn append_chat_marked_inline_text(output: &mut String, inline_marks: &mut Vec<i64>, text: &str, flags: i64) {
  let start = output.encode_utf16().count() as i64;
  append_chat_markdown_unescaped_text(output, text);
  let end = output.encode_utf16().count() as i64;
  push_chat_inline_mark(inline_marks, start, end, flags);
}

fn append_chat_linked_inline_text(
  output: &mut String,
  inline_marks: &mut Vec<i64>,
  urls: &mut Vec<ChatMarkdownUrl>,
  label: &str,
  url: String,
) {
  let start = output.encode_utf16().count() as i64;
  let parsed_label = parse_markdown_inline(label);
  output.push_str(&parsed_label.title);
  append_shifted_chat_inline_marks(inline_marks, &parsed_label.inline_marks, start);
  let end = output.encode_utf16().count() as i64;
  push_chat_url(urls, start, end, url);
}

fn append_shifted_chat_inline_marks(inline_marks: &mut Vec<i64>, shifted_marks: &[i64], offset: i64) {
  for chunk in shifted_marks.chunks_exact(3) {
    push_chat_inline_mark(inline_marks, chunk[0] + offset, chunk[1] + offset, chunk[2]);
  }
}

fn append_chat_markdown_unescaped_text(output: &mut String, text: &str) {
  let mut index = 0;
  while index < text.len() {
    if let Some((escaped, len)) = markdown_escaped_ascii_punctuation(&text[index..]) {
      output.push(escaped);
      index += len;
      continue;
    }

    let ch = text[index..].chars().next().unwrap();
    output.push(ch);
    index += ch.len_utf8();
  }
}

fn push_chat_inline_mark(inline_marks: &mut Vec<i64>, start: i64, end: i64, flags: i64) {
  if start >= end || flags == 0 {
    return;
  }
  if inline_marks.len() >= 3 {
    let last_start_index = inline_marks.len() - 3;
    let last_end = inline_marks[last_start_index + 1];
    let last_flags = inline_marks[last_start_index + 2];
    if start < last_end {
      return;
    }
    if start == last_end && flags == last_flags {
      inline_marks[last_start_index + 1] = end;
      return;
    }
  }

  inline_marks.extend([start, end, flags]);
}

fn push_chat_url(urls: &mut Vec<ChatMarkdownUrl>, start: i64, end: i64, url: String) {
  let url = url.trim().to_owned();
  if start >= end || url.is_empty() {
    return;
  }
  if let Some(last) = urls.last_mut() {
    if start < last.end {
      return;
    }
    if start == last.end && last.url == url {
      last.end = end;
      return;
    }
  }

  urls.push(ChatMarkdownUrl { start, end, url });
}
