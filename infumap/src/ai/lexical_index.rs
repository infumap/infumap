use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use tantivy::collector::{DocSetCollector, TopDocs};
use tantivy::indexer::NoMergePolicy;
use tantivy::query::{BooleanQuery, EmptyQuery, Query, QueryParser, TermQuery, TermSetQuery};
use tantivy::schema::{Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TEXT, Value};
use tantivy::{DocSet, Index, IndexWriter, Searcher, TERMINATED, TantivyDocument, Term};
use tokio::fs;

use crate::ai::search_index_paths::user_index_dir;

pub const DOCUMENT_FRAGMENT_LEXICAL_INDEX_DIR_NAME: &str = "document_fragments_tantivy";
pub const DOCUMENT_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "document_fragments_tantivy.tmp";
pub const DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME: &str = "infumap_document_fragment_index.json";
pub const DOCUMENT_FRAGMENT_LEXICAL_SCHEMA_VERSION: u32 = 1;
pub const ITEM_TITLE_LEXICAL_INDEX_DIR_NAME: &str = "item_titles_tantivy";
#[allow(dead_code)]
pub const ITEM_TITLE_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "item_titles_tantivy.tmp";
pub const ITEM_TITLE_LEXICAL_METADATA_FILENAME: &str = "infumap_item_title_index.json";
#[allow(dead_code)]
pub const ITEM_TITLE_LEXICAL_SCHEMA_VERSION: u32 = 1;

const ITEM_ID_FIELD: &str = "item_id";
const ORDINAL_FIELD: &str = "ordinal";
const SOURCE_KIND_FIELD: &str = "source_kind";
const PAGE_START_FIELD: &str = "page_start";
const PAGE_END_FIELD: &str = "page_end";
const TEXT_FIELD: &str = "text";
const INDEX_WRITER_HEAP_BYTES: usize = 50_000_000;
const INCREMENTAL_INDEX_WRITER_HEAP_BYTES: usize = 20_000_000;
const INCREMENTAL_SOURCE_DIGEST: &str = "incremental";
const NATURAL_TEXT_QUERY_MAX_TERMS: usize = 12;
const DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL: &str = "document fragment lexical index";
const ITEM_TITLE_LEXICAL_INDEX_LABEL: &str = "item title lexical index";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LexicalQueryMode {
  QuerySyntax,
  NaturalText,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LexicalFragment {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: String,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FragmentLexicalHit {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: String,
  pub score: f32,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FragmentLexicalIndexRebuildMetadata {
  pub source_digest: String,
  pub expected_fragment_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FragmentLexicalIndexRebuildStatus {
  pub schema_version: u32,
  pub source_digest: String,
  pub expected_fragment_count: usize,
  pub indexed_fragment_count: usize,
  pub complete: bool,
}

#[derive(Clone, Debug)]
pub struct TantivyDocumentFragmentIndex {
  index_dir: PathBuf,
}

#[derive(Clone, Debug)]
pub struct TantivyItemTitleIndex {
  index_dir: PathBuf,
}

#[derive(Clone, Copy)]
struct LexicalFields {
  item_id: Field,
  ordinal: Field,
  source_kind: Field,
  page_start: Field,
  page_end: Field,
  text: Field,
}

#[derive(Deserialize, Serialize)]
struct StoredLexicalIndexMetadata {
  schema_version: u32,
  source_digest: String,
  fragment_count: usize,
  complete: bool,
}

impl TantivyDocumentFragmentIndex {
  pub(crate) async fn indexed_item_ids(&self) -> InfuResult<HashSet<String>> {
    indexed_item_ids(&self.index_dir, DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL).await
  }

  pub fn new(index_dir: PathBuf) -> TantivyDocumentFragmentIndex {
    TantivyDocumentFragmentIndex { index_dir }
  }

  pub async fn rebuild_status(&self) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
    rebuild_status_for_index(
      &self.index_dir,
      DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME,
      DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn replace_items_fragments(&self, updates: &[(&str, &[LexicalFragment])]) -> InfuResult<usize> {
    replace_item_documents_in_index(
      &self.index_dir,
      updates,
      DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME,
      DOCUMENT_FRAGMENT_LEXICAL_SCHEMA_VERSION,
      DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn compact(&self) -> InfuResult<()> {
    compact_index(&self.index_dir, DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL)
  }

  /// `log_label` names the index in progress logs, e.g. with its user.
  pub async fn maintain(&self, log_label: &str) -> InfuResult<usize> {
    maintain_index_in_background(&self.index_dir, DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL, log_label).await
  }

  pub async fn search(
    &self,
    query_text: &str,
    limit: usize,
    allowed_item_ids: Option<&[String]>,
    query_mode: LexicalQueryMode,
  ) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      allowed_item_ids,
      query_mode,
      DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME,
      DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }
}

impl TantivyItemTitleIndex {
  /// The stored title documents of the given items, ordered by ordinal.
  pub(crate) async fn stored_titles_for_items(
    &self,
    item_ids: &[String],
  ) -> InfuResult<HashMap<String, Vec<LexicalFragment>>> {
    let mut titles = HashMap::<String, Vec<LexicalFragment>>::new();
    if item_ids.is_empty() || !fs::try_exists(&self.index_dir).await? {
      return Ok(titles);
    }
    let index_label = ITEM_TITLE_LEXICAL_INDEX_LABEL;
    let index = open_tantivy_index(&self.index_dir, index_label)?;
    let fields = fields_from_schema(&index.schema(), index_label)?;
    let reader = index.reader().map_err(|e| e.to_string())?;
    let searcher = reader.searcher();
    let query = TermSetQuery::new(item_ids.iter().map(|id| Term::from_field_text(fields.item_id, id)));
    let addresses = searcher.search(&query, &DocSetCollector).map_err(|e| e.to_string())?;
    for address in addresses {
      let doc: TantivyDocument = searcher.doc(address).map_err(|e| e.to_string())?;
      let fragment = stored_fragment(&doc, fields, index_label)?;
      titles.entry(fragment.item_id.clone()).or_default().push(fragment);
    }
    for fragments in titles.values_mut() {
      fragments.sort_by_key(|fragment| fragment.ordinal);
    }
    Ok(titles)
  }

  /// The stored title documents of every indexed item, ordered by ordinal.
  pub(crate) async fn indexed_titles(&self) -> InfuResult<HashMap<String, Vec<LexicalFragment>>> {
    if !fs::try_exists(&self.index_dir).await? {
      return Ok(HashMap::new());
    }
    let index_label = ITEM_TITLE_LEXICAL_INDEX_LABEL;
    let index = open_tantivy_index(&self.index_dir, index_label)?;
    let fields = fields_from_schema(&index.schema(), index_label)?;
    let reader = index.reader().map_err(|e| e.to_string())?;
    let searcher = reader.searcher();
    let mut titles = HashMap::<String, Vec<LexicalFragment>>::new();
    for (segment_ord, segment) in searcher.segment_readers().iter().enumerate() {
      for doc_id in segment.doc_ids_alive() {
        let doc: TantivyDocument =
          searcher.doc(tantivy::DocAddress::new(segment_ord as u32, doc_id)).map_err(|e| e.to_string())?;
        let fragment = stored_fragment(&doc, fields, index_label)?;
        titles.entry(fragment.item_id.clone()).or_default().push(fragment);
      }
    }
    for fragments in titles.values_mut() {
      fragments.sort_by_key(|fragment| fragment.ordinal);
    }
    Ok(titles)
  }

  pub fn new(index_dir: PathBuf) -> TantivyItemTitleIndex {
    TantivyItemTitleIndex { index_dir }
  }

  pub async fn rebuild_status(&self) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
    rebuild_status_for_index(&self.index_dir, ITEM_TITLE_LEXICAL_METADATA_FILENAME, ITEM_TITLE_LEXICAL_INDEX_LABEL)
      .await
  }

  pub async fn search(
    &self,
    query_text: &str,
    limit: usize,
    allowed_item_ids: Option<&[String]>,
    query_mode: LexicalQueryMode,
  ) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      allowed_item_ids,
      query_mode,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn replace_items_titles(&self, updates: &[(&str, &[LexicalFragment])]) -> InfuResult<usize> {
    replace_item_documents_in_index(
      &self.index_dir,
      updates,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_SCHEMA_VERSION,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn compact(&self) -> InfuResult<()> {
    compact_index(&self.index_dir, ITEM_TITLE_LEXICAL_INDEX_LABEL)
  }

  /// `log_label` names the index in progress logs, e.g. with its user.
  pub async fn maintain(&self, log_label: &str) -> InfuResult<usize> {
    maintain_index_in_background(&self.index_dir, ITEM_TITLE_LEXICAL_INDEX_LABEL, log_label).await
  }
}

pub fn document_fragment_lexical_index_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(DOCUMENT_FRAGMENT_LEXICAL_INDEX_DIR_NAME);
  Ok(path)
}

pub fn document_fragment_lexical_index_temp_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(DOCUMENT_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME);
  Ok(path)
}

pub fn item_title_lexical_index_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(ITEM_TITLE_LEXICAL_INDEX_DIR_NAME);
  Ok(path)
}

#[allow(dead_code)]
pub fn item_title_lexical_index_temp_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(ITEM_TITLE_LEXICAL_INDEX_TEMP_DIR_NAME);
  Ok(path)
}

pub async fn user_document_fragment_lexical_index_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = document_fragment_lexical_index_dir(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_dir()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect document fragment lexical index '{}': {}", path.display(), e).into()),
  }
}

pub async fn user_item_title_lexical_index_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = item_title_lexical_index_dir(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_dir()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect item title lexical index '{}': {}", path.display(), e).into()),
  }
}

pub fn open_user_document_fragment_lexical_index(
  data_dir: &str,
  user_id: &str,
) -> InfuResult<TantivyDocumentFragmentIndex> {
  Ok(TantivyDocumentFragmentIndex::new(document_fragment_lexical_index_dir(data_dir, user_id)?))
}

pub fn open_user_item_title_lexical_index(data_dir: &str, user_id: &str) -> InfuResult<TantivyItemTitleIndex> {
  Ok(TantivyItemTitleIndex::new(item_title_lexical_index_dir(data_dir, user_id)?))
}

/// Item ids with live documents, read from the item id term dictionary rather
/// than stored documents, so the indexed text is never decompressed.
async fn indexed_item_ids(index_dir: &Path, index_label: &str) -> InfuResult<HashSet<String>> {
  if !fs::try_exists(index_dir).await? {
    return Ok(HashSet::new());
  }
  let index = open_tantivy_index(index_dir, index_label)?;
  let fields = fields_from_schema(&index.schema(), index_label)?;
  let reader = index.reader().map_err(|e| e.to_string())?;
  let searcher = reader.searcher();
  let mut ids = HashSet::new();
  for segment in searcher.segment_readers() {
    let inverted_index = segment.inverted_index(fields.item_id).map_err(|e| e.to_string())?;
    let mut terms = inverted_index.terms().stream()?;
    while terms.advance() {
      // A replaced or removed item keeps its term until segments are merged.
      let alive = match segment.alive_bitset() {
        None => true,
        Some(alive_bitset) => {
          let mut postings = inverted_index.read_postings_from_terminfo(terms.value(), IndexRecordOption::Basic)?;
          let mut alive = false;
          while postings.doc() != TERMINATED {
            if alive_bitset.is_alive(postings.doc()) {
              alive = true;
              break;
            }
            postings.advance();
          }
          alive
        }
      };
      if alive {
        ids.insert(
          String::from_utf8(terms.key().to_vec())
            .map_err(|e| format!("{} item id term is not UTF-8: {}", index_label, e))?,
        );
      }
    }
  }
  Ok(ids)
}

async fn rebuild_status_for_index(
  index_dir: &Path,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
  if !path_ref_exists(index_dir).await {
    return Ok(None);
  }

  let metadata = match read_stored_metadata(index_dir, metadata_filename, index_label).await? {
    Some(metadata) => metadata,
    None => return Ok(None),
  };
  let indexed_fragment_count = match open_tantivy_index(index_dir, index_label) {
    Ok(index) => index_doc_count(&index, index_label)?,
    Err(_) => 0,
  };

  Ok(Some(FragmentLexicalIndexRebuildStatus {
    schema_version: metadata.schema_version,
    source_digest: metadata.source_digest,
    expected_fragment_count: metadata.fragment_count,
    indexed_fragment_count,
    complete: metadata.complete,
  }))
}

async fn replace_item_documents_in_index(
  index_dir: &Path,
  updates: &[(&str, &[LexicalFragment])],
  metadata_filename: &str,
  schema_version: u32,
  index_label: &str,
) -> InfuResult<usize> {
  for (item_id, fragments) in updates {
    if item_id.trim().is_empty() {
      return Err(format!("Cannot update {} for an empty item id.", index_label).into());
    }
    if let Some(fragment) = fragments.iter().find(|fragment| fragment.item_id != *item_id) {
      return Err(
        format!("Cannot update {} item '{}': fragment belongs to item '{}'.", index_label, item_id, fragment.item_id)
          .into(),
      );
    }
  }

  if !path_ref_exists(index_dir).await {
    if updates.iter().all(|(_, fragments)| fragments.is_empty()) {
      return Ok(0);
    }
    if let Some(parent) = index_dir.parent() {
      fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("Could not create {} parent directory '{}': {}", index_label, parent.display(), e))?;
    }
    fs::create_dir_all(index_dir)
      .await
      .map_err(|e| format!("Could not create {} directory '{}': {}", index_label, index_dir.display(), e))?;
    let (schema, _) = lexical_schema();
    Index::create_in_dir(index_dir, schema)
      .map_err(|e| format!("Could not create {} '{}': {}", index_label, index_dir.display(), e))?;
  }

  let index = open_tantivy_index(index_dir, index_label)?;
  let schema = index.schema();
  let fields = fields_from_schema(&schema, index_label)?;
  let mut writer: IndexWriter<TantivyDocument> = index
    .writer(INCREMENTAL_INDEX_WRITER_HEAP_BYTES)
    .map_err(|e| format!("Could not open {} writer '{}': {}", index_label, index_dir.display(), e))?;
  // Deliberate trade-off: live commits never merge segments, keeping each
  // commit cheap. Segments accumulate and are merged by the daily maintenance
  // pass (see maintain_index), not per commit.
  writer.set_merge_policy(Box::new(NoMergePolicy));
  for (item_id, fragments) in updates {
    writer.delete_term(Term::from_field_text(fields.item_id, item_id));
    for fragment in *fragments {
      writer.add_document(tantivy_document_for_fragment(fields, fragment)).map_err(|e| {
        format!(
          "Could not add lexical fragment '{}:{}' to {} '{}': {}",
          fragment.item_id,
          fragment.ordinal,
          index_label,
          index_dir.display(),
          e
        )
      })?;
    }
  }
  writer.commit().map_err(|e| format!("Could not commit {} update '{}': {}", index_label, index_dir.display(), e))?;

  let fragment_count = index_doc_count(&index, index_label)?;
  write_stored_metadata(
    index_dir,
    &FragmentLexicalIndexRebuildMetadata {
      source_digest: INCREMENTAL_SOURCE_DIGEST.to_owned(),
      expected_fragment_count: fragment_count,
    },
    true,
    metadata_filename,
    schema_version,
    index_label,
  )
  .await?;
  Ok(updates.iter().map(|(_, fragments)| fragments.len()).sum())
}

async fn search_index(
  index_dir: &Path,
  query_text: &str,
  limit: usize,
  allowed_item_ids: Option<&[String]>,
  query_mode: LexicalQueryMode,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Vec<FragmentLexicalHit>> {
  if limit == 0
    || query_text.trim().is_empty()
    || allowed_item_ids.is_some_and(|item_ids| item_ids.is_empty())
    || !path_ref_exists(index_dir).await
  {
    return Ok(Vec::new());
  }
  let Some(status) = rebuild_status_for_index(index_dir, metadata_filename, index_label).await? else {
    return Ok(Vec::new());
  };
  if !status.complete {
    return Ok(Vec::new());
  }

  let index = open_tantivy_index(index_dir, index_label)?;
  let schema = index.schema();
  let fields = fields_from_schema(&schema, index_label)?;
  let reader =
    index.reader().map_err(|e| format!("Could not open {} reader '{}': {}", index_label, index_dir.display(), e))?;
  let searcher = reader.searcher();
  let query = match query_mode {
    LexicalQueryMode::QuerySyntax => parsed_lexical_query(&index, fields.text, query_text, index_label),
    LexicalQueryMode::NaturalText => {
      natural_text_lexical_query(&index, &searcher, fields.text, query_text, index_label)?
    }
  };
  let query = if let Some(item_ids) = allowed_item_ids {
    let item_terms: Vec<Term> = item_ids.iter().map(|item_id| Term::from_field_text(fields.item_id, item_id)).collect();
    Box::new(BooleanQuery::intersection(vec![query, Box::new(TermSetQuery::new(item_terms))])) as Box<dyn Query>
  } else {
    query
  };

  let top_docs = searcher
    .search(&query, &TopDocs::with_limit(limit).order_by_score())
    .map_err(|e| format!("Could not search {} '{}': {}", index_label, index_dir.display(), e))?;
  let mut hits = Vec::new();
  for (score, doc_address) in top_docs {
    let doc = searcher
      .doc::<TantivyDocument>(doc_address)
      .map_err(|e| format!("Could not read {} document '{}': {}", index_label, index_dir.display(), e))?;
    hits.push(hit_from_document(fields, score, &doc, index_label)?);
  }
  Ok(hits)
}

fn parsed_lexical_query(index: &Index, text_field: Field, query_text: &str, index_label: &str) -> Box<dyn Query> {
  let mut query_parser = QueryParser::for_index(index, vec![text_field]);
  query_parser.set_conjunction_by_default();
  let (query, parse_errors) = query_parser.parse_query_lenient(query_text);
  if !parse_errors.is_empty() {
    log::debug!("{} query '{}' had {} lenient parser issue(s).", index_label, query_text, parse_errors.len());
  }
  query
}

fn natural_text_lexical_query(
  index: &Index,
  searcher: &Searcher,
  text_field: Field,
  query_text: &str,
  index_label: &str,
) -> InfuResult<Box<dyn Query>> {
  let mut analyzer = index
    .tokenizer_for_field(text_field)
    .map_err(|e| format!("Could not load {} text analyzer: {}", index_label, e))?;
  let mut token_stream = analyzer.token_stream(query_text);
  let mut seen = HashSet::new();
  let mut token_texts = Vec::new();
  token_stream.process(&mut |token| {
    if seen.insert(token.text.clone()) {
      token_texts.push(token.text.clone());
    }
  });

  let mut candidates = Vec::new();
  for (position, token_text) in token_texts.into_iter().enumerate() {
    let term = Term::from_field_text(text_field, &token_text);
    let document_frequency =
      searcher.doc_freq(&term).map_err(|e| format!("Could not inspect {} term frequency: {}", index_label, e))?;
    if document_frequency > 0 {
      candidates.push((document_frequency, position, term));
    }
  }
  candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
  candidates.truncate(NATURAL_TEXT_QUERY_MAX_TERMS);
  candidates.sort_by_key(|candidate| candidate.1);

  if candidates.is_empty() {
    return Ok(Box::new(EmptyQuery));
  }
  let term_queries = candidates
    .into_iter()
    .map(|(_, _, term)| Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)) as Box<dyn Query>)
    .collect();
  Ok(Box::new(BooleanQuery::union(term_queries)))
}

fn lexical_schema() -> (Schema, LexicalFields) {
  let mut schema_builder = Schema::builder();
  let item_id = schema_builder.add_text_field(ITEM_ID_FIELD, STRING | STORED);
  let ordinal = schema_builder.add_u64_field(ORDINAL_FIELD, INDEXED | STORED);
  let source_kind = schema_builder.add_text_field(SOURCE_KIND_FIELD, STRING | STORED);
  let page_start = schema_builder.add_u64_field(PAGE_START_FIELD, STORED);
  let page_end = schema_builder.add_u64_field(PAGE_END_FIELD, STORED);
  let text = schema_builder.add_text_field(TEXT_FIELD, TEXT | STORED);
  let schema = schema_builder.build();
  (schema, LexicalFields { item_id, ordinal, source_kind, page_start, page_end, text })
}

fn fields_from_schema(schema: &Schema, index_label: &str) -> InfuResult<LexicalFields> {
  Ok(LexicalFields {
    item_id: schema.get_field(ITEM_ID_FIELD).map_err(|e| format!("{} schema missing item_id: {}", index_label, e))?,
    ordinal: schema.get_field(ORDINAL_FIELD).map_err(|e| format!("{} schema missing ordinal: {}", index_label, e))?,
    source_kind: schema
      .get_field(SOURCE_KIND_FIELD)
      .map_err(|e| format!("{} schema missing source_kind: {}", index_label, e))?,
    page_start: schema
      .get_field(PAGE_START_FIELD)
      .map_err(|e| format!("{} schema missing page_start: {}", index_label, e))?,
    page_end: schema
      .get_field(PAGE_END_FIELD)
      .map_err(|e| format!("{} schema missing page_end: {}", index_label, e))?,
    text: schema.get_field(TEXT_FIELD).map_err(|e| format!("{} schema missing text: {}", index_label, e))?,
  })
}

fn tantivy_document_for_fragment(fields: LexicalFields, fragment: &LexicalFragment) -> TantivyDocument {
  let mut doc = TantivyDocument::new();
  doc.add_text(fields.item_id, &fragment.item_id);
  doc.add_u64(fields.ordinal, fragment.ordinal as u64);
  doc.add_text(fields.source_kind, &fragment.source_kind);
  if let Some(page_start) = fragment.page_start {
    doc.add_u64(fields.page_start, page_start as u64);
  }
  if let Some(page_end) = fragment.page_end {
    doc.add_u64(fields.page_end, page_end as u64);
  }
  doc.add_text(fields.text, &fragment.text);
  doc
}

fn hit_from_document(
  fields: LexicalFields,
  score: f32,
  doc: &TantivyDocument,
  index_label: &str,
) -> InfuResult<FragmentLexicalHit> {
  Ok(FragmentLexicalHit {
    item_id: required_text_field(doc, fields.item_id, ITEM_ID_FIELD, index_label)?.to_owned(),
    ordinal: required_usize_field(doc, fields.ordinal, ORDINAL_FIELD, index_label)?,
    source_kind: required_text_field(doc, fields.source_kind, SOURCE_KIND_FIELD, index_label)?.to_owned(),
    score,
    text: required_text_field(doc, fields.text, TEXT_FIELD, index_label)?.to_owned(),
    page_start: optional_usize_field(doc, fields.page_start, PAGE_START_FIELD, index_label)?,
    page_end: optional_usize_field(doc, fields.page_end, PAGE_END_FIELD, index_label)?,
  })
}

fn stored_fragment(doc: &TantivyDocument, fields: LexicalFields, index_label: &str) -> InfuResult<LexicalFragment> {
  Ok(LexicalFragment {
    item_id: required_text_field(doc, fields.item_id, ITEM_ID_FIELD, index_label)?.to_owned(),
    ordinal: required_usize_field(doc, fields.ordinal, ORDINAL_FIELD, index_label)?,
    source_kind: required_text_field(doc, fields.source_kind, SOURCE_KIND_FIELD, index_label)?.to_owned(),
    text: required_text_field(doc, fields.text, TEXT_FIELD, index_label)?.to_owned(),
    page_start: optional_usize_field(doc, fields.page_start, PAGE_START_FIELD, index_label)?,
    page_end: optional_usize_field(doc, fields.page_end, PAGE_END_FIELD, index_label)?,
  })
}

fn required_text_field<'a>(
  doc: &'a TantivyDocument,
  field: Field,
  field_name: &str,
  index_label: &str,
) -> InfuResult<&'a str> {
  doc
    .get_first(field)
    .and_then(|value| value.as_str())
    .ok_or_else(|| format!("{} hit missing text field '{}'.", index_label, field_name).into())
}

fn required_usize_field(doc: &TantivyDocument, field: Field, field_name: &str, index_label: &str) -> InfuResult<usize> {
  optional_usize_field(doc, field, field_name, index_label)?
    .ok_or_else(|| format!("{} hit missing integer field '{}'.", index_label, field_name).into())
}

fn optional_usize_field(
  doc: &TantivyDocument,
  field: Field,
  field_name: &str,
  index_label: &str,
) -> InfuResult<Option<usize>> {
  doc
    .get_first(field)
    .map(|value| {
      value
        .as_u64()
        .ok_or_else(|| format!("{} hit field '{}' was not an unsigned integer.", index_label, field_name).into())
        .and_then(|value| usize::try_from(value).map_err(|e| e.into()))
    })
    .transpose()
}

fn lexical_metadata_path(index_dir: &Path, metadata_filename: &str) -> PathBuf {
  index_dir.join(metadata_filename)
}

async fn read_stored_metadata(
  index_dir: &Path,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Option<StoredLexicalIndexMetadata>> {
  let metadata_path = lexical_metadata_path(index_dir, metadata_filename);
  match fs::read_to_string(&metadata_path).await {
    Ok(contents) => serde_json::from_str(&contents)
      .map(Some)
      .map_err(|e| format!("Could not parse {} metadata '{}': {}", index_label, metadata_path.display(), e).into()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read {} metadata '{}': {}", index_label, metadata_path.display(), e).into()),
  }
}

async fn write_stored_metadata(
  index_dir: &Path,
  metadata: &FragmentLexicalIndexRebuildMetadata,
  complete: bool,
  metadata_filename: &str,
  schema_version: u32,
  index_label: &str,
) -> InfuResult<()> {
  let stored = StoredLexicalIndexMetadata {
    schema_version,
    source_digest: metadata.source_digest.clone(),
    fragment_count: metadata.expected_fragment_count,
    complete,
  };
  let metadata_path = lexical_metadata_path(index_dir, metadata_filename);
  crate::ai::artifact_io::atomic_write(&metadata_path, &serde_json::to_vec_pretty(&stored)?)
    .await
    .map_err(|e| format!("Could not write {} metadata '{}': {}", index_label, metadata_path.display(), e).into())
}

fn open_tantivy_index(index_dir: &Path, index_label: &str) -> InfuResult<Index> {
  Index::open_in_dir(index_dir)
    .map_err(|e| format!("Could not open {} '{}': {}", index_label, index_dir.display(), e).into())
}

fn index_doc_count(index: &Index, index_label: &str) -> InfuResult<usize> {
  let reader = index.reader().map_err(|e| format!("Could not open {} reader: {}", index_label, e))?;
  usize::try_from(reader.searcher().num_docs()).map_err(|e| e.into())
}

/// When the index workers check their indexes for maintenance. The first check
/// is delayed so that it does not add to startup work.
pub const INDEX_MAINTENANCE_FIRST_DELAY: Duration = Duration::from_secs(60 * 60);
pub const INDEX_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Below this many segments an index is left alone.
const MAINTENANCE_MAX_SEGMENTS: usize = 16;

/// Merge an index's segments if there are enough of them to matter, without
/// rewriting the whole index each time. Returns the number of segments merged.
///
/// Deliberate trade-off: this runs about once a day (see the index workers),
/// so an index may have extra segments and deleted documents for up to a day.
/// Normally only the small segments are merged, leaving the largest untouched,
/// so the cost follows recent changes rather than index size. Everything is
/// merged only when deleted documents exceed a quarter of the index, or when the
/// small segments together reach half the largest (otherwise the merged segment
/// would keep growing and be rewritten every day).
fn maintain_index(index_dir: &Path, index_label: &str, log_label: &str) -> InfuResult<usize> {
  if !index_dir.exists() {
    return Ok(0);
  }
  let index = open_tantivy_index(index_dir, index_label)?;
  let segments = index
    .searchable_segment_metas()
    .map_err(|e| format!("Could not list {} segments '{}': {}", index_label, index_dir.display(), e))?;
  if segments.len() <= MAINTENANCE_MAX_SEGMENTS {
    return Ok(0);
  }
  let total_docs = segments.iter().map(|segment| segment.max_doc() as u64).sum::<u64>();
  let deleted_docs = segments.iter().map(|segment| segment.num_deleted_docs() as u64).sum::<u64>();
  let largest = segments.iter().max_by_key(|segment| segment.max_doc()).map(|segment| segment.id());
  let smaller = segments.iter().filter(|segment| Some(segment.id()) != largest).collect::<Vec<_>>();
  let smaller_docs = smaller.iter().map(|segment| segment.max_doc() as u64).sum::<u64>();
  let largest_docs = total_docs - smaller_docs;
  let segment_ids = if deleted_docs * 4 > total_docs || smaller_docs * 2 >= largest_docs {
    segments.iter().map(|segment| segment.id()).collect::<Vec<_>>()
  } else {
    smaller.iter().map(|segment| segment.id()).collect::<Vec<_>>()
  };

  log::info!(
    "{}: merging {} of {} segments ({} documents, {} deleted).",
    log_label,
    segment_ids.len(),
    segments.len(),
    total_docs,
    deleted_docs
  );
  let mut writer: IndexWriter<TantivyDocument> = index
    .writer(INDEX_WRITER_HEAP_BYTES)
    .map_err(|e| format!("Could not open {} writer for maintenance '{}': {}", index_label, index_dir.display(), e))?;
  writer.set_merge_policy(Box::new(NoMergePolicy));
  writer
    .merge(&segment_ids)
    .wait()
    .map_err(|e| format!("Could not merge {} segments '{}': {}", index_label, index_dir.display(), e))?;
  writer
    .wait_merging_threads()
    .map_err(|e| format!("Could not finish {} merge '{}': {}", index_label, index_dir.display(), e))?;
  Ok(segment_ids.len())
}

async fn maintain_index_in_background(
  index_dir: &Path,
  index_label: &'static str,
  log_label: &str,
) -> InfuResult<usize> {
  let index_dir = index_dir.to_path_buf();
  let log_label = log_label.to_owned();
  tokio::task::spawn_blocking(move || maintain_index(&index_dir, index_label, &log_label))
    .await
    .map_err(|e| format!("{} maintenance task failed: {}", index_label, e))?
}

fn compact_index(index_dir: &Path, index_label: &str) -> InfuResult<()> {
  if !index_dir.exists() {
    return Ok(());
  }
  let index = open_tantivy_index(index_dir, index_label)?;
  let segment_ids = index
    .searchable_segment_ids()
    .map_err(|e| format!("Could not list {} segments '{}': {}", index_label, index_dir.display(), e))?;
  if segment_ids.len() <= 1 {
    return Ok(());
  }
  let mut writer: IndexWriter<TantivyDocument> = index
    .writer(INDEX_WRITER_HEAP_BYTES)
    .map_err(|e| format!("Could not open {} writer for compaction '{}': {}", index_label, index_dir.display(), e))?;
  writer.set_merge_policy(Box::new(NoMergePolicy));
  writer
    .merge(&segment_ids)
    .wait()
    .map_err(|e| format!("Could not compact {} '{}': {}", index_label, index_dir.display(), e))?;
  writer
    .wait_merging_threads()
    .map_err(|e| format!("Could not finish {} compaction '{}': {}", index_label, index_dir.display(), e).into())
}

async fn path_ref_exists(path: &Path) -> bool {
  fs::metadata(path).await.is_ok()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fragment(item_id: &str) -> LexicalFragment {
    LexicalFragment {
      item_id: item_id.to_owned(),
      ordinal: 0,
      source_kind: "text".to_owned(),
      text: format!("zebra {}", item_id),
      page_start: None,
      page_end: None,
    }
  }

  async fn commit_items(index: &TantivyDocumentFragmentIndex, item_ids: &[String]) {
    let fragments = item_ids.iter().map(|id| (id.clone(), vec![fragment(id)])).collect::<Vec<_>>();
    let updates = fragments.iter().map(|(id, f)| (id.as_str(), f.as_slice())).collect::<Vec<_>>();
    index.replace_items_fragments(&updates).await.unwrap();
  }

  fn segment_count(index_dir: &Path) -> usize {
    open_tantivy_index(index_dir, "test").unwrap().searchable_segment_ids().unwrap().len()
  }

  fn temp_index_dir() -> PathBuf {
    std::env::temp_dir().join(format!("infumap-maintenance-test-{}", infusdk::util::uid::new_uid()))
  }

  #[tokio::test]
  async fn merges_many_small_segments_into_one() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    for n in 0..20 {
      commit_items(&index, &[format!("item{}", n)]).await;
    }
    assert_eq!(segment_count(&dir), 20);
    assert_eq!(index.maintain("test").await.unwrap(), 20);
    assert_eq!(segment_count(&dir), 1);
    assert_eq!(index.indexed_item_ids().await.unwrap().len(), 20);
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn leaves_large_segment_alone_and_small_indexes_untouched() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    commit_items(&index, &(0..100).map(|n| format!("base{}", n)).collect::<Vec<_>>()).await;
    for n in 0..10 {
      commit_items(&index, &[format!("item{}", n)]).await;
    }
    assert_eq!(index.maintain("test").await.unwrap(), 0, "11 segments is below the threshold");
    for n in 10..17 {
      commit_items(&index, &[format!("item{}", n)]).await;
    }
    assert_eq!(index.maintain("test").await.unwrap(), 17);
    assert_eq!(segment_count(&dir), 2);
    assert_eq!(index.indexed_item_ids().await.unwrap().len(), 117);
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn merges_everything_when_many_documents_are_deleted() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    commit_items(&index, &(0..100).map(|n| format!("base{}", n)).collect::<Vec<_>>()).await;
    // Each commit replaces two base items, deleting their old documents.
    for n in 0..17 {
      commit_items(&index, &[format!("base{}", n * 2), format!("base{}", n * 2 + 1)]).await;
    }
    assert_eq!(index.maintain("test").await.unwrap(), 18);
    assert_eq!(segment_count(&dir), 1);
    assert_eq!(index.indexed_item_ids().await.unwrap().len(), 100);
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn indexed_item_ids_excludes_removed_items() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    commit_items(&index, &["a".to_owned(), "b".to_owned(), "c".to_owned()]).await;
    commit_items(&index, &["b".to_owned()]).await;
    index.replace_items_fragments(&[("c", &[])]).await.unwrap();
    let ids = index.indexed_item_ids().await.unwrap();
    assert_eq!(ids, ["a", "b"].iter().map(|id| id.to_string()).collect::<HashSet<_>>());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn stored_titles_for_items_returns_only_requested_live_titles() {
    let dir = temp_index_dir();
    let index = TantivyItemTitleIndex::new(dir.clone());
    let title = |id: &str, text: &str| LexicalFragment {
      item_id: id.to_owned(),
      ordinal: 1,
      source_kind: "item_title".to_owned(),
      text: text.to_owned(),
      page_start: None,
      page_end: None,
    };
    let (a, b, c) = (title("a", "Alpha"), title("b", "Beta"), title("c", "Gamma"));
    index.replace_items_titles(&[("a", &[a.clone()]), ("b", &[b]), ("c", &[c])]).await.unwrap();
    let renamed = title("b", "Beta renamed");
    index.replace_items_titles(&[("b", &[renamed.clone()])]).await.unwrap();
    let stored = index.stored_titles_for_items(&["a".to_owned(), "b".to_owned(), "missing".to_owned()]).await.unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored["a"], vec![a]);
    assert_eq!(stored["b"], vec![renamed]);
    let _ = std::fs::remove_dir_all(dir);
  }
}
