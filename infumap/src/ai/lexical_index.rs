use std::path::{Path, PathBuf};

use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{QueryParser, TermQuery};
use tantivy::schema::{Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TEXT, Value};
use tantivy::{Index, IndexWriter, TantivyDocument, Term};
use tokio::fs;

use crate::ai::vector_db::user_index_dir;
use crate::util::fs::expand_tilde;

pub const PDF_FRAGMENT_LEXICAL_INDEX_DIR_NAME: &str = "pdf_fragments_tantivy";
pub const PDF_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "pdf_fragments_tantivy.tmp";
pub const PDF_FRAGMENT_LEXICAL_METADATA_FILENAME: &str = "infumap_pdf_fragment_index.json";
pub const PDF_FRAGMENT_LEXICAL_SCHEMA_VERSION: u32 = 1;
#[allow(dead_code)]
pub const ITEM_TITLE_LEXICAL_INDEX_DIR_NAME: &str = "item_titles_tantivy";
#[allow(dead_code)]
pub const ITEM_TITLE_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "item_titles_tantivy.tmp";
#[allow(dead_code)]
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
const PDF_FRAGMENT_LEXICAL_INDEX_LABEL: &str = "PDF fragment lexical index";
#[allow(dead_code)]
const ITEM_TITLE_LEXICAL_INDEX_LABEL: &str = "item title lexical index";

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
pub struct TantivyPdfFragmentIndex {
  index_dir: PathBuf,
}

#[allow(dead_code)]
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

impl TantivyPdfFragmentIndex {
  pub fn new(index_dir: PathBuf) -> TantivyPdfFragmentIndex {
    TantivyPdfFragmentIndex { index_dir }
  }

  pub async fn rebuild_status(&self) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
    rebuild_status_for_index(&self.index_dir, PDF_FRAGMENT_LEXICAL_METADATA_FILENAME, PDF_FRAGMENT_LEXICAL_INDEX_LABEL)
      .await
  }

  pub async fn rebuild_from_fragments(
    &self,
    temp_index_dir: &Path,
    metadata: &FragmentLexicalIndexRebuildMetadata,
    fragments: &[LexicalFragment],
  ) -> InfuResult<FragmentLexicalIndexRebuildStatus> {
    rebuild_fragments_into_index(
      &self.index_dir,
      temp_index_dir,
      metadata,
      fragments,
      PDF_FRAGMENT_LEXICAL_METADATA_FILENAME,
      PDF_FRAGMENT_LEXICAL_SCHEMA_VERSION,
      PDF_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn delete_item_fragments(&self, item_id: &str) -> InfuResult<usize> {
    delete_item_documents_from_index(
      &self.index_dir,
      item_id,
      PDF_FRAGMENT_LEXICAL_METADATA_FILENAME,
      PDF_FRAGMENT_LEXICAL_SCHEMA_VERSION,
      PDF_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn search(&self, query_text: &str, limit: usize) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      PDF_FRAGMENT_LEXICAL_METADATA_FILENAME,
      PDF_FRAGMENT_LEXICAL_INDEX_LABEL,
    )
    .await
  }
}

#[allow(dead_code)]
impl TantivyItemTitleIndex {
  pub fn new(index_dir: PathBuf) -> TantivyItemTitleIndex {
    TantivyItemTitleIndex { index_dir }
  }

  pub async fn rebuild_status(&self) -> InfuResult<Option<FragmentLexicalIndexRebuildStatus>> {
    rebuild_status_for_index(&self.index_dir, ITEM_TITLE_LEXICAL_METADATA_FILENAME, ITEM_TITLE_LEXICAL_INDEX_LABEL)
      .await
  }

  pub async fn rebuild_from_fragments(
    &self,
    temp_index_dir: &Path,
    metadata: &FragmentLexicalIndexRebuildMetadata,
    fragments: &[LexicalFragment],
  ) -> InfuResult<FragmentLexicalIndexRebuildStatus> {
    rebuild_fragments_into_index(
      &self.index_dir,
      temp_index_dir,
      metadata,
      fragments,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_SCHEMA_VERSION,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn delete_item_fragments(&self, item_id: &str) -> InfuResult<usize> {
    delete_item_documents_from_index(
      &self.index_dir,
      item_id,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_SCHEMA_VERSION,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    )
    .await
  }

  pub async fn search(&self, query_text: &str, limit: usize) -> InfuResult<Vec<FragmentLexicalHit>> {
    search_index(
      &self.index_dir,
      query_text,
      limit,
      ITEM_TITLE_LEXICAL_METADATA_FILENAME,
      ITEM_TITLE_LEXICAL_INDEX_LABEL,
    )
    .await
  }
}

pub fn pdf_fragment_lexical_index_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(PDF_FRAGMENT_LEXICAL_INDEX_DIR_NAME);
  Ok(path)
}

pub fn pdf_fragment_lexical_index_temp_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = user_index_dir(data_dir, user_id)?;
  path.push(PDF_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME);
  Ok(path)
}

#[allow(dead_code)]
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

pub async fn user_pdf_fragment_lexical_index_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = pdf_fragment_lexical_index_dir(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_dir()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect PDF fragment lexical index '{}': {}", path.display(), e).into()),
  }
}

#[allow(dead_code)]
pub async fn user_item_title_lexical_index_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = item_title_lexical_index_dir(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_dir()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect item title lexical index '{}': {}", path.display(), e).into()),
  }
}

pub fn open_user_pdf_fragment_lexical_index(data_dir: &str, user_id: &str) -> InfuResult<TantivyPdfFragmentIndex> {
  Ok(TantivyPdfFragmentIndex::new(pdf_fragment_lexical_index_dir(data_dir, user_id)?))
}

#[allow(dead_code)]
pub fn open_user_item_title_lexical_index(data_dir: &str, user_id: &str) -> InfuResult<TantivyItemTitleIndex> {
  Ok(TantivyItemTitleIndex::new(item_title_lexical_index_dir(data_dir, user_id)?))
}

pub async fn remove_pdf_fragment_lexical_index_dirs(data_dir: &str, user_id: &str) -> InfuResult<usize> {
  let mut removed = 0;
  if remove_path_if_exists(&pdf_fragment_lexical_index_temp_dir(data_dir, user_id)?).await? {
    removed += 1;
  }
  if remove_path_if_exists(&pdf_fragment_lexical_index_dir(data_dir, user_id)?).await? {
    removed += 1;
  }
  Ok(removed)
}

#[allow(dead_code)]
pub async fn remove_item_title_lexical_index_dirs(data_dir: &str, user_id: &str) -> InfuResult<usize> {
  let mut removed = 0;
  if remove_path_if_exists(&item_title_lexical_index_temp_dir(data_dir, user_id)?).await? {
    removed += 1;
  }
  if remove_path_if_exists(&item_title_lexical_index_dir(data_dir, user_id)?).await? {
    removed += 1;
  }
  Ok(removed)
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

async fn rebuild_fragments_into_index(
  index_dir: &Path,
  temp_index_dir: &Path,
  metadata: &FragmentLexicalIndexRebuildMetadata,
  fragments: &[LexicalFragment],
  metadata_filename: &str,
  schema_version: u32,
  index_label: &str,
) -> InfuResult<FragmentLexicalIndexRebuildStatus> {
  if metadata.expected_fragment_count != fragments.len() {
    return Err(
      format!(
        "Cannot rebuild {} '{}': metadata expects {} fragment(s), got {}.",
        index_label,
        index_dir.display(),
        metadata.expected_fragment_count,
        fragments.len()
      )
      .into(),
    );
  }

  remove_path_if_exists(temp_index_dir).await?;
  if let Some(parent) = temp_index_dir.parent() {
    fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("Could not create {} temp parent directory '{}': {}", index_label, parent.display(), e))?;
  }
  fs::create_dir_all(temp_index_dir)
    .await
    .map_err(|e| format!("Could not create {} temp directory '{}': {}", index_label, temp_index_dir.display(), e))?;

  let (schema, fields) = lexical_schema();
  let index = Index::create_in_dir(temp_index_dir, schema)
    .map_err(|e| format!("Could not create {} '{}': {}", index_label, temp_index_dir.display(), e))?;
  let mut writer: IndexWriter<TantivyDocument> = index
    .writer(INDEX_WRITER_HEAP_BYTES)
    .map_err(|e| format!("Could not create {} writer '{}': {}", index_label, temp_index_dir.display(), e))?;

  for fragment in fragments {
    writer.add_document(tantivy_document_for_fragment(fields, fragment)).map_err(|e| {
      format!(
        "Could not add lexical fragment '{}:{}' to {} '{}': {}",
        fragment.item_id,
        fragment.ordinal,
        index_label,
        temp_index_dir.display(),
        e
      )
    })?;
  }
  writer.commit().map_err(|e| format!("Could not commit {} '{}': {}", index_label, temp_index_dir.display(), e))?;

  write_stored_metadata(temp_index_dir, metadata, true, metadata_filename, schema_version, index_label).await?;

  remove_path_if_exists(index_dir).await?;
  fs::rename(temp_index_dir, index_dir).await.map_err(|e| {
    format!(
      "Could not atomically replace {} '{}' with '{}': {}",
      index_label,
      index_dir.display(),
      temp_index_dir.display(),
      e
    )
  })?;

  rebuild_status_for_index(index_dir, metadata_filename, index_label)
    .await?
    .ok_or_else(|| format!("{} '{}' is missing metadata after rebuild.", index_label, index_dir.display()).into())
}

async fn delete_item_documents_from_index(
  index_dir: &Path,
  item_id: &str,
  metadata_filename: &str,
  schema_version: u32,
  index_label: &str,
) -> InfuResult<usize> {
  if item_id.trim().is_empty() || !path_ref_exists(index_dir).await {
    return Ok(0);
  }

  let index = match open_tantivy_index(index_dir, index_label) {
    Ok(index) => index,
    Err(_) => return Ok(0),
  };
  let schema = index.schema();
  let fields = fields_from_schema(&schema, index_label)?;
  let term = Term::from_field_text(fields.item_id, item_id);
  let query = TermQuery::new(term.clone(), IndexRecordOption::Basic);
  let reader =
    index.reader().map_err(|e| format!("Could not open {} reader '{}': {}", index_label, index_dir.display(), e))?;
  let deleted_count = reader.searcher().search(&query, &Count).map_err(|e| {
    format!(
      "Could not count lexical fragments for item '{}' in {} '{}': {}",
      item_id,
      index_label,
      index_dir.display(),
      e
    )
  })?;
  if deleted_count == 0 {
    return Ok(0);
  }

  let mut writer: IndexWriter<TantivyDocument> = index
    .writer(INDEX_WRITER_HEAP_BYTES)
    .map_err(|e| format!("Could not open {} writer '{}': {}", index_label, index_dir.display(), e))?;
  writer.delete_term(term);
  writer.commit().map_err(|e| format!("Could not commit {} delete '{}': {}", index_label, index_dir.display(), e))?;

  if let Some(mut metadata) = read_stored_metadata(index_dir, metadata_filename, index_label).await? {
    metadata.fragment_count = metadata.fragment_count.saturating_sub(deleted_count);
    write_stored_metadata(
      index_dir,
      &FragmentLexicalIndexRebuildMetadata {
        source_digest: metadata.source_digest,
        expected_fragment_count: metadata.fragment_count,
      },
      metadata.complete,
      metadata_filename,
      schema_version,
      index_label,
    )
    .await?;
  }

  Ok(deleted_count)
}

async fn search_index(
  index_dir: &Path,
  query_text: &str,
  limit: usize,
  metadata_filename: &str,
  index_label: &str,
) -> InfuResult<Vec<FragmentLexicalHit>> {
  if limit == 0 || query_text.trim().is_empty() || !path_ref_exists(index_dir).await {
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
  let mut query_parser = QueryParser::for_index(&index, vec![fields.text]);
  query_parser.set_conjunction_by_default();
  let (query, parse_errors) = query_parser.parse_query_lenient(query_text);
  if parse_errors.len() > 0 {
    log::debug!("{} query '{}' had {} lenient parser issue(s).", index_label, query_text, parse_errors.len());
  }

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
  fs::write(&metadata_path, serde_json::to_vec_pretty(&stored)?)
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

async fn path_ref_exists(path: &Path) -> bool {
  fs::metadata(path).await.is_ok()
}

async fn remove_path_if_exists(path: &Path) -> InfuResult<bool> {
  let Some(path_str) = path.to_str() else {
    return Err(format!("Could not interpret path '{}'.", path.display()).into());
  };
  let Some(expanded_path) = expand_tilde(path_str) else {
    return Err(format!("Could not expand path '{}'.", path.display()).into());
  };
  match fs::metadata(&expanded_path).await {
    Ok(metadata) => {
      if metadata.is_dir() {
        fs::remove_dir_all(&expanded_path).await?;
      } else {
        fs::remove_file(&expanded_path).await?;
      }
      Ok(true)
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect '{}': {}", expanded_path.display(), e).into()),
  }
}
