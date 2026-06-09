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

use super::*;

const SEARCH_RRF_K: f64 = 60.0;
const SEARCH_TITLE_LEXICAL_WEIGHT: f64 = 1.35;
const SEARCH_LEXICAL_WEIGHT: f64 = 1.15;
const SEARCH_SEMANTIC_WEIGHT: f64 = 1.0;
const SEARCH_CANDIDATE_OVERFETCH: i64 = 50;
const SEARCH_LEXICAL_FRAGMENT_MULTIPLIER: usize = 4;
const SEARCH_LEXICAL_MATCHES_PER_RESULT: usize = 2;
const SEARCH_SEMANTIC_FRAGMENT_MULTIPLIER: usize = 4;
const SEARCH_EMBEDDING_TIMEOUT_SECS: u64 = 30;
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
  #[serde(rename = "semanticDistance", skip_serializing_if = "Option::is_none")]
  pub semantic_distance: Option<f32>,
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

  #[derive(Clone, Serialize)]
  pub(super) struct CompactSearchResponse {
    pub results: Vec<CompactSearchResult>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
  }

  #[derive(Clone, Serialize)]
  pub(super) struct CompactSearchResult {
    #[serde(rename = "itemId")]
    pub item_id: Uid,
    #[serde(rename = "itemType")]
    pub item_type: String,
    pub title: Option<String>,
    pub score: f32,
    pub path: Vec<String>,
    #[serde(rename = "fragmentMatch", skip_serializing_if = "Option::is_none")]
    pub fragment_match: Option<CompactSearchFragmentMatch>,
    #[serde(rename = "additionalFragmentMatches", skip_serializing_if = "Vec::is_empty")]
    pub additional_fragment_matches: Vec<CompactSearchFragmentMatch>,
  }

  #[derive(Clone, Serialize)]
  pub(super) struct CompactSearchFragmentMatch {
    #[serde(rename = "sourceKind")]
    pub source_kind: String,
    pub score: f32,
    pub text: String,
    #[serde(rename = "textTruncated")]
    pub text_truncated: bool,
    #[serde(rename = "pageStart", skip_serializing_if = "Option::is_none")]
    pub page_start: Option<usize>,
    #[serde(rename = "pageEnd", skip_serializing_if = "Option::is_none")]
    pub page_end: Option<usize>,
  }

  pub(super) fn compact_search_response(response: &SearchResponse) -> CompactSearchResponse {
    CompactSearchResponse {
      results: response.results.iter().filter_map(compact_search_result).collect(),
      has_more: response.has_more,
    }
  }

  fn compact_search_result(result: &SearchResult) -> Option<CompactSearchResult> {
    let item = result.path.last()?;
    Some(CompactSearchResult {
      item_id: item.id.clone(),
      item_type: item.item_type.clone(),
      title: item.title.clone(),
      score: result.score,
      path: result.path.iter().map(compact_search_path_label).collect(),
      fragment_match: result.fragment_match.as_ref().map(compact_search_fragment_match),
      additional_fragment_matches: result
        .additional_fragment_matches
        .iter()
        .map(compact_search_fragment_match)
        .collect(),
    })
  }

  fn compact_search_path_label(element: &SearchPathElement) -> String {
    element
      .title
      .as_ref()
      .filter(|title| !title.trim().is_empty())
      .cloned()
      .unwrap_or_else(|| format!("{} {}", element.item_type, element.id))
  }

  fn compact_search_fragment_match(fragment_match: &SearchFragmentMatch) -> CompactSearchFragmentMatch {
    CompactSearchFragmentMatch {
      source_kind: fragment_match.source_kind.clone(),
      score: fragment_match.score,
      text: fragment_match.text.clone(),
      text_truncated: fragment_match.text_truncated,
      page_start: fragment_match.page_start,
      page_end: fragment_match.page_end,
    }
  }
}

pub(super) async fn handle_search(
  config: Arc<Config>,
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

  let response = run_search(config, db, request, session).await?;
  let serialized_results = serde_json::to_string(&response)?;

  debug!("Executed 'search' command for user '{}'.", session.user_id);

  Ok(Some(serialized_results))
}

pub(super) async fn run_search(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  request: SearchRequest,
  session: &Session,
) -> InfuResult<SearchResponse> {
  let full_user_search = request.page_id.is_none();
  let search_text = request.text.to_lowercase();

  let start_result = if let Some(page_num) = request.page_num { (page_num - 1) * request.num_results } else { 0 };
  let end_result = start_result + request.num_results + 1;

  let (data_dir, search_root_id) = {
    let db = db.lock().await;

    let page_id = if let Some(request_page_id) = request.page_id {
      request_page_id
    } else {
      let user = db.user.get(&session.user_id).ok_or(format!("Unknown user '{}", session.user_id))?;
      user.home_page_id.clone()
    };

    (db.item.data_dir().to_owned(), page_id)
  };

  let mut results = if full_user_search {
    let fragment_result_limit = usize::try_from(end_result.saturating_add(SEARCH_CANDIDATE_OVERFETCH).max(1))
      .map_err(|_| "Search result limit is too large.")?;
    let title_results = match title_lexical_search_results(
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Title lexical search failed for user '{}'; falling back without title lexical results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let lexical_results = match lexical_search_results(
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Lexical fragment search failed for user '{}'; falling back without lexical fragment results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let semantic_results = match semantic_search_results(
      config,
      db,
      &data_dir,
      &session.user_id,
      &search_root_id,
      &request.text,
      fragment_result_limit,
    )
    .await
    {
      Ok(results) => results,
      Err(e) => {
        warn!(
          "Semantic search failed for user '{}'; falling back without semantic fragment results: {}",
          session.user_id, e
        );
        Vec::new()
      }
    };
    let mixed = mix_search_results(title_results, lexical_results, semantic_results);
    paginate_mixed_results(mixed, start_result, end_result)
  } else {
    let mut db = db.lock().await;
    let started = Instant::now();
    let result =
      search_exact_paginated(&mut db, &search_text, search_root_id, &session.user_id, start_result, end_result);
    record_search_backend_metrics("exact", started, &result);
    result?
  };

  let has_more = results.len() > request.num_results as usize;
  if has_more {
    results.truncate(request.num_results as usize);
  }
  Ok(SearchResponse { results, has_more })
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
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = title_lexical_search_results_inner(db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("title", started, &result);
  result
}

async fn title_lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
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

  let title_hits = title_index.search(search_text, limit).await?;
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
    if let Some(mut result) = search_result_path_for_item(&db, &hit.item_id, user_id, search_root_id)? {
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

async fn lexical_search_results(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = lexical_search_results_inner(db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("lexical", started, &result);
  result
}

async fn lexical_search_results_inner(
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
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
    .search(search_text, fragment_limit)
    .await?
    .into_iter()
    .filter(|hit| hit.source_kind != ITEM_TITLE_SOURCE_KIND)
    .collect::<Vec<_>>();
  if !fragment_hits.is_empty() {
    debug!(
      "Lexical fragment search top hits for user '{}': {}",
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
    if let Some(mut result) = search_result_path_for_item(&db, &best_hit.item_id, user_id, search_root_id)? {
      let matches = hits.iter().map(|hit| search_fragment_match_for_lexical_hit(hit, search_text)).collect::<Vec<_>>();
      result.score = bm25_score_to_search_score(best_hit.score);
      result.fragment_match = matches.first().cloned();
      result.additional_fragment_matches = matches.into_iter().skip(1).collect();
      results.push(result);
    }
  }
  Ok(results)
}

async fn semantic_search_results(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  let started = Instant::now();
  let result = semantic_search_results_inner(config, db, data_dir, user_id, search_root_id, search_text, limit).await;
  record_search_backend_metrics("semantic", started, &result);
  result
}

async fn semantic_search_results_inner(
  config: Arc<Config>,
  db: &Arc<tokio::sync::Mutex<Db>>,
  data_dir: &str,
  user_id: &Uid,
  search_root_id: &Uid,
  search_text: &str,
  limit: usize,
) -> InfuResult<Vec<SearchResult>> {
  if limit == 0 || search_text.trim().is_empty() {
    return Ok(Vec::new());
  }

  if !user_fragment_vector_db_exists(data_dir, user_id).await? {
    return Ok(Vec::new());
  }

  let vector_db = open_user_fragment_vector_db(data_dir, user_id, FragmentVectorDbBackend::SqliteVec)?;
  let Some(index_status) = vector_db.rebuild_status().await? else {
    return Ok(Vec::new());
  };
  if !index_status.complete {
    return Ok(Vec::new());
  }

  let Some(embed_url) = resolve_configured_gpu_tool_url(config.as_ref(), GPU_TOOL_TEXT_EMBED).await? else {
    return Ok(Vec::new());
  };
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(SEARCH_EMBEDDING_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build semantic search HTTP client: {}", e))?;
  let embedding_batch = embed_texts(
    &client,
    &embed_url,
    &[TextEmbeddingInput::retrieval_query(Some("search-query".to_owned()), search_text.to_owned())],
  )
  .await?;
  let query_embedding =
    embedding_batch.embeddings.into_iter().next().ok_or("Text embedding service returned no query embedding.")?;
  if query_embedding.is_empty() {
    return Ok(Vec::new());
  }
  validate_text_embedding_vector("Text embedding service returned query embedding", &query_embedding)?;
  debug!(
    "Semantic search query embedding for user '{}': dims={}, norm={:.6}, fingerprint={}",
    user_id,
    query_embedding.len(),
    text_embedding_vector_norm(&query_embedding),
    text_embedding_vector_fingerprint(&query_embedding)
  );

  let fragment_limit = limit.saturating_mul(SEARCH_SEMANTIC_FRAGMENT_MULTIPLIER).max(limit);
  let fragment_hits = vector_db
    .search(&query_embedding, fragment_limit)
    .await?
    .into_iter()
    .filter(|hit| !is_lexical_search_source_kind(&hit.source_kind))
    .collect::<Vec<_>>();
  if !fragment_hits.is_empty() {
    debug!(
      "Semantic search top fragment hits for user '{}': {}",
      user_id,
      fragment_hits
        .iter()
        .take(8)
        .map(|hit| format!("{}:{}@{:.6}", hit.item_id, hit.ordinal, hit.distance))
        .collect::<Vec<_>>()
        .join(", ")
    );
  }
  let fragment_hits = select_best_fragment_hit_per_item(fragment_hits);

  let mut results = Vec::new();
  let db = db.lock().await;
  for hit in fragment_hits {
    if results.len() >= limit {
      break;
    }
    if let Some(mut result) = search_result_path_for_item(&db, &hit.item_id, user_id, search_root_id)? {
      result.score = semantic_distance_to_search_score(hit.distance);
      result.fragment_match = Some(search_fragment_match_for_hit(&hit, search_text));
      results.push(result);
    }
  }
  Ok(results)
}

fn select_best_fragment_hit_per_item(fragment_hits: Vec<FragmentVectorHit>) -> Vec<FragmentVectorHit> {
  let mut best_by_item = HashMap::<String, FragmentVectorHit>::new();
  for hit in fragment_hits {
    match best_by_item.get(&hit.item_id) {
      Some(best) if best.distance <= hit.distance => {}
      _ => {
        best_by_item.insert(hit.item_id.clone(), hit);
      }
    }
  }

  let mut hits = best_by_item.into_values().collect::<Vec<_>>();
  hits.sort_by(|a, b| {
    a.distance.total_cmp(&b.distance).then_with(|| a.item_id.cmp(&b.item_id)).then_with(|| a.ordinal.cmp(&b.ordinal))
  });
  hits
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
  search_root_id: &Uid,
) -> InfuResult<Option<SearchResult>> {
  let target_item = match db.item.get(item_id) {
    Ok(item) => item,
    Err(_) => return Ok(None),
  };
  if &target_item.owner_id != user_id || target_item.item_type == ItemType::Password {
    return Ok(None);
  }
  let stats = search_result_stats_for_item(db, target_item)?;

  let mut path = Vec::new();
  let mut current_id = item_id.clone();
  let mut seen = HashSet::new();

  loop {
    if !seen.insert(current_id.clone()) {
      return Err(format!("Cycle detected while building search path for item '{}'.", item_id).into());
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
  if !search_result_is_under_root_path(&path, search_root_id) {
    return Ok(None);
  }
  Ok(Some(SearchResult { path, score: 0.0, stats, fragment_match: None, additional_fragment_matches: Vec::new() }))
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
  path.first().is_some_and(|element| &element.id == search_root_id)
}

#[derive(Clone)]
struct SearchMergeCandidate {
  result: SearchResult,
  rank_score: f64,
  best_rank: usize,
}

fn mix_search_results(
  title_results: Vec<SearchResult>,
  lexical_results: Vec<SearchResult>,
  semantic_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
  let mut candidates: HashMap<Uid, SearchMergeCandidate> = HashMap::new();

  add_ranked_search_results(&mut candidates, title_results, SEARCH_TITLE_LEXICAL_WEIGHT);
  add_ranked_search_results(&mut candidates, lexical_results, SEARCH_LEXICAL_WEIGHT);
  add_ranked_search_results(&mut candidates, semantic_results, SEARCH_SEMANTIC_WEIGHT);

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

fn semantic_distance_to_search_score(distance: f32) -> f32 {
  clamp_search_score(1.0 - distance)
}

fn bm25_score_to_search_score(score: f32) -> f32 {
  if score <= 0.0 {
    return 0.0;
  }
  clamp_search_score(score / (score + SEARCH_BM25_SCORE_SATURATION))
}

fn exact_title_search_score(title: &str, search_text: &str) -> f32 {
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
    semantic_distance: None,
    lexical_score: Some(hit.score),
    score: bm25_score_to_search_score(hit.score),
    text,
    text_truncated,
    page_start: hit.page_start,
    page_end: hit.page_end,
  }
}

fn search_fragment_match_for_hit(
  hit: &crate::ai::vector_db::FragmentVectorHit,
  search_text: &str,
) -> SearchFragmentMatch {
  let (text, text_truncated) =
    search_match_excerpt(&hit.source_kind, &hit.text, search_text, SEARCH_FRAGMENT_MATCH_MAX_CHARS);
  SearchFragmentMatch {
    fragment_ordinal: hit.ordinal,
    source_kind: hit.source_kind.clone(),
    semantic_distance: Some(hit.distance),
    lexical_score: None,
    score: semantic_distance_to_search_score(hit.distance),
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
