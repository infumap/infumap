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

//! lexical_search results as one line each.
//!
//! A line is the hit's location, outermost first, then the hit. Titles above the page or table listing the hit are
//! plain text. From that container down every item is a link, so get_fragment can read any of them, and the
//! container says which of its fragments lists the hit when that is past the first. A group the hit is in follows
//! its page. The hit is a linked label
//! saying what it is, or a table row with its cells. A document hit ends with its best matching sentence and that
//! sentence's fragment ordinal.

use super::container_fragments::HitListing;
use super::*;
use crate::web::routes::command::search::{SearchFragmentMatch, SearchPathElement, SearchResponse, SearchResult};

const LOCATION_TITLE_MAX_CHARS: usize = 60;
const LOCATION_SEPARATOR: &str = " › ";
const SNIPPET_SEPARATOR: &str = " — fragment ";

/// The tool result. Results with the same line, such as a table row and one of its cells, are given once.
pub(super) fn search_results_json(response: &SearchResponse, listings: &HashMap<Uid, HitListing>) -> String {
  let mut seen = HashSet::new();
  let results = response
    .results
    .iter()
    .filter_map(|result| result_line(result, listings))
    .filter(|line| seen.insert(line.clone()))
    .collect::<Vec<_>>();
  serde_json::json!({ "results": results, "hasMore": response.has_more }).to_string()
}

fn result_line(result: &SearchResult, listings: &HashMap<Uid, HitListing>) -> Option<String> {
  let hit = result.path.last()?;
  let listing = listings.get(&hit.id);
  // The listing's text stands for its subject and anything below it on the path.
  let subject = listing
    .and_then(|listing| result.path.iter().rposition(|element| element.id == listing.subject_id))
    .unwrap_or(result.path.len() - 1);
  let ancestors = &result.path[..subject];
  let container = listing.and_then(|listing| {
    let container_id = listing.container_id.as_ref()?;
    let index = ancestors.iter().position(|element| &element.id == container_id)?;
    Some((index, listing.container_fragment))
  });
  let mut parts = ancestors
    .iter()
    .enumerate()
    .map(|(index, element)| match container {
      Some((container, fragment)) if index >= container => {
        let link = element_link(element);
        if index == container && fragment > 0 { format!("{link} (fragment {fragment})") } else { link }
      }
      _ => location_label(element),
    })
    .collect::<Vec<_>>();
  // A group is not an item on the path; it sits between its page and the member holding the hit.
  if let (Some((container, _)), Some(group_id)) = (container, listing.and_then(|listing| listing.group_id.as_ref())) {
    parts.insert(container + 1, format!("[group](infumap://{group_id})"));
  }
  parts.push(listing.map_or_else(|| element_link(hit), |listing| listing.text.clone()));
  let mut line = parts.join(LOCATION_SEPARATOR);
  if let Some(fragment_match) = document_match(result).filter(|fragment_match| !fragment_match.snippet.is_empty()) {
    line.push_str(&format!("{SNIPPET_SEPARATOR}{}: …{}…", fragment_match.fragment_ordinal, fragment_match.snippet));
  }
  Some(line)
}

/// The best match in the hit's document text. A title match repeats the title, and its ordinal is the title
/// index's, which get_fragment cannot read.
fn document_match(result: &SearchResult) -> Option<&SearchFragmentMatch> {
  std::iter::once(&result.fragment_match)
    .flatten()
    .chain(&result.additional_fragment_matches)
    .find(|fragment_match| fragment_match.source_kind != ITEM_TITLE_SOURCE_KIND)
}

fn element_link(element: &SearchPathElement) -> String {
  format!("[{}](infumap://{})", location_label(element).replace('[', "\\[").replace(']', "\\]"), element.id)
}

/// A title on one line, cut to fit, or what the item is when untitled. Composites have no titles.
fn location_label(element: &SearchPathElement) -> String {
  let title = element.title.as_deref().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
  if element.item_type == ItemType::Composite.as_str() {
    "composite".to_owned()
  } else if title.is_empty() {
    format!("untitled {}", element.item_type)
  } else {
    let (clamped, truncated) = clamp_text_chars(&title, LOCATION_TITLE_MAX_CHARS);
    if truncated { format!("{}…", clamped.trim_end()) } else { clamped }
  }
}

/// The hit's label in a result line, for activity summaries: the first link label after the location, or the
/// text after it when the hit is not a link.
pub(super) fn result_line_title(line: &str) -> String {
  let line = line.split(SNIPPET_SEPARATOR).next().unwrap_or(line);
  let own = line.rsplit(LOCATION_SEPARATOR).next().unwrap_or(line);
  let Some(rest) = own.strip_prefix('[') else {
    return own.to_owned();
  };
  let mut label = String::new();
  let mut chars = rest.chars();
  while let Some(ch) = chars.next() {
    match ch {
      '\\' => label.extend(chars.next()),
      ']' => return label,
      ch => label.push(ch),
    }
  }
  own.to_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn element(item_type: &str, title: &str, id: &str) -> SearchPathElement {
    SearchPathElement { item_type: item_type.to_owned(), title: Some(title.to_owned()), id: id.to_owned() }
  }

  fn fragment_match(fragment_ordinal: usize, source_kind: &str) -> SearchFragmentMatch {
    SearchFragmentMatch {
      fragment_ordinal,
      source_kind: source_kind.to_owned(),
      lexical_score: Some(2.0),
      score: 0.5,
      text: "... the match ... another ...".to_owned(),
      text_truncated: false,
      page_start: Some(4),
      page_end: None,
      snippet: "the match".to_owned(),
    }
  }

  fn result(path: Vec<SearchPathElement>, matches: Vec<SearchFragmentMatch>) -> SearchResult {
    let mut matches = matches.into_iter();
    SearchResult {
      path,
      score: 1.0,
      stats: None,
      fragment_match: matches.next(),
      additional_fragment_matches: matches.collect(),
    }
  }

  fn listing(container_id: Option<&str>, container_fragment: usize, subject_id: &str, text: &str) -> HitListing {
    HitListing {
      container_id: container_id.map(str::to_owned),
      container_fragment,
      group_id: None,
      subject_id: subject_id.to_owned(),
      text: text.to_owned(),
    }
  }

  #[test]
  fn results_link_from_the_listing_container_down() {
    let trip = vec![element("page", "root", "r"), element("page", "my trips", "m"), element("page", "malaysia", "p")];
    let in_composite = [trip.clone(), vec![element("composite", "", "c"), element("note", "Cocktails ", "n")]].concat();
    let report = [trip.clone(), vec![element("file", "report.pdf", "f")]].concat();
    let table = vec![element("page", "Home", "h"), element("table", "Tasks [2026]", "t")];
    let row = [table.clone(), vec![element("note", "Acme", "a")]].concat();
    let cell = [row.clone(), vec![element("note", "Active", "s")]].concat();
    let gone = [trip.clone(), vec![element("note", "", "g")]].concat();
    let title_match = || fragment_match(1_000_000_000, ITEM_TITLE_SOURCE_KIND);
    let response = SearchResponse {
      results: vec![
        result(in_composite, vec![title_match()]),
        result(report, vec![title_match(), fragment_match(7, "pdf_markdown")]),
        result(row, Vec::new()),
        result(cell, Vec::new()),
        result(gone, Vec::new()),
      ],
      has_more: true,
    };
    let row_text = "[Acme](infumap://a) | Active";
    let listings = HashMap::from([
      ("n".to_owned(), listing(Some("p"), 0, "n", "[Cocktails](infumap://n)")),
      (
        "f".to_owned(),
        HitListing {
          group_id: Some("g1".to_owned()),
          ..listing(Some("p"), 0, "f", "[report.pdf](infumap://f) (file, application/pdf, 9 fragments)")
        },
      ),
      ("a".to_owned(), listing(Some("t"), 3, "a", row_text)),
      ("s".to_owned(), listing(Some("t"), 3, "a", row_text)),
    ]);

    let json: Value = serde_json::from_str(&search_results_json(&response, &listings)).unwrap();
    assert_eq!(
      json,
      serde_json::json!({
        "results": [
          "root › my trips › [malaysia](infumap://p) › [composite](infumap://c) › [Cocktails](infumap://n)",
          "root › my trips › [malaysia](infumap://p) › [group](infumap://g1) › [report.pdf](infumap://f) \
           (file, application/pdf, 9 fragments) — fragment 7: …the match…",
          "Home › [Tasks \\[2026\\]](infumap://t) (fragment 3) › [Acme](infumap://a) | Active",
          "root › my trips › malaysia › [untitled note](infumap://g)"
        ],
        "hasMore": true
      }),
      "a cell hit is shown as its row, which is given once"
    );

    let titles = json["results"].as_array().unwrap().iter().map(|line| result_line_title(line.as_str().unwrap()));
    assert_eq!(titles.collect::<Vec<_>>(), ["Cocktails", "report.pdf", "Acme", "untitled note"]);
    assert_eq!(result_line_title("Home › [a \\] b](infumap://x)"), "a ] b");
  }
}
