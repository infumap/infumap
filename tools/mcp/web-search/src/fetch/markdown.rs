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

use htmd::element_handler::{HandlerResult, Handlers};
use htmd::{Element, HtmlToMarkdown};
use markup5ever_rcdom::{Node, NodeData};
use std::rc::Rc;

use crate::error::InfuResult;

pub(super) struct DecodedText {
  pub text: String,
  pub truncated: bool,
}

pub(super) fn html_to_markdown(html: &str) -> InfuResult<String> {
  let converter = HtmlToMarkdown::builder()
    .skip_tags(vec!["script", "style", "nav", "footer", "aside", "noscript", "iframe", "svg", "form"])
    .add_handler(vec!["table"], compact_table)
    .build();
  let source = extract_main_html(html);
  let tree = converter.html_to_tree(&source).map_err(|error| format!("Could not parse rendered HTML: {error}"))?;
  extraction_budget(&tree)?;
  let converted = converter.tree_to_markdown(&tree);
  if converted.len() > MAX_MARKDOWN_BYTES {
    return Err("Extracted Markdown exceeds its 32 MiB memory limit.".into());
  }
  // Retain indentation, code blocks, links, headings and tables. Only collapse
  // blank runs outside fenced code; do not drop labelled document sections.
  let mut lines = Vec::new();
  let mut fence = None;
  let mut blank = false;
  for line in converted.lines() {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
      let marker = &trimmed[..3];
      if fence == Some(marker) {
        fence = None;
      } else if fence.is_none() {
        fence = Some(marker);
      }
    }
    if fence.is_none() && line.trim().is_empty() && blank {
      continue;
    }
    blank = line.trim().is_empty();
    lines.push(line);
  }
  Ok(lines.join("\n").trim().to_owned())
}

fn extract_main_html(html: &str) -> String {
  let document = scraper::Html::parse_document(html);
  for selector_text in ["article", "main", "[role=main]"] {
    let Ok(selector) = scraper::Selector::parse(selector_text) else {
      continue;
    };
    if let Some(node) = document.select(&selector).next() {
      let inner = node.html();
      if inner.len() > 200 {
        return inner;
      }
    }
  }
  html.to_string()
}

pub(super) fn truncate_text(text: &str, max_chars: usize) -> DecodedText {
  if text.is_empty() {
    return DecodedText { text: "(page returned no readable text)".to_string(), truncated: false };
  }
  let total = text.chars().count();
  if total <= max_chars {
    return DecodedText { text: text.to_string(), truncated: false };
  }
  let truncated: String = text.chars().take(max_chars).collect();
  DecodedText { text: format!("{truncated}\n\n... (truncated, {total} chars total)"), truncated: true }
}

const MAX_MARKDOWN_BYTES: usize = 32 * 1024 * 1024;

fn tag(node: &Node) -> &str {
  match &node.data {
    NodeData::Element { name, .. } => name.local.as_ref(),
    _ => "",
  }
}

fn extraction_budget(root: &Rc<Node>) -> InfuResult<()> {
  let mut stack = vec![(root.clone(), 0_usize, 0_usize, 0_u32)];
  let mut nodes = 0;
  let mut estimated = 0_usize;
  while let Some((node, depth, prefixes, tables)) = stack.pop() {
    nodes += 1;
    if nodes > 100_000 || depth > 256 || tables > 4 {
      return Err("Rendered document exceeds its extraction complexity limit.".into());
    }
    let name = tag(&node);
    if matches!(name, "script" | "style" | "svg" | "noscript") {
      continue;
    }
    let prefixes = prefixes + usize::from(matches!(name, "blockquote" | "ul" | "ol"));
    let tables = tables + u32::from(name == "table");
    if let NodeData::Text { contents } = &node.data {
      let text = contents.borrow();
      estimated = estimated
        .saturating_add(text.len().saturating_mul(4 * 6_usize.saturating_pow(tables)))
        .saturating_add((text.bytes().filter(|byte| *byte == b'\n').count() + 1).saturating_mul(prefixes * 4));
    }
    if name == "table" {
      let rows = table_rows(&node);
      let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
      estimated = estimated.saturating_add(rows.len().saturating_mul(columns).saturating_mul(4));
    }
    if estimated > MAX_MARKDOWN_BYTES {
      return Err("Rendered document exceeds its Markdown expansion budget.".into());
    }
    stack.extend(node.children.borrow().iter().map(|child| (child.clone(), depth + 1, prefixes, tables)));
  }
  Ok(())
}

fn table_rows(table: &Rc<Node>) -> Vec<Vec<Rc<Node>>> {
  let mut rows = Vec::new();
  let mut pending = table.children.borrow().clone();
  pending.reverse();
  while let Some(node) = pending.pop() {
    match tag(&node) {
      "table" => {}
      "tr" => {
        rows.push(node.children.borrow().iter().filter(|cell| matches!(tag(cell), "th" | "td")).cloned().collect())
      }
      _ => {
        let mut children = node.children.borrow().clone();
        children.reverse();
        pending.extend(children);
      }
    }
  }
  rows
}

fn compact_table(handlers: &dyn Handlers, element: Element<'_>) -> Option<HandlerResult> {
  // The default formatter pads every row to the longest cell, which can turn
  // a small sparse table into gigabytes. Unpadded pipe tables preserve content
  // and also handle tables without explicit <th> headers.
  let rows = table_rows(element.node);
  let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
  if columns == 0 {
    return Some(handlers.walk_children(element.node));
  }
  let mut result = String::from("\n\n");
  for child in element.node.children.borrow().iter().filter(|node| tag(node) == "caption") {
    result.push_str(handlers.walk_children(child).content.trim());
    result.push_str("\n\n");
  }
  for (index, row) in rows.iter().enumerate() {
    result.push('|');
    for column in 0..columns {
      let cell = row.get(column).map(|node| handlers.walk_children(node).content).unwrap_or_default();
      result.push_str(&cell.trim().replace('|', "&#124;").replace('\r', "").replace('\n', "<br>"));
      result.push('|');
    }
    result.push('\n');
    if index == 0 {
      result.push('|');
      for _ in 0..columns {
        result.push_str("---|");
      }
      result.push('\n');
    }
  }
  result.push('\n');
  Some(result.into())
}
