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

use super::scope::{ResolvedScope, resolve_scope};
use super::*;

const SEARCH_RRF_K: f64 = 60.0;
const SEARCH_TITLE_LEXICAL_WEIGHT: f64 = 1.35;
const SEARCH_FRAGMENT_LEXICAL_WEIGHT: f64 = 1.15;
const SEARCH_CANDIDATE_OVERFETCH: i64 = 50;
const SEARCH_LEXICAL_FRAGMENT_MULTIPLIER: usize = 4;
const SEARCH_LEXICAL_MATCHES_PER_RESULT: usize = 2;
const SEARCH_FRAGMENT_MATCH_MAX_CHARS: usize = 1250;
const SEARCH_MATCH_SNIPPET_MAX_SENTENCES: usize = 3;
const SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS: usize = 220;
const SEARCH_MATCH_SNIPPET_CONTEXT_BEFORE_CHARS: usize = 70;
const SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS: usize = 20;
const SEARCH_BM25_SCORE_SATURATION: f32 = 4.0;
const SEARCH_SNIPPET_ELLIPSIS: &str = "...";
const PDF_CATALOG_OMITTED_LABELS: [&str; 3] = ["document", "context", "section"];
const SEARCH_SNIPPET_STOP_WORDS: [&str; 32] = [
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "her", "his", "in", "is", "it", "its",
  "of", "on", "or", "she", "that", "the", "their", "this", "to", "was", "were", "with", "you", "your",
];

#[derive(Deserialize)]
pub struct SearchRequest {
  #[serde(rename = "pageId")]
  pub page_id: Option<Uid>,
  pub text: String,
  #[serde(rename = "numResults")]
  pub num_results: i64,
  #[serde(rename = "pageNum")]
  pub page_num: Option<i64>,
  /// A scope page from the user's scopes page. When given with `page_id`, both apply. Read by the search
  /// command only: chat resolves its scope once per run and passes it to `run_lexical_search`.
  #[serde(rename = "scopeId", default)]
  pub scope_id: Option<Uid>,
}

/// Which items a search may return.
enum SearchBounds {
  /// Readable items under this item. Used for unrestricted searches of the home page tree.
  UnderRoot(Uid),
  /// Exactly these items. Used when a page or scope restricts the search.
  Items(Vec<Uid>),
}

impl SearchBounds {
  fn root_id(&self) -> Option<&Uid> {
    match self {
      SearchBounds::UnderRoot(root_id) => Some(root_id),
      SearchBounds::Items(_) => None,
    }
  }

  fn allowed_item_ids(&self) -> Option<&[Uid]> {
    match self {
      SearchBounds::UnderRoot(_) => None,
      SearchBounds::Items(item_ids) => Some(item_ids),
    }
  }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchPathElement {
  #[serde(rename = "itemType")]
  pub item_type: String,
  pub title: Option<String>,
  pub id: Uid,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchResult {
  #[serde(rename = "path")]
  pub path: Vec<SearchPathElement>,
  pub score: f32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub stats: Option<SearchResultStats>,
  #[serde(rename = "fragmentMatch", skip_serializing_if = "Option::is_none")]
  pub fragment_match: Option<SearchFragmentMatch>,
  #[serde(rename = "additionalFragmentMatches", skip_serializing_if = "Vec::is_empty")]
  pub additional_fragment_matches: Vec<SearchFragmentMatch>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchResultStats {
  #[serde(rename = "totalChildren")]
  pub total_children: usize,
  #[serde(rename = "imageFileChildren")]
  pub image_file_children: usize,
  #[serde(rename = "totalBytes")]
  pub total_bytes: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SearchFragmentMatch {
  #[serde(rename = "fragmentOrdinal")]
  pub fragment_ordinal: usize,
  #[serde(rename = "sourceKind")]
  pub source_kind: String,
  #[serde(rename = "lexicalScore", skip_serializing_if = "Option::is_none")]
  pub lexical_score: Option<f32>,
  pub score: f32,
  pub text: String,
  #[serde(rename = "textTruncated")]
  pub text_truncated: bool,
  #[serde(rename = "pageStart", skip_serializing_if = "Option::is_none")]
  pub page_start: Option<usize>,
  #[serde(rename = "pageEnd", skip_serializing_if = "Option::is_none")]
  pub page_end: Option<usize>,
}

#[derive(Serialize)]
pub struct SearchResponse {
  pub results: Vec<SearchResult>,
  #[serde(rename = "hasMore")]
  pub has_more: bool,
}

#[allow(dead_code)]
pub(super) mod compact {
  use super::*;

  /// Longer titles, usually note text, are cut. The caller can say how many fragments hold the rest.
  pub(in crate::web::routes::command) const TITLE_MAX_CHARS: usize = 300;
  const LOCATION_TITLE_MAX_CHARS: usize = 60;

  #[derive(Serialize)]
  pub(super) struct CompactSearchResponse<'a, E> {
    pub results: Vec<CompactSearchResult<'a, E>>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
  }

  #[derive(Serialize)]
  pub(super) struct CompactSearchResult<'a, E> {
    /// The result's only id: `infumap://<id>`, which the tools accept wherever they take an id.
    #[serde(rename = "link")]
    pub link_url: String,
    #[serde(rename = "itemType")]
    pub item_type: String,
    pub title: Option<String>,
    /// Titles of the containing items, outermost first. The one whose fragments list the result is a link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// The listing container's link, when it is not among the location's titles.
    #[serde(rename = "listedIn", skip_serializing_if = "Option::is_none")]
    pub listed_in: Option<String>,
    /// Fields the caller adds for this result.
    #[serde(flatten)]
    pub extra: Option<&'a E>,
    #[serde(rename = "fragmentMatch", skip_serializing_if = "Option::is_none")]
    pub fragment_match: Option<CompactSearchFragmentMatch>,
  }

  #[derive(Serialize)]
  pub(super) struct CompactSearchFragmentMatch {
    #[serde(rename = "fragmentOrdinal")]
    pub fragment_ordinal: usize,
    pub text: String,
    #[serde(rename = "textTruncated", skip_serializing_if = "std::ops::Not::not")]
    pub text_truncated: bool,
  }

  pub(super) fn compact_search_response<'a, E>(
    response: &SearchResponse,
    extras: &'a HashMap<Uid, E>,
    listed_in: &HashMap<Uid, Uid>,
  ) -> CompactSearchResponse<'a, E> {
    CompactSearchResponse {
      results: response.results.iter().filter_map(|result| compact_search_result(result, extras, listed_in)).collect(),
      has_more: response.has_more,
    }
  }

  fn compact_search_result<'a, E>(
    result: &SearchResult,
    extras: &'a HashMap<Uid, E>,
    listed_in: &HashMap<Uid, Uid>,
  ) -> Option<CompactSearchResult<'a, E>> {
    let (item, ancestors) = result.path.split_last()?;
    let container_id = listed_in.get(&item.id);
    let mut container_linked = false;
    let location = ancestors
      .iter()
      .map(|element| {
        let label = location_label(element);
        if container_id == Some(&element.id) {
          container_linked = true;
          format!("[{}](infumap://{})", label.replace('[', "\\[").replace(']', "\\]"), element.id)
        } else {
          label
        }
      })
      .collect::<Vec<_>>()
      .join(" › ");
    // A title match repeats the title, and its ordinal is the title index's, which get_fragment cannot read.
    let fragment_match = std::iter::once(&result.fragment_match)
      .flatten()
      .chain(&result.additional_fragment_matches)
      .find(|fragment_match| fragment_match.source_kind != ITEM_TITLE_SOURCE_KIND);
    Some(CompactSearchResult {
      link_url: format!("infumap://{}", item.id),
      item_type: item.item_type.clone(),
      title: item.title.as_deref().map(|title| clamp_with_ellipsis(title, TITLE_MAX_CHARS)),
      location: Some(location).filter(|location| !location.is_empty()),
      listed_in: container_id.filter(|_| !container_linked).map(|container_id| format!("infumap://{container_id}")),
      extra: extras.get(&item.id),
      // Only the best match: further matches cost context and get_fragment reads around this one.
      fragment_match: fragment_match.map(compact_search_fragment_match),
    })
  }

  fn location_label(element: &SearchPathElement) -> String {
    let title = element.title.as_deref().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
      format!("untitled {}", element.item_type)
    } else {
      clamp_with_ellipsis(&title, LOCATION_TITLE_MAX_CHARS)
    }
  }

  fn clamp_with_ellipsis(text: &str, max_chars: usize) -> String {
    let (clamped, truncated) = clamp_text_chars(text, max_chars);
    if truncated { format!("{}…", clamped.trim_end()) } else { clamped }
  }

  /// Page numbers are left out: get_fragment gives them when the passage is read, which is when they can be cited.
  fn compact_search_fragment_match(fragment_match: &SearchFragmentMatch) -> CompactSearchFragmentMatch {
    CompactSearchFragmentMatch {
      fragment_ordinal: fragment_match.fragment_ordinal,
      text: fragment_match.text.clone(),
      text_truncated: fragment_match.text_truncated,
    }
  }
}

pub(super) async fn handle_search(
  db: &Arc<tokio::sync::Mutex<Db>>,
  json_data: &str,
  session_maybe: &Option<Session>,
) -> InfuResult<Option<String>> {
  let session = match session_maybe {
    None => return Err("Sessionless search not supported".into()),
    Some(s) => s,
  };

  let request: SearchRequest =
    serde_json::from_str(json_data).map_err(|e| format!("could not parse json_data {json_data}: {e}"))?;

  let response = run_search(db, request, session).await?;
  let serialized_results = serde_json::to_string(&response)?;

  debug!("Executed 'search' command for user '{}'.", session.user_id);

  Ok(Some(serialized_results))
}

pub(super) async fn run_search(
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: SearchRequest,
  session: &Session,
) -> InfuResult<SearchResponse> {
  let search_text = request.text.to_lowercase();

  let start_result = if let Some(page_num) = request.page_num { (page_num - 1) * request.num_results } else { 0 };
  let end_result = start_result + request.num_results + 1;

  let results = match (&request.page_id, &request.scope_id) {
    (Some(page_id), None) => {
      let mut db = db.lock().await;
      let started = Instant::now();
      let result =
        search_exact_paginated(&mut db, &search_text, page_id.clone(), &session.user_id, start_result, end_result);
      record_search_backend_metrics("exact", started, &result);
      result?
    }
    (page_id, scope_id) => {
      let scope = match scope_id {
        Some(scope_id) => Some(resolve_scope(&*db.lock().await, &session.user_id, scope_id)?),
        None => None,
      };
      let (data_dir, bounds) = resolve_search_bounds(db, page_id.as_ref(), scope.as_ref(), session).await?;
      indexed_search_results(db, &data_dir, &session.user_id, &bounds, &request.text, start_result, end_result).await?
    }
  };

  Ok(search_response_from_results(results, request.num_results))
}

pub(super) async fn run_lexical_search(
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: SearchRequest,
  session: &Session,
  scope: Option<&ResolvedScope>,
) -> InfuResult<SearchResponse> {
  let start_result = if let Some(page_num) = request.page_num { (page_num - 1) * request.num_results } else { 0 };
  let end_result = start_result + request.num_results + 1;
  let (data_dir, bounds) = resolve_search_bounds(db, request.page_id.as_ref(), scope, session).await?;

  let results =
    indexed_search_results(db, &data_dir, &session.user_id, &bounds, &request.text, start_result, end_result).await?;

  Ok(search_response_from_results(results, request.num_results))
}

/// The chat tool's search response. Each result also gets the fields of its entry in `extras`, keyed by item id.
/// `listed_in` maps a result's item id to the container whose fragments list it, which is linked in its location.
pub(super) fn compact_search_response_json<E: Serialize>(
  response: &SearchResponse,
  extras: &HashMap<Uid, E>,
  listed_in: &HashMap<Uid, Uid>,
) -> InfuResult<String> {
  serde_json::to_string(&compact::compact_search_response(response, extras, listed_in))
    .map_err(|e| format!("Could not serialize compact search response: {}", e).into())
}

async fn resolve_search_bounds(
  db: &Arc<tokio::sync::Mutex<Db>>,
  page_id: Option<&Uid>,
  scope: Option<&ResolvedScope>,
  session: &Session,
) -> InfuResult<(String, SearchBounds)> {
  let db = db.lock().await;
  let started = Instant::now();
  let bounds = search_bounds(&db, page_id, scope, &session.user_id)?;
  if let SearchBounds::Items(item_ids) = &bounds {
    debug!(
      "Resolved search bounds for user '{}' to {} item(s) in {:?}.",
      session.user_id,
      item_ids.len(),
      started.elapsed()
    );
  }
  Ok((db.item.data_dir().to_owned(), bounds))
}

fn search_bounds(
  db: &Db,
  page_id: Option<&Uid>,
  scope: Option<&ResolvedScope>,
  user_id: &Uid,
) -> InfuResult<SearchBounds> {
  Ok(match (page_id, scope) {
    (None, None) => {
      let user = db.user.get(user_id).ok_or(format!("Unknown user '{}'.", user_id))?;
      SearchBounds::UnderRoot(user.home_page_id.clone())
    }
    (Some(page_id), None) => SearchBounds::Items(page_subtree_item_ids(db, page_id, user_id)?),
    (None, Some(scope)) => SearchBounds::Items(scope.allowed_item_ids(db, user_id)?),
    (Some(page_id), Some(scope)) => {
      let mut item_ids = page_subtree_item_ids(db, page_id, user_id)?;
      item_ids.retain(|item_id| db.item.get(item_id).is_ok_and(|item| scope.contains(db, item)));
      SearchBounds::Items(item_ids)
    }
  })
}

fn page_subtree_item_ids(db: &Db, search_root_id: &Uid, user_id: &Uid) -> InfuResult<Vec<Uid>> {
  let search_root = db.item.get(search_root_id).map_err(|_| "Search scope was not found.")?;
  if &search_root.owner_id != user_id || search_root.item_type == ItemType::Password {
    return Err("Search scope was not found.".into());
  }

  super::scope::subtree_item_ids(db, vec![search_root_id.clone()], &HashSet::new(), user_id)
}

/// A query matches any of its words. Results are fetched in tiers, items matching all the words first, then those
/// matching one fewer, and so on, each tier in the usual ranking. A query that matches only the rarest word in a
/// short note therefore cannot push out items matching more of the words, and pages never overlap across tiers.
/// Scores are scaled by the share of words matched, so a lower tier never scores above a higher one.
async fn indexed_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  search_text: &str,
  start_result: i64,
  end_result: i64,
) -> InfuResult<Vec<SearchResult>> {
  let fragment_result_limit = usize::try_from(end_result.saturating_add(SEARCH_CANDIDATE_OVERFETCH).max(1))
    .map_err(|_| "Search result limit is too large.")?;
  let wanted = usize::try_from(end_result.max(0)).unwrap_or(usize::MAX);
  let word_count = natural_text_word_count(search_text).max(1);

  let mut results = Vec::new();
  let mut found = HashSet::new();
  for min_matching_words in (1..=word_count).rev() {
    // A lower tier also matches the items already found, so it asks for that many more.
    let limit = fragment_result_limit.saturating_add(found.len());
    let (title_results, search_fragment_results) =
      tier_search_results(db, data_dir, user_id, bounds, min_matching_words, search_text, limit).await;
    let share = min_matching_words as f32 / word_count as f32;
    for mut result in mix_search_results(title_results, search_fragment_results) {
      if search_result_item_id(&result).is_some_and(|item_id| found.insert(item_id)) {
        result.score *= share;
        results.push(result);
      }
    }
    if results.len() >= wanted {
      break;
    }
  }
  Ok(paginate_mixed_results(results, start_result, end_result))
}

/// One query mode's title and fragment results. A failing index is logged and contributes nothing.
async fn tier_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  min_matching_words: usize,
  search_text: &str,
  limit: usize,
) -> (Vec<SearchResult>, Vec<SearchResult>) {
  let title_results =
    match title_lexical_search_results(db, data_dir, user_id, bounds, min_matching_words, search_text, limit).await {
      Ok(results) => results,
      Err(e) => {
        warn!("Title lexical search failed for user '{}'; falling back without title lexical results: {}", user_id, e);
        Vec::new()
      }
    };
  let search_fragment_results =
    match search_fragment_lexical_search_results(db, data_dir, user_id, bounds, min_matching_words, search_text, limit)
      .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Search fragment lexical search failed for user '{}'; falling back without search fragment results: {}",
          user_id, e
        );
        Vec::new()
      }
    };
  (title_results, search_fragment_results)
}

fn search_response_from_results(mut results: Vec<SearchResult>, num_results: i64) -> SearchResponse {
  let has_more = results.len() > num_results as usize;
  if has_more {
    results.truncate(num_results as usize);
  }
  SearchResponse { results, has_more }
}

fn search_exact_paginated(
  db: &mut MutexGuard<'_, Db>,
  search_text: &str,
  page_id: Uid,
  user_id: &Uid,
  start_result: i64,
  end_result: i64,
) -> InfuResult<Vec<SearchResult>> {
  let mut results: Vec<SearchResult> = vec![];
  let mut current_path: Vec<SearchPathElement> = vec![];
  let mut current_result = 0;
  search_recursive(
    db,
    search_text,
    page_id,
    user_id,
    start_result,
    end_result,
    &mut current_path,
    &mut results,
    &mut current_result,
  )?;
  Ok(results)
}

fn record_search_backend_metrics<T>(backend: &'static str, started: Instant, result: &InfuResult<T>) {
  METRIC_SEARCH_BACKEND_DURATION_SECONDS.with_label_values(&[backend]).observe(started.elapsed().as_secs_f64());
  if result.is_err() {
    METRIC_SEARCH_BACKEND_FAILURES_TOTAL.with_label_values(&[backend]).inc();
  }
}

async fn title_lexical_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  min_matching_words: usize,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result =
    title_lexical_search_results_inner(db, data_dir, user_id, bounds, min_matching_words, search_text, limit).await;
  record_search_backend_metrics("title", started, &result);
  result
}

async fn title_lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  min_matching_words: usize,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_item_title_lexical_index_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let title_index = open_user_item_title_lexical_index(data_dir, user_id)?;
  let Some(index_status) = title_index.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let title_hits = title_index.search(search_text, limit, bounds.allowed_item_ids(), min_matching_words).await?;
  if !title_hits.is_empty() {
    debug!(
      "Title lexical search top hits for user '{}': {}",
      user_id,
      title_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.score))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }

  let mut results = Vec::new();
  let db = db.lock().await;
  for hit in title_hits {
    if results.len() >= limit {
      break;
    }
    if let Some(mut result) = search_result_path_for_item(&db, &hit.item_id, user_id, bounds.root_id())? {
      let mut match_result = search_fragment_match_for_lexical_hit(&hit, search_text);
      let exact_title_score = result
        .path
        .last()
        .and_then(|element| element.title.as_deref())
        .map(|title| exact_title_search_score(title, search_text))
        .unwrap_or(0.0);
      match_result.score = match_result.score.max(exact_title_score);
      result.score = match_result.score;
      result.fragment_match = Some(match_result);
      results.push(result);
    }
  }
  Ok(results)
}

async fn search_fragment_lexical_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  min_matching_words: usize,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result =
    search_fragment_lexical_search_results_inner(db, data_dir, user_id, bounds, min_matching_words, search_text, limit)
      .await;
  record_search_backend_metrics("lexical", started, &result);
  result
}

async fn search_fragment_lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  bounds: &SearchBounds,
  min_matching_words: usize,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_document_fragment_lexical_index_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let lexical_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
  let Some(index_status) = lexical_index.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let fragment_limit = limit.saturating_mul(SEARCH_LEXICAL_FRAGMENT_MULTIPLIER).max(limit);
  let fragment_hits = lexical_index
    .search(search_text, fragment_limit, bounds.allowed_item_ids(), min_matching_words)
    .await?
    .into_iter()
    .filter(|hit| hit.source_kind != ITEM_TITLE_SOURCE_KIND)
    .collect::<Vec<_>>();
  if !fragment_hits.is_empty() {
    debug!(
      "Search fragment lexical search top hits for user '{}': {}",
      user_id,
      fragment_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.score))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }
  let fragment_hit_groups = select_top_lexical_fragment_hits_per_item(fragment_hits, SEARCH_LEXICAL_MATCHES_PER_RESULT);

  let mut results = Vec::new();
  let db = db.lock().await;
  for hits in fragment_hit_groups {
    if results.len() >= limit {
      break;
    }
    let Some(best_hit) = hits.first() else {
      continue;
    };
    if let Some(mut result) = search_result_path_for_item(&db, &best_hit.item_id, user_id, bounds.root_id())? {
      let matches = hits.iter().map(|hit| search_fragment_match_for_lexical_hit(hit, search_text)).collect::<Vec<_>>();
      result.score = bm25_score_to_search_score(best_hit.score);
      result.fragment_match = matches.first().cloned();
      result.additional_fragment_matches = matches.into_iter().skip(1).collect();
      results.push(result);
    }
  }
  Ok(results)
}

fn select_top_lexical_fragment_hits_per_item(
  fragment_hits: Vec<FragmentLexicalHit>,
  max_hits_per_item: usize,
) -> Vec<Vec<FragmentLexicalHit>> {
  if max_hits_per_item == 0 {
    return Vec::new();
  }

  let mut hits_by_item = HashMap::<String, Vec<FragmentLexicalHit>>::new();
  for hit in fragment_hits {
    hits_by_item.entry(hit.item_id.clone()).or_default().push(hit);
  }

  let mut hit_groups = hits_by_item
    .into_values()
    .map(|mut hits| {
      hits.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
      });
      hits.truncate(max_hits_per_item);
      hits
    })
    .collect::<Vec<_>>();
  hit_groups.sort_by(|a, b| {
    let a = a.first();
    let b = b.first();
    match (a, b) {
      (Some(a), Some(b)) => {
        b.score.total_cmp(&a.score).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
      }
      (None, Some(_)) => std::cmp::Ordering::Greater,
      (Some(_), None) => std::cmp::Ordering::Less,
      (None, None) => std::cmp::Ordering::Equal,
    }
  });
  hit_groups.into_iter().filter(|hits| !hits.is_empty()).collect()
}

fn search_result_path_for_item(
  db: &MutexGuard<'_, Db>,
  item_id: &Uid,
  user_id: &Uid,
  root_id_maybe: Option<&Uid>,
) -> InfuResult<Option<SearchResult>> {
  let Some(path) = item_path(db, item_id, user_id)? else {
    return Ok(None);
  };
  if root_id_maybe.is_some_and(|root_id| !search_result_is_under_root_path(&path, root_id)) {
    return Ok(None);
  }
  let stats = search_result_stats_for_item(db, db.item.get(item_id)?)?;
  Ok(Some(SearchResult { path, score: 0.0, stats, fragment_match: None, additional_fragment_matches: Vec::new() }))
}

/// The path from a root page down to the item, inclusive. None if the item or one of the items
/// above it is missing, not owned by the user, or a password.
pub(super) fn item_path(db: &Db, item_id: &Uid, user_id: &Uid) -> InfuResult<Option<Vec<SearchPathElement>>> {
  let mut path = Vec::new();
  let mut current_id = item_id.clone();
  let mut seen = HashSet::new();

  loop {
    if !seen.insert(current_id.clone()) {
      return Err(format!("Cycle detected while building path for item '{}'.", item_id).into());
    }
    let item = match db.item.get(&current_id) {
      Ok(item) => item,
      Err(_) => return Ok(None),
    };
    if &item.owner_id != user_id || item.item_type == ItemType::Password {
      return Ok(None);
    }
    path.push(SearchPathElement {
      item_type: item.item_type.as_str().to_owned(),
      title: item.title.clone(),
      id: item.id.clone(),
    });

    let Some(parent_id) = item.parent_id.clone() else {
      break;
    };
    current_id = parent_id;
  }

  path.reverse();
  Ok(Some(path))
}

fn search_result_stats_for_item(db: &Db, item: &Item) -> InfuResult<Option<SearchResultStats>> {
  if !is_container_item_type(item.item_type) {
    return Ok(None);
  }

  let children = db.item.get_children(&item.id)?;
  let mut stats = SearchResultStats { total_children: children.len(), image_file_children: 0, total_bytes: 0 };

  for child in children {
    if is_image_item(child) || is_data_item_type(child.item_type) {
      stats.image_file_children += 1;
      stats.total_bytes = stats.total_bytes.saturating_add(child.file_size_bytes.unwrap_or(0).max(0));
    }
  }

  Ok(Some(stats))
}

fn search_result_is_under_root_path(path: &[SearchPathElement], search_root_id: &Uid) -> bool {
  path.iter().any(|element| &element.id == search_root_id)
}

#[derive(Clone)]
struct SearchMergeCandidate {
  result: SearchResult,
  rank_score: f64,
  best_rank: usize,
}

fn mix_search_results(
  title_results: Vec<SearchResult>,
  search_fragment_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
  let mut candidates: HashMap<Uid, SearchMergeCandidate> = HashMap::new();

  add_ranked_search_results(&mut candidates, title_results, SEARCH_TITLE_LEXICAL_WEIGHT);
  add_ranked_search_results(&mut candidates, search_fragment_results, SEARCH_FRAGMENT_LEXICAL_WEIGHT);

  let mut candidates = candidates.into_values().collect::<Vec<_>>();
  candidates.sort_by(|a, b| {
    b.rank_score
      .partial_cmp(&a.rank_score)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| a.best_rank.cmp(&b.best_rank))
      .then_with(|| search_result_item_id(&a.result).cmp(&search_result_item_id(&b.result)))
  });
  let max_rank_score = candidates.first().map(|candidate| candidate.rank_score).unwrap_or(0.0);
  candidates
    .into_iter()
    .map(|mut candidate| {
      candidate.result.score = merged_rank_score_to_search_score(candidate.rank_score, max_rank_score);
      candidate.result
    })
    .collect()
}

fn add_ranked_search_results(
  candidates: &mut HashMap<Uid, SearchMergeCandidate>,
  results: Vec<SearchResult>,
  weight: f64,
) {
  for (rank, result) in results.into_iter().enumerate() {
    let Some(item_id) = search_result_item_id(&result) else {
      continue;
    };
    let fragment_match = result.fragment_match.clone();
    let additional_fragment_matches = result.additional_fragment_matches.clone();
    let rank_score = weight / (SEARCH_RRF_K + rank as f64 + 1.0);
    let entry = candidates.entry(item_id).or_insert_with(|| SearchMergeCandidate {
      result: result.clone(),
      rank_score: 0.0,
      best_rank: rank,
    });
    let should_replace_fragment_result = rank < entry.best_rank;
    entry.rank_score += rank_score;
    entry.best_rank = entry.best_rank.min(rank);
    if should_replace_fragment_result {
      entry.result = result;
    } else if entry.result.fragment_match.is_none() {
      entry.result.fragment_match = fragment_match;
      entry.result.additional_fragment_matches = additional_fragment_matches;
    }
  }
}

fn paginate_mixed_results(results: Vec<SearchResult>, start_result: i64, end_result: i64) -> Vec<SearchResult> {
  let start = usize::try_from(start_result.max(0)).unwrap_or(0);
  let take = usize::try_from(end_result.saturating_sub(start_result).max(0)).unwrap_or(0);
  results.into_iter().skip(start).take(take).collect()
}

fn search_result_item_id(result: &SearchResult) -> Option<Uid> {
  result.path.last().map(|element| element.id.clone())
}

fn clamp_search_score(score: f32) -> f32 {
  if score.is_finite() { score.clamp(0.0, 1.0) } else { 0.0 }
}

fn merged_rank_score_to_search_score(rank_score: f64, max_rank_score: f64) -> f32 {
  if !rank_score.is_finite() || !max_rank_score.is_finite() || rank_score <= 0.0 || max_rank_score <= 0.0 {
    return 0.0;
  }
  clamp_search_score((rank_score / max_rank_score) as f32)
}

fn bm25_score_to_search_score(score: f32) -> f32 {
  if score <= 0.0 {
    return 0.0;
  }
  clamp_search_score(score / (score + SEARCH_BM25_SCORE_SATURATION))
}

pub(super) fn exact_title_search_score(title: &str, search_text: &str) -> f32 {
  let query = search_text.trim().to_lowercase();
  if query.is_empty() {
    return 0.0;
  }

  let title = title.trim().to_lowercase();
  if title == query {
    return 1.0;
  }
  if title.split_whitespace().any(|term| term == query) {
    return 0.95;
  }
  if title.starts_with(&query) {
    return 0.9;
  }

  let title_chars = title.chars().count().max(1) as f32;
  let query_chars = query.chars().count() as f32;
  clamp_search_score(0.65 + 0.25 * (query_chars / title_chars).min(1.0)).min(0.89)
}

fn search_fragment_match_for_lexical_hit(hit: &FragmentLexicalHit, search_text: &str) -> SearchFragmentMatch {
  let (text, text_truncated) =
    search_match_excerpt(&hit.source_kind, &hit.text, search_text, SEARCH_FRAGMENT_MATCH_MAX_CHARS);
  SearchFragmentMatch {
    fragment_ordinal: hit.ordinal,
    source_kind: hit.source_kind.clone(),
    lexical_score: Some(hit.score),
    score: bm25_score_to_search_score(hit.score),
    text,
    text_truncated,
    page_start: hit.page_start,
    page_end: hit.page_end,
  }
}

fn search_match_excerpt(source_kind: &str, text: &str, search_text: &str, max_chars: usize) -> (String, bool) {
  let display_text = fragment_display_text(source_kind, text);
  if display_text.is_empty() {
    return (String::new(), false);
  }

  let query_terms = normalized_search_terms(search_text);
  let sentence_candidates = split_sentence_segments(&display_text);
  let mut selected_sentences = sentence_candidates
    .iter()
    .filter(|sentence| sentence_matches_query_terms(sentence, &query_terms))
    .take(SEARCH_MATCH_SNIPPET_MAX_SENTENCES)
    .cloned()
    .collect::<Vec<_>>();

  if selected_sentences.is_empty() {
    selected_sentences = sentence_candidates.into_iter().take(SEARCH_MATCH_SNIPPET_MAX_SENTENCES).collect();
  }

  let selected_windows = selected_sentences
    .iter()
    .map(|sentence| search_snippet_sentence_window(sentence, &query_terms))
    .filter(|sentence| !sentence.is_empty())
    .collect::<Vec<_>>();

  let excerpt = ellipsis_sentence_excerpt(&selected_windows);
  clamp_text_chars(&excerpt, max_chars)
}

fn fragment_display_text(source_kind: &str, text: &str) -> String {
  let lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
  let display_lines = if is_markdown_document_source_kind(source_kind) {
    lines.filter(|line| !is_pdf_catalog_omitted_line(line)).collect::<Vec<_>>()
  } else {
    lines.collect::<Vec<_>>()
  };
  display_lines.join("\n")
}

fn is_pdf_catalog_omitted_line(line: &str) -> bool {
  let Some((label, _)) = line.split_once(':') else {
    return false;
  };
  PDF_CATALOG_OMITTED_LABELS.iter().any(|omitted| label.trim().eq_ignore_ascii_case(omitted))
}

fn split_sentence_segments(text: &str) -> Vec<String> {
  let mut segments = Vec::new();
  let mut start = 0;
  let mut chars = text.char_indices().peekable();
  while let Some((idx, ch)) = chars.next() {
    if ch == '\n' {
      push_sentence_segment(&mut segments, &text[start..idx]);
      start = idx + ch.len_utf8();
      continue;
    }
    let is_sentence_end = matches!(ch, '.' | '!' | '?')
      && chars
        .peek()
        .map(|(_, next_ch)| next_ch.is_whitespace() || matches!(next_ch, '"' | '\'' | ')' | ']'))
        .unwrap_or(true);
    if is_sentence_end {
      let end = idx + ch.len_utf8();
      push_sentence_segment(&mut segments, &text[start..end]);
      start = end;
    }
  }
  if start < text.len() {
    push_sentence_segment(&mut segments, &text[start..]);
  }
  if segments.is_empty() {
    push_sentence_segment(&mut segments, text);
  }
  segments
}

fn push_sentence_segment(segments: &mut Vec<String>, segment: &str) {
  let cleaned = trim_snippet_sentence_punctuation(&collapse_whitespace(segment));
  if !cleaned.is_empty() {
    segments.push(cleaned);
  }
}

fn trim_snippet_sentence_punctuation(segment: &str) -> String {
  segment.trim_end_matches(['.', '!', '?']).trim_end().to_owned()
}

fn ellipsis_sentence_excerpt(sentences: &[String]) -> String {
  if sentences.is_empty() {
    return String::new();
  }
  format!(
    "{} {} {}",
    SEARCH_SNIPPET_ELLIPSIS,
    sentences.join(&format!(" {} ", SEARCH_SNIPPET_ELLIPSIS)),
    SEARCH_SNIPPET_ELLIPSIS
  )
}

fn search_snippet_sentence_window(sentence: &str, query_terms: &[String]) -> String {
  let sentence = sentence.trim();
  let total_chars = sentence.chars().count();
  if total_chars <= SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS {
    return sentence.to_owned();
  }

  let match_range = first_query_term_match_char_range(sentence, query_terms);
  let match_start = match_range.map(|(start, _)| start).unwrap_or(0);
  let match_end = match_range.map(|(_, end)| end).unwrap_or(match_start);
  let mut start = match_start.saturating_sub(SEARCH_MATCH_SNIPPET_CONTEXT_BEFORE_CHARS);
  let mut end = (start + SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS).min(total_chars);
  if end == total_chars {
    start = end.saturating_sub(SEARCH_MATCH_SNIPPET_MAX_SENTENCE_CHARS);
  }
  start = adjust_window_start_to_word_boundary(sentence, start, match_start);
  end = adjust_window_end_to_word_boundary(sentence, end, match_end, total_chars);

  let start_byte = byte_index_at_char(sentence, start);
  let end_byte = byte_index_at_char(sentence, end);
  trim_snippet_sentence_punctuation(&collapse_whitespace(&sentence[start_byte..end_byte]))
}

fn first_query_term_match_char_range(text: &str, query_terms: &[String]) -> Option<(usize, usize)> {
  if query_terms.is_empty() {
    return None;
  }

  let mut current = String::new();
  let mut current_start_char = 0;
  for (char_idx, ch) in text.chars().enumerate() {
    if ch.is_alphanumeric() {
      if current.is_empty() {
        current_start_char = char_idx;
      }
      current.extend(ch.to_lowercase());
    } else if !current.is_empty() {
      let stem = light_stem_search_term(&current);
      if query_terms.iter().any(|term| term == &stem) {
        return Some((current_start_char, char_idx));
      }
      current.clear();
    }
  }

  if !current.is_empty() {
    let total_chars = text.chars().count();
    let stem = light_stem_search_term(&current);
    if query_terms.iter().any(|term| term == &stem) {
      return Some((current_start_char, total_chars));
    }
  }
  None
}

fn adjust_window_start_to_word_boundary(text: &str, start_char: usize, match_start_char: usize) -> usize {
  if start_char == 0 {
    return start_char;
  }

  text
    .chars()
    .enumerate()
    .skip(start_char)
    .take(match_start_char.saturating_sub(start_char))
    .find_map(|(idx, ch)| {
      if idx.saturating_sub(start_char) <= SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS && ch.is_whitespace() {
        Some(idx + 1)
      } else {
        None
      }
    })
    .unwrap_or(start_char)
}

fn adjust_window_end_to_word_boundary(text: &str, end_char: usize, match_end_char: usize, total_chars: usize) -> usize {
  if end_char >= total_chars {
    return end_char;
  }

  text
    .chars()
    .enumerate()
    .skip(match_end_char)
    .take(end_char.saturating_sub(match_end_char))
    .filter_map(|(idx, ch)| {
      if end_char.saturating_sub(idx) <= SEARCH_MATCH_SNIPPET_BOUNDARY_SLOP_CHARS && ch.is_whitespace() {
        Some(idx)
      } else {
        None
      }
    })
    .last()
    .unwrap_or(end_char)
}

fn byte_index_at_char(text: &str, char_idx: usize) -> usize {
  if char_idx == 0 {
    return 0;
  }
  text.char_indices().nth(char_idx).map(|(idx, _)| idx).unwrap_or(text.len())
}

fn normalized_search_terms(search_text: &str) -> Vec<String> {
  let mut raw_terms = tokenize_search_text(search_text)
    .into_iter()
    .map(|term| light_stem_search_term(&term))
    .filter(|term| !term.is_empty())
    .collect::<Vec<_>>();
  raw_terms.sort();
  raw_terms.dedup();

  let mut meaningful_terms = raw_terms
    .iter()
    .filter(|term| term.len() > 1 && !SEARCH_SNIPPET_STOP_WORDS.contains(&term.as_str()))
    .cloned()
    .collect::<Vec<_>>();
  if meaningful_terms.is_empty() {
    meaningful_terms = raw_terms;
  }
  meaningful_terms
}

fn sentence_matches_query_terms(sentence: &str, query_terms: &[String]) -> bool {
  if query_terms.is_empty() {
    return false;
  }
  let sentence_terms =
    tokenize_search_text(sentence).into_iter().map(|term| light_stem_search_term(&term)).collect::<HashSet<_>>();
  query_terms.iter().any(|term| sentence_terms.contains(term))
}

fn tokenize_search_text(text: &str) -> Vec<String> {
  let mut terms = Vec::new();
  let mut current = String::new();
  for ch in text.chars() {
    if ch.is_alphanumeric() {
      current.extend(ch.to_lowercase());
    } else if !current.is_empty() {
      terms.push(std::mem::take(&mut current));
    }
  }
  if !current.is_empty() {
    terms.push(current);
  }
  terms
}

fn light_stem_search_term(term: &str) -> String {
  let mut stem = term.to_owned();
  if stem.len() > 5 && stem.ends_with("ies") {
    stem.truncate(stem.len() - 3);
    stem.push('y');
  } else if stem.len() > 5 && stem.ends_with("ing") {
    stem.truncate(stem.len() - 3);
    remove_doubled_trailing_consonant(&mut stem);
  } else if stem.len() > 4 && stem.ends_with("ed") {
    stem.truncate(stem.len() - 2);
    remove_doubled_trailing_consonant(&mut stem);
  } else if stem.len() > 4
    && (stem.ends_with("ches") || stem.ends_with("shes") || stem.ends_with("sses") || stem.ends_with("xes"))
  {
    stem.truncate(stem.len() - 2);
  } else if stem.len() > 3 && stem.ends_with('s') {
    stem.truncate(stem.len() - 1);
  }
  stem
}

fn remove_doubled_trailing_consonant(term: &mut String) {
  let mut chars = term.chars().rev();
  let Some(last) = chars.next() else {
    return;
  };
  let Some(previous) = chars.next() else {
    return;
  };
  if last == previous && !"aeiou".contains(last) {
    term.truncate(term.len() - last.len_utf8());
  }
}

fn collapse_whitespace(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clamp_text_chars(text: &str, max_chars: usize) -> (String, bool) {
  let mut chars = text.chars();
  let clamped = chars.by_ref().take(max_chars).collect::<String>();
  (clamped, chars.next().is_some())
}

fn search_recursive(
  db: &mut MutexGuard<'_, Db>,
  search_text: &str,
  item_id: Uid,
  user_id: &Uid,
  start_result: i64,
  end_result: i64,
  current_path: &mut Vec<SearchPathElement>,
  results: &mut Vec<SearchResult>,
  current_result: &mut i64,
) -> InfuResult<()> {
  if results.len() >= (end_result - start_result) as usize {
    return Ok(());
  }

  {
    let item = db.item.get(&item_id)?;
    if &item.owner_id != user_id {
      return Ok(());
    } // paranoid.
    if item.item_type != ItemType::Password {
      match &item.title {
        None => {}
        Some(title) => {
          if title.to_lowercase().contains(search_text) {
            if *current_result >= start_result && *current_result < end_result {
              let mut path: Vec<SearchPathElement> = current_path.iter().map(|a| (*a).clone()).collect();
              path.push(SearchPathElement {
                item_type: item.item_type.as_str().to_owned(),
                title: item.title.to_owned(),
                id: item.id.to_owned(),
              });
              let stats = search_result_stats_for_item(db, item)?;
              results.push(SearchResult {
                path,
                score: exact_title_search_score(title, search_text),
                stats,
                fragment_match: None,
                additional_fragment_matches: Vec::new(),
              });
            }
            *current_result += 1;
            if results.len() >= (end_result - start_result) as usize {
              return Ok(());
            }
          }
        }
      };
    }

    current_path.push(SearchPathElement {
      item_type: item.item_type.as_str().to_owned(),
      title: item.title.clone(),
      id: item.id.clone(),
    });
  }

  let child_ids = db.item.get_children_ids(&item_id)?;
  for child_id in child_ids {
    search_recursive(
      db,
      search_text,
      child_id,
      user_id,
      start_result,
      end_result,
      current_path,
      results,
      current_result,
    )?;
    if results.len() >= (end_result - start_result) as usize {
      return Ok(());
    }
  }

  let attachment_ids = db.item.get_attachment_ids(&item_id)?;
  for attachment_id in attachment_ids {
    search_recursive(
      db,
      search_text,
      attachment_id,
      user_id,
      start_result,
      end_result,
      current_path,
      results,
      current_result,
    )?;
    if results.len() >= (end_result - start_result) as usize {
      return Ok(());
    }
  }

  current_path.pop();

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ai::lexical_index::LexicalFragment;
  use crate::web::routes::command::scope::test_db::TestDb;

  fn bounds_item_ids(t: &TestDb, page_id: Option<&Uid>, scope_id: Option<&Uid>) -> Vec<Uid> {
    let scope = scope_id.map(|scope_id| resolve_scope(&t.db, &t.user_id, scope_id).unwrap());
    match search_bounds(&t.db, page_id, scope.as_ref(), &t.user_id).unwrap() {
      SearchBounds::Items(item_ids) => item_ids,
      SearchBounds::UnderRoot(root_id) => panic!("expected an item restriction, got root '{}'", root_id),
    }
  }

  fn sorted(mut item_ids: Vec<Uid>) -> Vec<Uid> {
    item_ids.sort();
    item_ids
  }

  #[tokio::test]
  async fn search_bounds_apply_page_and_scope_together() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let a = t.page(&home, "A").await;
    let a1 = t.note(&a, "a1", RelationshipToParent::Child).await;
    let x = t.page(&a, "X").await;
    let x1 = t.note(&x, "x1", RelationshipToParent::Child).await;
    let b = t.page(&home, "B").await;
    let scopes_id = t.scopes_id();
    let no_x = t.page(&scopes_id, "No X").await;
    let exclude = t.page(&no_x, "Exclude").await;
    t.link(&exclude, &x).await;
    let b_only = t.page(&scopes_id, "B only").await;
    t.link(&b_only, &b).await;

    match search_bounds(&t.db, None, None, &t.user_id).unwrap() {
      SearchBounds::UnderRoot(root_id) => assert_eq!(root_id, home),
      SearchBounds::Items(_) => panic!("an unrestricted search should cover the home tree"),
    }
    assert_eq!(bounds_item_ids(&t, None, Some(&no_x)), sorted(vec![home.clone(), a.clone(), a1.clone(), b.clone()]));
    assert_eq!(bounds_item_ids(&t, Some(&a), None), sorted(vec![a.clone(), a1.clone(), x.clone(), x1.clone()]));
    assert_eq!(bounds_item_ids(&t, Some(&a), Some(&no_x)), sorted(vec![a.clone(), a1.clone()]));
    assert!(bounds_item_ids(&t, Some(&a), Some(&b_only)).is_empty());
  }

  #[tokio::test]
  async fn natural_text_results_matching_more_words_come_first() {
    let mut t = TestDb::new().await;
    let home = t.home_id.clone();
    let mut titles = Vec::new();
    // Common words score low; a rare word in a short note scores high on its own.
    for index in 0..40 {
      titles.push(format!("montreal note {index}"));
      titles.push(format!("hotel note {index}"));
    }
    titles.push("liked".to_owned());
    let filler = (0..80).map(|index| format!("filler{index}")).collect::<Vec<_>>().join(" ");
    titles.push(format!("montreal hotel {filler}"));
    let mut ids = Vec::new();
    for title in &titles {
      ids.push(t.note(&home, title, RelationshipToParent::Child).await);
    }
    let data_dir = t.db.item.data_dir().to_owned();
    let user_id = t.user_id.clone();
    let fragments = ids
      .iter()
      .zip(&titles)
      .map(|(id, title)| {
        let source_kind = ITEM_TITLE_SOURCE_KIND.to_owned();
        vec![LexicalFragment {
          item_id: id.clone(),
          ordinal: 0,
          source_kind,
          text: title.clone(),
          page_start: None,
          page_end: None,
        }]
      })
      .collect::<Vec<_>>();
    let updates =
      ids.iter().zip(&fragments).map(|(id, fragments)| (id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
    open_user_item_title_lexical_index(&data_dir, &user_id).unwrap().replace_items_titles(&updates).await.unwrap();
    let (liked, both) = (&ids[80], &ids[81]);
    let db = Arc::new(tokio::sync::Mutex::new(t.db));
    let bounds = SearchBounds::UnderRoot(home);
    let item_ids = |results: &[SearchResult]| results.iter().filter_map(search_result_item_id).collect::<Vec<_>>();

    let (single_query, _) = tier_search_results(&db, &data_dir, &user_id, &bounds, 1, "montreal hotel liked", 10).await;
    assert_eq!(item_ids(&single_query).first(), Some(liked), "one OR query ranks the rare word first");

    let search = |start: i64, end: i64| {
      indexed_search_results(&db, &data_dir, &user_id, &bounds, "montreal hotel liked", start, end)
    };
    let first_results = search(0, 3).await.unwrap();
    let scores = first_results.iter().map(|result| result.score).collect::<Vec<_>>();
    assert!(scores.windows(2).all(|pair| pair[0] >= pair[1]), "a lower tier never scores higher: {scores:?}");
    let first_page = item_ids(&first_results);
    assert_eq!(first_page.first(), Some(both), "the item matching two words comes first");
    assert_eq!(first_page.get(1), Some(liked), "then the rarest single word");
    let second_page = item_ids(&search(3, 6).await.unwrap());
    assert_eq!(second_page.len(), 3);
    assert!(second_page.iter().all(|item_id| !first_page.contains(item_id)), "pages do not overlap");
  }
}
