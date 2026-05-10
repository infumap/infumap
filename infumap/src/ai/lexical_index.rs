use std::path::{Path, PathBuf};

use infusdk::util::infu::InfuResult;
use serde::{Deserialize, Serialize};
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{QueryParser, TermQuery};
use tantivy::schema::{Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TEXT, Value};
use tantivy::{Index, IndexWriter, TantivyDocument, Term};
use tokio::fs;

use crate::ai::vector_db::user_index_dir;
use crate::util::fs::{expand_tilde, path_exists};

pub const PDF_FRAGMENT_LEXICAL_INDEX_DIR_NAME: &str = "pdf_fragments_tantivy";
pub const PDF_FRAGMENT_LEXICAL_INDEX_TEMP_DIR_NAME: &str = "pdf_fragments_tantivy.tmp";
pub const PDF_FRAGMENT_LEXICAL_METADATA_FILENAME: &str = "infumap_pdf_fragment_index.json";
pub const PDF_FRAGMENT_LEXICAL_SCHEMA_VERSION: u32 = 1;

const ITEM_ID_FIELD: &str = "item_id";
const ORDINAL_FIELD: &str = "ordinal";
const SOURCE_KIND_FIELD: &str = "source_kind";
const PAGE_START_FIELD: &str = "page_start";
const PAGE_END_FIELD: &str = "page_end";
const TEXT_FIELD: &str = "text";
const INDEX_WRITER_HEAP_BYTES: usize = 50_000_000;

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

#[derive(Clone, Copy)]
struct PdfFragmentFields {
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
    if !path_exists(&self.index_dir).await {
      return Ok(None);
    }
    let metadata_path = lexical_metadata_path(&self.index_dir);
    let metadata = match fs::read_to_string(&metadata_path).await {
      Ok(contents) => serde_json::from_str::<StoredLexicalIndexMetadata>(&contents)
        .map_err(|e| format!("Could not parse PDF fragment lexical metadata '{}': {}", metadata_path.display(), e))?,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(e) => {
        return Err(
          format!("Could not read PDF fragment lexical metadata '{}': {}", metadata_path.display(), e).into(),
        );
      }
    };

    let indexed_fragment_count = match open_tantivy_index(&self.index_dir) {
      Ok(index) => index_doc_count(&index)?,
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

  pub async fn rebuild_from_fragments(
    &self,
    temp_index_dir: &Path,
    metadata: &FragmentLexicalIndexRebuildMetadata,
    fragments: &[LexicalFragment],
  ) -> InfuResult<FragmentLexicalIndexRebuildStatus> {
    if metadata.expected_fragment_count != fragments.len() {
      return Err(
        format!(
          "Cannot rebuild PDF fragment lexical index '{}': metadata expects {} fragment(s), got {}.",
          self.index_dir.display(),
          metadata.expected_fragment_count,
          fragments.len()
        )
        .into(),
      );
    }

    remove_path_if_exists(temp_index_dir).await?;
    if let Some(parent) = temp_index_dir.parent() {
      fs::create_dir_all(parent).await.map_err(|e| {
        format!("Could not create PDF fragment lexical temp parent directory '{}': {}", parent.display(), e)
      })?;
    }
    fs::create_dir_all(temp_index_dir).await.map_err(|e| {
      format!("Could not create PDF fragment lexical temp directory '{}': {}", temp_index_dir.display(), e)
    })?;

    let (schema, fields) = pdf_fragment_schema();
    let index = Index::create_in_dir(temp_index_dir, schema)
      .map_err(|e| format!("Could not create PDF fragment lexical index '{}': {}", temp_index_dir.display(), e))?;
    let mut writer: IndexWriter<TantivyDocument> = index.writer(INDEX_WRITER_HEAP_BYTES).map_err(|e| {
      format!("Could not create PDF fragment lexical index writer '{}': {}", temp_index_dir.display(), e)
    })?;

    for fragment in fragments {
      writer.add_document(tantivy_document_for_fragment(fields, fragment)).map_err(|e| {
        format!(
          "Could not add PDF fragment '{}:{}' to lexical index '{}': {}",
          fragment.item_id,
          fragment.ordinal,
          temp_index_dir.display(),
          e
        )
      })?;
    }
    writer
      .commit()
      .map_err(|e| format!("Could not commit PDF fragment lexical index '{}': {}", temp_index_dir.display(), e))?;

    write_stored_metadata(temp_index_dir, metadata, true).await?;

    remove_path_if_exists(&self.index_dir).await?;
    fs::rename(temp_index_dir, &self.index_dir).await.map_err(|e| {
      format!(
        "Could not atomically replace PDF fragment lexical index '{}' with '{}': {}",
        self.index_dir.display(),
        temp_index_dir.display(),
        e
      )
    })?;

    self.rebuild_status().await?.ok_or_else(|| {
      format!("PDF fragment lexical index '{}' is missing metadata after rebuild.", self.index_dir.display()).into()
    })
  }

  pub async fn delete_item_fragments(&self, item_id: &str) -> InfuResult<usize> {
    if item_id.trim().is_empty() || !path_exists(&self.index_dir).await {
      return Ok(0);
    }

    let index = match open_tantivy_index(&self.index_dir) {
      Ok(index) => index,
      Err(_) => return Ok(0),
    };
    let schema = index.schema();
    let fields = fields_from_schema(&schema)?;
    let term = Term::from_field_text(fields.item_id, item_id);
    let query = TermQuery::new(term.clone(), IndexRecordOption::Basic);
    let reader = index
      .reader()
      .map_err(|e| format!("Could not open PDF fragment lexical reader '{}': {}", self.index_dir.display(), e))?;
    let deleted_count = reader.searcher().search(&query, &Count).map_err(|e| {
      format!("Could not count PDF lexical fragments for item '{}' in '{}': {}", item_id, self.index_dir.display(), e)
    })?;
    if deleted_count == 0 {
      return Ok(0);
    }

    let mut writer: IndexWriter<TantivyDocument> = index
      .writer(INDEX_WRITER_HEAP_BYTES)
      .map_err(|e| format!("Could not open PDF fragment lexical writer '{}': {}", self.index_dir.display(), e))?;
    writer.delete_term(term);
    writer
      .commit()
      .map_err(|e| format!("Could not commit PDF fragment lexical delete '{}': {}", self.index_dir.display(), e))?;

    if let Some(mut metadata) = read_stored_metadata(&self.index_dir).await? {
      metadata.fragment_count = metadata.fragment_count.saturating_sub(deleted_count);
      write_stored_metadata(
        &self.index_dir,
        &FragmentLexicalIndexRebuildMetadata {
          source_digest: metadata.source_digest,
          expected_fragment_count: metadata.fragment_count,
        },
        metadata.complete,
      )
      .await?;
    }

    Ok(deleted_count)
  }

  pub async fn search(&self, query_text: &str, limit: usize) -> InfuResult<Vec<FragmentLexicalHit>> {
    if limit == 0 || query_text.trim().is_empty() || !path_exists(&self.index_dir).await {
      return Ok(Vec::new());
    }
    let Some(status) = self.rebuild_status().await? else {
      return Ok(Vec::new());
    };
    if !status.complete {
      return Ok(Vec::new());
    }

    let index = open_tantivy_index(&self.index_dir)?;
    let schema = index.schema();
    let fields = fields_from_schema(&schema)?;
    let reader = index
      .reader()
      .map_err(|e| format!("Could not open PDF fragment lexical reader '{}': {}", self.index_dir.display(), e))?;
    let searcher = reader.searcher();
    let mut query_parser = QueryParser::for_index(&index, vec![fields.text]);
    query_parser.set_conjunction_by_default();
    let (query, parse_errors) = query_parser.parse_query_lenient(query_text);
    if parse_errors.len() > 0 {
      log::debug!("PDF fragment lexical query '{}' had {} lenient parser issue(s).", query_text, parse_errors.len());
    }

    let top_docs = searcher
      .search(&query, &TopDocs::with_limit(limit).order_by_score())
      .map_err(|e| format!("Could not search PDF fragment lexical index '{}': {}", self.index_dir.display(), e))?;
    let mut hits = Vec::new();
    for (score, doc_address) in top_docs {
      let doc = searcher
        .doc::<TantivyDocument>(doc_address)
        .map_err(|e| format!("Could not read PDF fragment lexical document '{}': {}", self.index_dir.display(), e))?;
      hits.push(hit_from_document(fields, score, &doc)?);
    }
    Ok(hits)
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

pub async fn user_pdf_fragment_lexical_index_exists(data_dir: &str, user_id: &str) -> InfuResult<bool> {
  let path = pdf_fragment_lexical_index_dir(data_dir, user_id)?;
  match fs::metadata(&path).await {
    Ok(metadata) => Ok(metadata.is_dir()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not inspect PDF fragment lexical index '{}': {}", path.display(), e).into()),
  }
}

pub fn open_user_pdf_fragment_lexical_index(data_dir: &str, user_id: &str) -> InfuResult<TantivyPdfFragmentIndex> {
  Ok(TantivyPdfFragmentIndex::new(pdf_fragment_lexical_index_dir(data_dir, user_id)?))
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

fn pdf_fragment_schema() -> (Schema, PdfFragmentFields) {
  let mut schema_builder = Schema::builder();
  let item_id = schema_builder.add_text_field(ITEM_ID_FIELD, STRING | STORED);
  let ordinal = schema_builder.add_u64_field(ORDINAL_FIELD, INDEXED | STORED);
  let source_kind = schema_builder.add_text_field(SOURCE_KIND_FIELD, STRING | STORED);
  let page_start = schema_builder.add_u64_field(PAGE_START_FIELD, STORED);
  let page_end = schema_builder.add_u64_field(PAGE_END_FIELD, STORED);
  let text = schema_builder.add_text_field(TEXT_FIELD, TEXT | STORED);
  let schema = schema_builder.build();
  (schema, PdfFragmentFields { item_id, ordinal, source_kind, page_start, page_end, text })
}

fn fields_from_schema(schema: &Schema) -> InfuResult<PdfFragmentFields> {
  Ok(PdfFragmentFields {
    item_id: schema.get_field(ITEM_ID_FIELD).map_err(|e| format!("PDF lexical schema missing item_id: {}", e))?,
    ordinal: schema.get_field(ORDINAL_FIELD).map_err(|e| format!("PDF lexical schema missing ordinal: {}", e))?,
    source_kind: schema
      .get_field(SOURCE_KIND_FIELD)
      .map_err(|e| format!("PDF lexical schema missing source_kind: {}", e))?,
    page_start: schema
      .get_field(PAGE_START_FIELD)
      .map_err(|e| format!("PDF lexical schema missing page_start: {}", e))?,
    page_end: schema.get_field(PAGE_END_FIELD).map_err(|e| format!("PDF lexical schema missing page_end: {}", e))?,
    text: schema.get_field(TEXT_FIELD).map_err(|e| format!("PDF lexical schema missing text: {}", e))?,
  })
}

fn tantivy_document_for_fragment(fields: PdfFragmentFields, fragment: &LexicalFragment) -> TantivyDocument {
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

fn hit_from_document(fields: PdfFragmentFields, score: f32, doc: &TantivyDocument) -> InfuResult<FragmentLexicalHit> {
  Ok(FragmentLexicalHit {
    item_id: required_text_field(doc, fields.item_id, ITEM_ID_FIELD)?.to_owned(),
    ordinal: required_usize_field(doc, fields.ordinal, ORDINAL_FIELD)?,
    source_kind: required_text_field(doc, fields.source_kind, SOURCE_KIND_FIELD)?.to_owned(),
    score,
    text: required_text_field(doc, fields.text, TEXT_FIELD)?.to_owned(),
    page_start: optional_usize_field(doc, fields.page_start, PAGE_START_FIELD)?,
    page_end: optional_usize_field(doc, fields.page_end, PAGE_END_FIELD)?,
  })
}

fn required_text_field<'a>(doc: &'a TantivyDocument, field: Field, field_name: &str) -> InfuResult<&'a str> {
  doc
    .get_first(field)
    .and_then(|value| value.as_str())
    .ok_or_else(|| format!("PDF lexical hit missing text field '{}'.", field_name).into())
}

fn required_usize_field(doc: &TantivyDocument, field: Field, field_name: &str) -> InfuResult<usize> {
  optional_usize_field(doc, field, field_name)?
    .ok_or_else(|| format!("PDF lexical hit missing integer field '{}'.", field_name).into())
}

fn optional_usize_field(doc: &TantivyDocument, field: Field, field_name: &str) -> InfuResult<Option<usize>> {
  doc
    .get_first(field)
    .map(|value| {
      value
        .as_u64()
        .ok_or_else(|| format!("PDF lexical hit field '{}' was not an unsigned integer.", field_name).into())
        .and_then(|value| usize::try_from(value).map_err(|e| e.into()))
    })
    .transpose()
}

fn lexical_metadata_path(index_dir: &Path) -> PathBuf {
  index_dir.join(PDF_FRAGMENT_LEXICAL_METADATA_FILENAME)
}

async fn read_stored_metadata(index_dir: &Path) -> InfuResult<Option<StoredLexicalIndexMetadata>> {
  let metadata_path = lexical_metadata_path(index_dir);
  match fs::read_to_string(&metadata_path).await {
    Ok(contents) => serde_json::from_str(&contents).map(Some).map_err(|e| {
      format!("Could not parse PDF fragment lexical metadata '{}': {}", metadata_path.display(), e).into()
    }),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read PDF fragment lexical metadata '{}': {}", metadata_path.display(), e).into()),
  }
}

async fn write_stored_metadata(
  index_dir: &Path,
  metadata: &FragmentLexicalIndexRebuildMetadata,
  complete: bool,
) -> InfuResult<()> {
  let stored = StoredLexicalIndexMetadata {
    schema_version: PDF_FRAGMENT_LEXICAL_SCHEMA_VERSION,
    source_digest: metadata.source_digest.clone(),
    fragment_count: metadata.expected_fragment_count,
    complete,
  };
  let metadata_path = lexical_metadata_path(index_dir);
  fs::write(&metadata_path, serde_json::to_vec_pretty(&stored)?)
    .await
    .map_err(|e| format!("Could not write PDF fragment lexical metadata '{}': {}", metadata_path.display(), e).into())
}

fn open_tantivy_index(index_dir: &Path) -> InfuResult<Index> {
  Index::open_in_dir(index_dir)
    .map_err(|e| format!("Could not open PDF fragment lexical index '{}': {}", index_dir.display(), e).into())
}

fn index_doc_count(index: &Index) -> InfuResult<usize> {
  let reader = index.reader().map_err(|e| format!("Could not open PDF fragment lexical reader: {}", e))?;
  usize::try_from(reader.searcher().num_docs()).map_err(|e| e.into())
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
