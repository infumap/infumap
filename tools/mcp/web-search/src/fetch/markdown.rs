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

use htmd::HtmlToMarkdown;

pub(super) struct DecodedText {
  pub text: String,
  pub truncated: bool,
}

pub(super) fn html_to_markdown(html: &str) -> String {
  let converter = HtmlToMarkdown::builder()
    .skip_tags(vec!["script", "style", "nav", "footer", "aside", "noscript", "iframe", "svg", "form"])
    .build();
  let source = extract_main_html(html);
  converter.convert(&source).unwrap_or(source).trim().to_string()
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
