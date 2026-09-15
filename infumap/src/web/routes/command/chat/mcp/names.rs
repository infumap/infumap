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

use std::collections::HashSet;

const OPENAI_NAME_MAX: usize = 64;

/// True when `name` is a legal OpenAI function name: `^[a-zA-Z0-9_-]{1,64}$`.
pub fn is_legal_openai_name(name: &str) -> bool {
  let len = name.chars().count();
  (1..=OPENAI_NAME_MAX).contains(&len) && name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn sanitize_fragment(value: &str) -> String {
  let mut out = String::new();
  for ch in value.chars() {
    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
      out.push(ch);
    } else {
      out.push('_');
    }
  }
  if out.is_empty() { "_".to_owned() } else { out }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
  value.chars().take(max_chars).collect()
}

/// Map an MCP tool name onto a unique OpenAI function name.
///
/// Passes through when the name is already legal and unused. Otherwise `{server_id}_{sanitized}`
/// with truncation to 64 characters and a numeric suffix on collision.
pub fn openai_tool_name(server_id: &str, mcp_name: &str, used: &mut HashSet<String>) -> String {
  if is_legal_openai_name(mcp_name) && used.insert(mcp_name.to_owned()) {
    return mcp_name.to_owned();
  }

  let prefix = sanitize_fragment(server_id);
  let rest = sanitize_fragment(mcp_name);
  let base = {
    let joined = format!("{prefix}_{rest}");
    let truncated = truncate_chars(&joined, OPENAI_NAME_MAX);
    if is_legal_openai_name(&truncated) { truncated } else { truncate_chars("tool", OPENAI_NAME_MAX) }
  };

  if used.insert(base.clone()) {
    return base;
  }

  for suffix in 2usize.. {
    let suffix_text = format!("_{suffix}");
    let max_base = OPENAI_NAME_MAX.saturating_sub(suffix_text.chars().count()).max(1);
    let candidate = format!("{}{suffix_text}", truncate_chars(&base, max_base));
    if is_legal_openai_name(&candidate) && used.insert(candidate.clone()) {
      return candidate;
    }
  }
  unreachable!();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pass_through_when_legal_and_unique() {
    let mut used = HashSet::new();
    assert_eq!(openai_tool_name("web_search_mcp", "fetch_page", &mut used), "fetch_page");
    assert!(used.contains("fetch_page"));
  }

  #[test]
  fn mangles_on_collision() {
    let mut used = HashSet::from(["search".to_owned()]);
    assert_eq!(openai_tool_name("alpha", "search", &mut used), "alpha_search");
  }

  #[test]
  fn sanitizes_illegal_characters() {
    let mut used = HashSet::new();
    let name = openai_tool_name("srv", "foo.bar/baz", &mut used);
    assert!(is_legal_openai_name(&name), "{name}");
    assert!(name.contains("foo_bar_baz"), "{name}");
  }

  #[test]
  fn suffixes_second_collision() {
    let mut used = HashSet::from(["alpha_search".to_owned(), "search".to_owned()]);
    assert_eq!(openai_tool_name("alpha", "search", &mut used), "alpha_search_2");
  }

  #[test]
  fn stays_within_64_chars() {
    let mut used = HashSet::new();
    let long = "n".repeat(80);
    let name = openai_tool_name("server", &long, &mut used);
    assert!(name.chars().count() <= 64, "{name}");
    assert!(is_legal_openai_name(&name), "{name}");
  }
}
