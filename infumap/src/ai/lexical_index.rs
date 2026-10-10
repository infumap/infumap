use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use infusdk::util::infu::InfuResult;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tantivy::collector::{DocSetCollector, TopDocs};
use tantivy::indexer::NoMergePolicy;
use tantivy::query::{BooleanQuery, BoostQuery, ConstScoreQuery, EmptyQuery, Occur, Query, TermQuery, TermSetQuery};
use tantivy::schema::{
  Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions, Value,
};
use tantivy::tokenizer::{Language, LowerCaser, RemoveLongFilter, SimpleTokenizer, Stemmer, TextAnalyzer};
use tantivy::{DocSet, Index, IndexReader, IndexWriter, ReloadPolicy, Searcher, TERMINATED, TantivyDocument, Term};
use tokio::fs;

use crate::ai::search_index_paths::user_index_dir;

pub const DOCUMENT_FRAGMENT_LEXICAL_INDEX_DIR_NAME: &str = "document_fragments_tantivy";
pub const DOCUMENT_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "document_fragments_tantivy.tmp";
pub const DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME: &str = "infumap_document_fragment_index.json";
// 2: words are stemmed (English Snowball).
// 3: an image's context line is indexed apart from its text.
pub const DOCUMENT_FRAGMENT_LEXICAL_SCHEMA_VERSION: u32 = 3;
pub const ITEM_TITLE_LEXICAL_INDEX_DIR_NAME: &str = "item_titles_tantivy";
#[allow(dead_code)]
pub const ITEM_TITLE_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "item_titles_tantivy.tmp";
pub const ITEM_TITLE_LEXICAL_METADATA_FILENAME: &str = "infumap_item_title_index.json";
// 2: words are stemmed (English Snowball).
// 3: the parent's title is indexed apart from the item's own titles.
pub const ITEM_TITLE_LEXICAL_SCHEMA_VERSION: u32 = 3;

const ITEM_ID_FIELD: &str = "item_id";
const ORDINAL_FIELD: &str = "ordinal";
const SOURCE_KIND_FIELD: &str = "source_kind";
const PAGE_START_FIELD: &str = "page_start";
const PAGE_END_FIELD: &str = "page_end";
const TEXT_FIELD: &str = "text";
const CONTEXT_FIELD: &str = "context";
const INDEX_WRITER_HEAP_BYTES: usize = 50_000_000;
const INCREMENTAL_INDEX_WRITER_HEAP_BYTES: usize = 20_000_000;
const INCREMENTAL_SOURCE_DIGEST: &str = "incremental";
const NATURAL_TEXT_QUERY_MAX_TERMS: usize = 12;
/// How much a word found in a document's context counts toward its score, relative to one in its own text.
const CONTEXT_WORD_WEIGHT: f32 = 0.5;
const TEXT_TOKENIZER: &str = "en_stem";
const DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL: &str = "document fragment lexical index";
const ITEM_TITLE_LEXICAL_INDEX_LABEL: &str = "item title lexical index";

/// Words as the indexes store them: split on anything that is not a letter or digit, overlong tokens dropped,
/// lowercased, and reduced to their English stem, so "staying" matches "stay". Text in other languages goes through the
/// same English rules at index and query time, so a word always still matches itself.
fn text_analyzer() -> TextAnalyzer {
  TextAnalyzer::builder(SimpleTokenizer::default())
    .filter(RemoveLongFilter::limit(40))
    .filter(LowerCaser)
    .filter(Stemmer::new(Language::English))
    .build()
}

/// The indexed form of one word: lowercased and stemmed. Empty if the word would not be indexed.
pub fn index_word(word: &str) -> String {
  thread_local! {
    static ANALYZER: std::cell::RefCell<TextAnalyzer> = std::cell::RefCell::new(text_analyzer());
  }
  ANALYZER.with(|analyzer| {
    let mut analyzer = analyzer.borrow_mut();
    let mut stream = analyzer.token_stream(word);
    if stream.advance() { stream.token().text.clone() } else { String::new() }
  })
}

/// How many distinct words a natural-text query has, as the indexes store them, up to the most a query uses. Words
/// that no document contains are dropped from the query, so fewer may count.
pub fn natural_text_word_count(query_text: &str) -> usize {
  let mut words = HashSet::new();
  text_analyzer().token_stream(query_text).process(&mut |token| {
    words.insert(token.text.clone());
  });
  words.len().min(NATURAL_TEXT_QUERY_MAX_TERMS)
}

/// Removes this user's indexes built with an older schema, such as before stemming, which would no longer match the
/// queries. The startup check then rebuilds them as it would after a manual deletion. Returns how many were removed.
pub async fn remove_outdated_lexical_indexes(data_dir: &str, user_id: &str) -> InfuResult<usize> {
  let indexes = [
    (
      document_fragment_lexical_index_dir(data_dir, user_id)?,
      DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME,
      DOCUMENT_FRAGMENT_LEXICAL_SCHEMA_VERSION,
      DOCUMENT_FRAGMENT_LEXICAL_INDEX_LABEL,
    ),
    (
      item_title_lexical_index_dir(data_dir, user_id)?,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_SCHEMA_VERSION,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    ),
  ];
  let mut removed = 0;
  for (index_dir, metadata_filename, schema_version, index_label) in indexes {
    let Some(metadata) = read_stored_metadata(&index_dir, metadata_filename, index_label).await? else {
      continue;
    };
    if metadata.schema_version == schema_version {
      continue;
    }
    forget_open_index(&index_dir);
    fs::remove_dir_all(&index_dir)
      .await
      .map_err(|e| format!("Could not remove outdated {} '{}': {}", index_label, index_dir.display(), e))?;
    log::info!(
      "Removed {} '{}' built with schema {} (now {}); it will be rebuilt.",
      index_label,
      index_dir.display(),
      metadata.schema_version,
      schema_version
    );
    removed += 1;
  }
  Ok(removed)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LexicalFragment {
  pub item_id: String,
  pub ordinal: usize,
  pub source_kind: String,
  pub text: String,
  /// Where the item is, such as its parent's title. See `MatchedWords`.
  pub context: Option<String>,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

/// Where a search's matching words must be. Words in a document's context count toward the words it matches, so a
/// note "Cocktails" on the page "Malaysia" matches both words of "malaysia cocktails", but by default context alone
/// does not match it: the page itself matches "malaysia", and every item on it would too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchedWords {
  /// At least one in the document's own text.
  Own,
  /// Only in its context.
  ContextOnly,
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
  context: Field,
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

  /// Documents containing at least `min_matching_words` of the query's words, where `matched` says, best first.
  pub async fn search(
    &self,
    query_text: &str,
    limit: usize,
    allowed_item_ids: Option<&[String]>,
    min_matching_words: usize,
    matched: MatchedWords,
  ) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      allowed_item_ids,
      min_matching_words,
      matched,
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

  /// Documents containing at least `min_matching_words` of the query's words, where `matched` says, best first.
  pub async fn search(
    &self,
    query_text: &str,
    limit: usize,
    allowed_item_ids: Option<&[String]>,
    min_matching_words: usize,
    matched: MatchedWords,
  ) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      allowed_item_ids,
      min_matching_words,
      matched,
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

/// An open index with its reader and completeness status, reused across
/// searches. Opening an index and reader reads every segment's headers, which
/// is slow on small hardware, so it happens once per index change rather than
/// several times per query.
struct OpenIndex {
  index: Index,
  reader: IndexReader,
  fields: LexicalFields,
  status: Option<FragmentLexicalIndexRebuildStatus>,
}

/// Every write to an index in this process drops its entry (see
/// `forget_open_index`), so the next search reopens it and sees the change.
/// Indexes are not modified by other processes while the server runs.
static OPEN_INDEXES: Lazy<Mutex<HashMap<PathBuf, Arc<OpenIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn forget_open_index(index_dir: &Path) {
  if let Ok(mut open_indexes) = OPEN_INDEXES.lock() {
    open_indexes.remove(index_dir);
  }
}

async fn open_index_cached(
  index_dir: &Path,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Option<Arc<OpenIndex>>> {
  if !path_ref_exists(index_dir).await {
    forget_open_index(index_dir);
    return Ok(None);
  }
  if let Some(open_index) = OPEN_INDEXES.lock().ok().and_then(|open_indexes| open_indexes.get(index_dir).cloned()) {
    return Ok(Some(open_index));
  }

  let metadata = read_stored_metadata(index_dir, metadata_filename, index_label).await?;
  let index = open_tantivy_index(index_dir, index_label)?;
  let fields = fields_from_schema(&index.schema(), index_label)?;
  // Manual reload: the default policy starts a file-watcher thread per reader,
  // and entries are replaced after writes anyway. No document cache: by default
  // each segment keeps up to 100 decompressed blocks (about 1.6 MB), which a
  // long-lived reader would hold indefinitely; infrequent searches gain nothing
  // from it.
  let reader: IndexReader = index
    .reader_builder()
    .reload_policy(ReloadPolicy::Manual)
    .doc_store_cache_num_blocks(0)
    .try_into()
    .map_err(|e| format!("Could not open {} reader '{}': {}", index_label, index_dir.display(), e))?;
  let indexed_fragment_count = usize::try_from(reader.searcher().num_docs())?;
  let status = metadata.map(|metadata| FragmentLexicalIndexRebuildStatus {
    schema_version: metadata.schema_version,
    source_digest: metadata.source_digest,
    expected_fragment_count: metadata.fragment_count,
    indexed_fragment_count,
    complete: metadata.complete,
  });
  let open_index = Arc::new(OpenIndex { index, reader, fields, status });
  if let Ok(mut open_indexes) = OPEN_INDEXES.lock() {
    open_indexes.insert(index_dir.to_path_buf(), open_index.clone());
  }
  Ok(Some(open_index))
}

async fn rebuild_status_for_index(
  index_dir: &Path,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
  if let Ok(open_index) = open_index_cached(index_dir, metadata_filename, index_label).await {
    return Ok(open_index.and_then(|open_index| open_index.status.clone()));
  }
  // The index could not be opened; report its metadata with no documents.
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
  let committed = writer.commit();
  forget_open_index(index_dir);
  committed.map_err(|e| format!("Could not commit {} update '{}': {}", index_label, index_dir.display(), e))?;

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
  min_matching_words: usize,
  matched: MatchedWords,
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
  let Some(open_index) = open_index_cached(index_dir, metadata_filename, index_label).await? else {
    return Ok(Vec::new());
  };
  if !open_index.status.as_ref().is_some_and(|status| status.complete) {
    return Ok(Vec::new());
  }

  let index = &open_index.index;
  let fields = open_index.fields;
  let searcher = open_index.reader.searcher();
  let query =
    natural_text_lexical_query(index, &searcher, fields, query_text, min_matching_words, matched, index_label)?;
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

fn natural_text_lexical_query(
  index: &Index,
  searcher: &Searcher,
  fields: LexicalFields,
  query_text: &str,
  min_matching_words: usize,
  matched: MatchedWords,
  index_label: &str,
) -> InfuResult<Box<dyn Query>> {
  let mut analyzer = index
    .tokenizer_for_field(fields.text)
    .map_err(|e| format!("Could not load {} text analyzer: {}", index_label, e))?;
  let mut token_stream = analyzer.token_stream(query_text);
  let mut seen = HashSet::new();
  let mut token_texts = Vec::new();
  token_stream.process(&mut |token| {
    if seen.insert(token.text.clone()) {
      token_texts.push(token.text.clone());
    }
  });

  let doc_freq = |term: &Term| {
    searcher.doc_freq(term).map_err(|e| format!("Could not inspect {} term frequency: {}", index_label, e))
  };
  let mut candidates = Vec::new();
  for (position, token_text) in token_texts.into_iter().enumerate() {
    let own = Term::from_field_text(fields.text, &token_text);
    let context = Term::from_field_text(fields.context, &token_text);
    // Used only to order the words by rarity, so a document counted twice, once per field, does not matter.
    let document_frequency = doc_freq(&own)? + doc_freq(&context)?;
    if document_frequency > 0 {
      candidates.push((document_frequency, position, own, context));
    }
  }
  candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
  candidates.truncate(NATURAL_TEXT_QUERY_MAX_TERMS);
  candidates.sort_by_key(|candidate| candidate.1);

  let min_matching_words = min_matching_words.max(1);
  if candidates.len() < min_matching_words {
    return Ok(Box::new(EmptyQuery));
  }
  let term_query = |term: Term| Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)) as Box<dyn Query>;
  let mut own_queries = Vec::new();
  let mut word_queries = Vec::new();
  for (_, _, own, context) in candidates {
    own_queries.push(term_query(own.clone()));
    // A word counts once, found in either field.
    let in_context = Box::new(BoostQuery::new(term_query(context), CONTEXT_WORD_WEIGHT));
    word_queries.push(Box::new(BooleanQuery::union(vec![term_query(own), in_context])) as Box<dyn Query>);
  }
  let words = Box::new(BooleanQuery::union_with_minimum_required_clauses(word_queries, min_matching_words));
  let own = Box::new(BooleanQuery::union(own_queries)) as Box<dyn Query>;
  let own_requirement = match matched {
    // Already scored by `words`.
    MatchedWords::Own => (Occur::Must, Box::new(ConstScoreQuery::new(own, 0.0)) as Box<dyn Query>),
    MatchedWords::ContextOnly => (Occur::MustNot, own),
  };
  Ok(Box::new(BooleanQuery::new(vec![(Occur::Must, words as Box<dyn Query>), own_requirement])))
}

fn lexical_schema() -> (Schema, LexicalFields) {
  let mut schema_builder = Schema::builder();
  let item_id = schema_builder.add_text_field(ITEM_ID_FIELD, STRING | STORED);
  let ordinal = schema_builder.add_u64_field(ORDINAL_FIELD, INDEXED | STORED);
  let source_kind = schema_builder.add_text_field(SOURCE_KIND_FIELD, STRING | STORED);
  let page_start = schema_builder.add_u64_field(PAGE_START_FIELD, STORED);
  let page_end = schema_builder.add_u64_field(PAGE_END_FIELD, STORED);
  let text_indexing = TextFieldIndexing::default()
    .set_tokenizer(TEXT_TOKENIZER)
    .set_index_option(IndexRecordOption::WithFreqsAndPositions);
  let text =
    schema_builder.add_text_field(TEXT_FIELD, TextOptions::default().set_indexing_options(text_indexing).set_stored());
  let context_indexing =
    TextFieldIndexing::default().set_tokenizer(TEXT_TOKENIZER).set_index_option(IndexRecordOption::WithFreqs);
  let context = schema_builder
    .add_text_field(CONTEXT_FIELD, TextOptions::default().set_indexing_options(context_indexing).set_stored());
  let schema = schema_builder.build();
  (schema, LexicalFields { item_id, ordinal, source_kind, page_start, page_end, text, context })
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
    context: schema.get_field(CONTEXT_FIELD).map_err(|e| format!("{} schema missing context: {}", index_label, e))?,
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
  if let Some(context) = &fragment.context {
    doc.add_text(fields.context, context);
  }
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
    context: doc.get_first(fields.context).and_then(|value| value.as_str()).map(str::to_owned),
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
  let written =
    crate::ai::artifact_io::atomic_write_unsynced(&metadata_path, &serde_json::to_vec_pretty(&stored)?).await;
  forget_open_index(index_dir);
  written.map_err(|e| format!("Could not write {} metadata '{}': {}", index_label, metadata_path.display(), e).into())
}

fn open_tantivy_index(index_dir: &Path, index_label: &str) -> InfuResult<Index> {
  let index = Index::open_in_dir(index_dir)
    .map_err(|e| format!("Could not open {} '{}': {}", index_label, index_dir.display(), e))?;
  // Analyzers are not stored with the index, so each opened index needs the one its schema names.
  index.tokenizers().register(TEXT_TOKENIZER, text_analyzer());
  Ok(index)
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
  let merged = writer.merge(&segment_ids).wait();
  let finished = writer.wait_merging_threads();
  // Release the replaced segments' files for deletion, and search the merged one.
  forget_open_index(index_dir);
  merged.map_err(|e| format!("Could not merge {} segments '{}': {}", index_label, index_dir.display(), e))?;
  finished.map_err(|e| format!("Could not finish {} merge '{}': {}", index_label, index_dir.display(), e))?;
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
  let merged = writer.merge(&segment_ids).wait();
  let finished = writer.wait_merging_threads();
  forget_open_index(index_dir);
  merged.map_err(|e| format!("Could not compact {} '{}': {}", index_label, index_dir.display(), e))?;
  finished.map_err(|e| format!("Could not finish {} compaction '{}': {}", index_label, index_dir.display(), e).into())
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
      context: None,
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

  #[test]
  fn natural_text_words_are_counted_as_the_index_tokenizes_them() {
    assert_eq!(natural_text_word_count("Montreal hotel, montreal HOTEL!"), 2);
    assert_eq!(natural_text_word_count(&(0..20).map(|n| format!("w{n}")).collect::<Vec<_>>().join(" ")), 12);
    assert_eq!(natural_text_word_count(" , "), 0);
    assert_eq!(natural_text_word_count("stay stays staying stayed"), 1, "words are counted after stemming");
  }

  #[tokio::test]
  async fn words_match_their_inflections_and_foreign_words_match_themselves() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    let fragment = |item_id: &str, text: &str| LexicalFragment {
      item_id: item_id.to_owned(),
      ordinal: 0,
      source_kind: "text".to_owned(),
      text: text.to_owned(),
      context: None,
      page_start: None,
      page_end: None,
    };
    let (english, german) =
      (fragment("english", "We stayed at two hotels"), fragment("german", "Gemütlichkeit im Café"));
    index
      .replace_items_fragments(&[
        ("english", std::slice::from_ref(&english)),
        ("german", std::slice::from_ref(&german)),
      ])
      .await
      .unwrap();
    let ids = |query: &'static str, min_matching_words: usize| {
      let index = index.clone();
      async move {
        let hits = index.search(query, 10, None, min_matching_words, MatchedWords::Own).await.unwrap();
        hits.into_iter().map(|hit| hit.item_id).collect::<Vec<_>>()
      }
    };
    assert_eq!(ids("staying hotel", 2).await, ["english"]);
    assert_eq!(ids("Gemütlichkeit", 1).await, ["german"]);
    assert_eq!(ids("café", 1).await, ["german"]);
    assert_eq!(index_word("Staying"), "stay");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn indexes_built_with_an_older_schema_are_removed() {
    let data_dir = temp_index_dir();
    let data_dir_str = data_dir.to_str().unwrap();
    let user_id = infusdk::util::uid::new_uid();
    let content_dir = document_fragment_lexical_index_dir(data_dir_str, &user_id).unwrap();
    let title_dir = item_title_lexical_index_dir(data_dir_str, &user_id).unwrap();
    commit_items(&TantivyDocumentFragmentIndex::new(content_dir.clone()), &["a".to_owned()]).await;
    let title_fragment = fragment("a");
    open_user_item_title_lexical_index(data_dir_str, &user_id)
      .unwrap()
      .replace_items_titles(&[("a", std::slice::from_ref(&title_fragment))])
      .await
      .unwrap();
    assert_eq!(remove_outdated_lexical_indexes(data_dir_str, &user_id).await.unwrap(), 0);

    let metadata_path = content_dir.join(DOCUMENT_FRAGMENT_LEXICAL_METADATA_FILENAME);
    let mut metadata: serde_json::Value =
      serde_json::from_str(&std::fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata["schema_version"] = serde_json::json!(1);
    std::fs::write(&metadata_path, metadata.to_string()).unwrap();
    assert_eq!(remove_outdated_lexical_indexes(data_dir_str, &user_id).await.unwrap(), 1);
    assert!(!content_dir.exists(), "the outdated content index is removed");
    assert!(title_dir.exists(), "the current title index is kept");
    let _ = std::fs::remove_dir_all(data_dir);
  }

  #[tokio::test]
  async fn natural_text_can_require_several_words() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    let fragment = |item_id: &str, text: &str| LexicalFragment {
      item_id: item_id.to_owned(),
      ordinal: 0,
      source_kind: "text".to_owned(),
      text: text.to_owned(),
      context: None,
      page_start: None,
      page_end: None,
    };
    let (one, two, three) =
      (fragment("one", "montreal"), fragment("two", "montreal hotel"), fragment("three", "montreal hotel stay"));
    let updates = [
      ("one", std::slice::from_ref(&one)),
      ("two", std::slice::from_ref(&two)),
      ("three", std::slice::from_ref(&three)),
    ];
    index.replace_items_fragments(&updates).await.unwrap();
    let matching = |min_matching_words: usize| {
      let index = index.clone();
      async move {
        let mut ids = index
          .search("montreal hotel stay unknownword", 10, None, min_matching_words, MatchedWords::Own)
          .await
          .unwrap();
        ids.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        ids.into_iter().map(|hit| hit.item_id).collect::<Vec<_>>()
      }
    };
    assert_eq!(matching(1).await, ["one", "three", "two"]);
    assert_eq!(matching(2).await, ["three", "two"]);
    assert_eq!(matching(3).await, ["three"]);
    assert!(matching(4).await.is_empty(), "a word no document contains cannot count");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn context_words_count_toward_a_match_but_cannot_make_one_alone() {
    let dir = temp_index_dir();
    let index = TantivyItemTitleIndex::new(dir.clone());
    let title = |item_id: &str, text: &str, context: Option<&str>| LexicalFragment {
      item_id: item_id.to_owned(),
      ordinal: 1,
      source_kind: "item_title".to_owned(),
      text: text.to_owned(),
      context: context.map(str::to_owned),
      page_start: None,
      page_end: None,
    };
    let titles = [
      title("page", "Malaysia", Some("Trips")),
      title("cocktails", "Cocktails", Some("Malaysia")),
      title("hotel", "Hotel", Some("Malaysia")),
      title("elsewhere", "Cocktails", None),
    ];
    let updates = titles.iter().map(|title| (title.item_id.as_str(), std::slice::from_ref(title))).collect::<Vec<_>>();
    index.replace_items_titles(&updates).await.unwrap();
    let ids = |query: &'static str, min_matching_words: usize, matched: MatchedWords| {
      let index = index.clone();
      async move {
        let mut ids = index.search(query, 10, None, min_matching_words, matched).await.unwrap();
        ids.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        ids.into_iter().map(|hit| hit.item_id).collect::<Vec<_>>()
      }
    };
    assert_eq!(ids("malaysia", 1, MatchedWords::Own).await, ["page"]);
    assert_eq!(ids("malaysia", 1, MatchedWords::ContextOnly).await, ["cocktails", "hotel"]);
    assert_eq!(ids("malaysia cocktails", 2, MatchedWords::Own).await, ["cocktails"], "context completes a match");
    assert_eq!(ids("malaysia cocktails", 1, MatchedWords::Own).await, ["cocktails", "elsewhere", "page"]);
    assert_eq!(ids("trips", 1, MatchedWords::ContextOnly).await, ["page"]);
    assert_eq!(
      index.stored_titles_for_items(&["cocktails".to_owned()]).await.unwrap()["cocktails"],
      vec![titles[1].clone()],
      "the context is stored, so unchanged titles are recognized"
    );
    let _ = std::fs::remove_dir_all(dir);
  }

  #[tokio::test]
  async fn cached_search_sees_later_commits_and_removals() {
    let dir = temp_index_dir();
    let index = TantivyDocumentFragmentIndex::new(dir.clone());
    let search = |index: TantivyDocumentFragmentIndex| async move {
      let mut ids = index
        .search("zebra", 10, None, 1, MatchedWords::Own)
        .await
        .unwrap()
        .into_iter()
        .map(|hit| hit.item_id)
        .collect::<Vec<_>>();
      ids.sort();
      ids
    };
    commit_items(&index, &["a".to_owned()]).await;
    assert_eq!(search(index.clone()).await, vec!["a"]);
    commit_items(&index, &["b".to_owned()]).await;
    assert_eq!(search(index.clone()).await, vec!["a", "b"]);
    index.replace_items_fragments(&[("a", &[])]).await.unwrap();
    assert_eq!(search(index.clone()).await, vec!["b"]);
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
      context: None,
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
