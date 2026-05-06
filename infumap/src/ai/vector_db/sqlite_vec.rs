#![allow(dead_code)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use zerocopy::IntoBytes;

use super::{
  EmbeddedFragment, FragmentVectorDb, FragmentVectorDbFragmentKey, FragmentVectorDbRebuildMetadata,
  FragmentVectorDbRebuildStatus, FragmentVectorHit,
};

pub const SQLITE_VEC_INDEX_SCHEMA_VERSION: i64 = 1;
pub const INDEX_METADATA_TABLE_NAME: &str = "fragment_index_metadata";
pub const FRAGMENTS_TABLE_NAME: &str = "fragments";
pub const FRAGMENT_EMBEDDINGS_TABLE_NAME: &str = "fragment_embeddings";
pub const FRAGMENT_EMBEDDING_COLUMN_NAME: &str = "embedding";

pub const CREATE_INDEX_METADATA_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS fragment_index_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  fragment_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  complete INTEGER NOT NULL
)
"#;

pub const CREATE_FRAGMENTS_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS fragments (
  fragment_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  text_sha256 TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(item_id, ordinal)
)
"#;

pub const CREATE_FRAGMENTS_ITEM_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_fragments_item_id ON fragments(item_id)
"#;

pub const INSERT_FRAGMENT_SQL: &str = r#"
INSERT INTO fragments (
  item_id,
  ordinal,
  source_kind,
  page_start,
  page_end,
  text_sha256,
  text
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
"#;

pub const INSERT_FRAGMENT_EMBEDDING_SQL: &str = r#"
INSERT INTO fragment_embeddings(rowid, embedding) VALUES (?1, ?2)
"#;

pub const INSERT_REBUILD_METADATA_SQL: &str = r#"
INSERT OR REPLACE INTO fragment_index_metadata (
  id,
  schema_version,
  source_digest,
  fragment_count,
  model,
  embedding_dimensions,
  complete
) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
"#;

pub const UPDATE_REBUILD_COMPLETE_SQL: &str = r#"
UPDATE fragment_index_metadata SET complete = ?1 WHERE id = 1
"#;

pub const READ_REBUILD_METADATA_SQL: &str = r#"
SELECT source_digest, fragment_count, model, embedding_dimensions, complete
FROM fragment_index_metadata
WHERE id = 1
"#;

pub const SELECT_FRAGMENT_KEYS_SQL: &str = r#"
SELECT item_id, ordinal, text_sha256
FROM fragments
"#;

pub const COUNT_FRAGMENT_ROWS_SQL: &str = "SELECT COUNT(*) FROM fragments";
pub const COUNT_FRAGMENT_EMBEDDING_ROWS_SQL: &str = "SELECT COUNT(*) FROM fragment_embeddings";

pub const SEARCH_FRAGMENTS_SQL: &str = r#"
SELECT
  fragments.item_id,
  fragments.ordinal,
  fragments.source_kind,
  fragment_embeddings.distance,
  fragments.text,
  fragments.page_start,
  fragments.page_end
FROM fragment_embeddings
JOIN fragments ON fragments.fragment_id = fragment_embeddings.rowid
WHERE fragment_embeddings.embedding MATCH ?1
  AND k = ?2
ORDER BY fragment_embeddings.distance
"#;

pub const DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL: &str = "DROP TABLE IF EXISTS fragment_embeddings";
pub const DROP_FRAGMENTS_TABLE_SQL: &str = "DROP TABLE IF EXISTS fragments";
pub const DROP_INDEX_METADATA_TABLE_SQL: &str = "DROP TABLE IF EXISTS fragment_index_metadata";

#[derive(Clone, Debug)]
pub struct SqliteVecFragmentVectorDb {
  db_path: PathBuf,
}

impl SqliteVecFragmentVectorDb {
  pub fn new(db_path: PathBuf) -> SqliteVecFragmentVectorDb {
    SqliteVecFragmentVectorDb { db_path }
  }

  pub fn db_path(&self) -> &Path {
    &self.db_path
  }

  pub fn create_schema_sql(embedding_dimensions: usize) -> InfuResult<Vec<String>> {
    Ok(vec![
      CREATE_INDEX_METADATA_TABLE_SQL.trim().to_owned(),
      CREATE_FRAGMENTS_TABLE_SQL.trim().to_owned(),
      CREATE_FRAGMENTS_ITEM_INDEX_SQL.trim().to_owned(),
      create_fragment_embeddings_table_sql(embedding_dimensions)?,
    ])
  }

  pub fn drop_schema_sql() -> Vec<&'static str> {
    vec![DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL, DROP_FRAGMENTS_TABLE_SQL, DROP_INDEX_METADATA_TABLE_SQL]
  }

  fn open_connection(&self) -> InfuResult<Connection> {
    register_sqlite_vec_extension()?;
    Connection::open(&self.db_path)
      .map_err(|e| format!("Could not open sqlite-vec database '{}': {}", self.db_path.display(), e).into())
  }

  fn read_rebuild_status(&self, conn: &Connection) -> InfuResult<Option<FragmentVectorDbRebuildStatus>> {
    if !table_exists(conn, INDEX_METADATA_TABLE_NAME)? {
      return Ok(None);
    }

    let metadata = conn
      .query_row(READ_REBUILD_METADATA_SQL, [], |row| {
        Ok(StoredRebuildMetadata {
          source_digest: row.get(0)?,
          expected_fragment_count: row.get(1)?,
          model: row.get(2)?,
          embedding_dimensions: row.get(3)?,
          complete: row.get::<_, i64>(4)? != 0,
        })
      })
      .optional()
      .map_err(|e| format!("Could not read sqlite-vec rebuild metadata '{}': {}", self.db_path.display(), e))?;

    let Some(metadata) = metadata else {
      return Ok(None);
    };

    let expected_fragment_count = i64_to_usize(metadata.expected_fragment_count, "fragment_count")?;
    let embedding_dimensions = i64_to_usize(metadata.embedding_dimensions, "embedding_dimensions")?;
    let embedded_fragment_count = count_table_rows(conn, FRAGMENTS_TABLE_NAME, COUNT_FRAGMENT_ROWS_SQL)?;
    let embedding_row_count =
      count_table_rows(conn, FRAGMENT_EMBEDDINGS_TABLE_NAME, COUNT_FRAGMENT_EMBEDDING_ROWS_SQL)?;

    Ok(Some(FragmentVectorDbRebuildStatus {
      source_digest: metadata.source_digest,
      expected_fragment_count,
      model: metadata.model,
      embedding_dimensions,
      embedded_fragment_count,
      embedding_row_count,
      complete: metadata.complete,
    }))
  }

  fn validate_rebuild_metadata(
    &self,
    status: &FragmentVectorDbRebuildStatus,
    metadata: &FragmentVectorDbRebuildMetadata,
  ) -> InfuResult<()> {
    if status.source_digest != metadata.source_digest {
      return Err(
        format!(
          "Cannot continue sqlite-vec rebuild '{}': source digest differs (temp DB {}, current {}). Run without --continue to start a fresh rebuild.",
          self.db_path.display(),
          status.source_digest,
          metadata.source_digest
        )
        .into(),
      );
    }
    if status.expected_fragment_count != metadata.expected_fragment_count {
      return Err(
        format!(
          "Cannot continue sqlite-vec rebuild '{}': expected fragment count differs (temp DB {}, current {}). Run without --continue to start a fresh rebuild.",
          self.db_path.display(),
          status.expected_fragment_count,
          metadata.expected_fragment_count
        )
        .into(),
      );
    }
    if status.model != metadata.model {
      return Err(
        format!(
          "Cannot continue sqlite-vec rebuild '{}': embedding model differs (temp DB '{}', current '{}'). Run without --continue to start a fresh rebuild.",
          self.db_path.display(),
          status.model,
          metadata.model
        )
        .into(),
      );
    }
    if status.embedding_dimensions != metadata.embedding_dimensions {
      return Err(
        format!(
          "Cannot continue sqlite-vec rebuild '{}': embedding dimensions differ (temp DB {}, current {}). Run without --continue to start a fresh rebuild.",
          self.db_path.display(),
          status.embedding_dimensions,
          metadata.embedding_dimensions
        )
        .into(),
      );
    }
    Ok(())
  }
}

struct StoredRebuildMetadata {
  source_digest: String,
  expected_fragment_count: i64,
  model: String,
  embedding_dimensions: i64,
  complete: bool,
}

pub fn create_fragment_embeddings_table_sql(embedding_dimensions: usize) -> InfuResult<String> {
  if embedding_dimensions == 0 {
    return Err("Fragment embedding dimensions must be greater than zero.".into());
  }
  Ok(format!(
    "CREATE VIRTUAL TABLE IF NOT EXISTS {} USING vec0({} float[{}] distance_metric=cosine)",
    FRAGMENT_EMBEDDINGS_TABLE_NAME, FRAGMENT_EMBEDDING_COLUMN_NAME, embedding_dimensions
  ))
}

pub fn fragment_text_sha256(text: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  format!("{:x}", hasher.finalize())
}

fn register_sqlite_vec_extension() -> InfuResult<()> {
  static REGISTER_RESULT: OnceLock<i32> = OnceLock::new();
  let rc = *REGISTER_RESULT.get_or_init(|| unsafe {
    rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(::sqlite_vec::sqlite3_vec_init as *const ())))
  });
  if rc == rusqlite::ffi::SQLITE_OK {
    Ok(())
  } else {
    Err(format!("Could not register sqlite-vec extension: sqlite rc {}", rc).into())
  }
}

fn table_exists(conn: &Connection, table_name: &str) -> InfuResult<bool> {
  let count: i64 = conn
    .query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1", params![table_name], |row| {
      row.get(0)
    })
    .map_err(|e| format!("Could not inspect sqlite schema for table '{}': {}", table_name, e))?;
  Ok(count > 0)
}

fn count_table_rows(conn: &Connection, table_name: &str, sql: &str) -> InfuResult<usize> {
  if !table_exists(conn, table_name)? {
    return Ok(0);
  }
  let count: i64 = conn
    .query_row(sql, [], |row| row.get(0))
    .map_err(|e| format!("Could not count sqlite rows in '{}': {}", table_name, e))?;
  i64_to_usize(count, table_name)
}

fn usize_to_i64(value: usize, field_name: &str) -> InfuResult<i64> {
  i64::try_from(value).map_err(|_| format!("{} value {} does not fit in sqlite INTEGER.", field_name, value).into())
}

fn i64_to_usize(value: i64, field_name: &str) -> InfuResult<usize> {
  usize::try_from(value)
    .map_err(|_| format!("{} sqlite INTEGER value {} is negative or too large.", field_name, value).into())
}

fn optional_usize_to_i64(value: Option<usize>, field_name: &str) -> InfuResult<Option<i64>> {
  value.map(|v| usize_to_i64(v, field_name)).transpose()
}

#[async_trait]
impl FragmentVectorDb for SqliteVecFragmentVectorDb {
  async fn rebuild_status(&self) -> InfuResult<Option<FragmentVectorDbRebuildStatus>> {
    if !self.db_path.exists() {
      return Ok(None);
    }
    let conn = self.open_connection()?;
    self.read_rebuild_status(&conn)
  }

  async fn begin_rebuild(
    &self,
    metadata: &FragmentVectorDbRebuildMetadata,
    resume: bool,
  ) -> InfuResult<FragmentVectorDbRebuildStatus> {
    if metadata.expected_fragment_count == 0 {
      return Err("Cannot create a sqlite-vec fragment index with zero fragments.".into());
    }
    if metadata.model.trim().is_empty() {
      return Err("Cannot create a sqlite-vec fragment index without an embedding model name.".into());
    }
    if metadata.embedding_dimensions == 0 {
      return Err("Cannot create a sqlite-vec fragment index with zero embedding dimensions.".into());
    }

    if !resume && self.db_path.exists() {
      tokio::fs::remove_file(&self.db_path).await.map_err(|e| {
        format!("Could not remove existing sqlite-vec rebuild database '{}': {}", self.db_path.display(), e)
      })?;
    }

    if let Some(parent) = self.db_path.parent() {
      tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("Could not create sqlite-vec rebuild directory '{}': {}", parent.display(), e))?;
    }

    let conn = self.open_connection()?;

    if resume {
      let status = self.read_rebuild_status(&conn)?.ok_or_else(|| {
        format!("Cannot continue sqlite-vec rebuild '{}': metadata is missing.", self.db_path.display())
      })?;
      self.validate_rebuild_metadata(&status, metadata)?;
      return Ok(status);
    }

    for sql in Self::create_schema_sql(metadata.embedding_dimensions)? {
      conn
        .execute_batch(&sql)
        .map_err(|e| format!("Could not create sqlite-vec rebuild schema '{}': {}", self.db_path.display(), e))?;
    }
    conn
      .execute(
        INSERT_REBUILD_METADATA_SQL,
        params![
          SQLITE_VEC_INDEX_SCHEMA_VERSION,
          metadata.source_digest,
          usize_to_i64(metadata.expected_fragment_count, "fragment_count")?,
          metadata.model,
          usize_to_i64(metadata.embedding_dimensions, "embedding_dimensions")?,
          0_i64,
        ],
      )
      .map_err(|e| format!("Could not write sqlite-vec rebuild metadata '{}': {}", self.db_path.display(), e))?;

    self.read_rebuild_status(&conn)?.ok_or_else(|| {
      format!("Could not read sqlite-vec rebuild status after initialization '{}'.", self.db_path.display()).into()
    })
  }

  async fn embedded_fragment_keys(&self) -> InfuResult<HashSet<FragmentVectorDbFragmentKey>> {
    if !self.db_path.exists() {
      return Ok(HashSet::new());
    }
    let conn = self.open_connection()?;
    if !table_exists(&conn, FRAGMENTS_TABLE_NAME)? {
      return Ok(HashSet::new());
    }

    let mut stmt = conn
      .prepare(SELECT_FRAGMENT_KEYS_SQL)
      .map_err(|e| format!("Could not prepare sqlite-vec fragment key query '{}': {}", self.db_path.display(), e))?;
    let mut rows = stmt
      .query([])
      .map_err(|e| format!("Could not query sqlite-vec fragment keys '{}': {}", self.db_path.display(), e))?;
    let mut keys = HashSet::new();
    while let Some(row) = rows
      .next()
      .map_err(|e| format!("Could not read sqlite-vec fragment key row '{}': {}", self.db_path.display(), e))?
    {
      let ordinal: i64 = row
        .get(1)
        .map_err(|e| format!("Could not read sqlite-vec fragment ordinal '{}': {}", self.db_path.display(), e))?;
      keys.insert(FragmentVectorDbFragmentKey {
        item_id: row
          .get(0)
          .map_err(|e| format!("Could not read sqlite-vec fragment item id '{}': {}", self.db_path.display(), e))?,
        ordinal: i64_to_usize(ordinal, "ordinal")?,
        text_sha256: row
          .get(2)
          .map_err(|e| format!("Could not read sqlite-vec fragment text hash '{}': {}", self.db_path.display(), e))?,
      });
    }
    Ok(keys)
  }

  async fn insert_embedded_fragments(&self, fragments: &[EmbeddedFragment]) -> InfuResult<()> {
    if fragments.is_empty() {
      return Ok(());
    }

    let mut conn = self.open_connection()?;
    let status = self.read_rebuild_status(&conn)?.ok_or_else(|| {
      format!("Cannot insert sqlite-vec fragments into '{}': rebuild metadata is missing.", self.db_path.display())
    })?;

    let tx = conn
      .transaction()
      .map_err(|e| format!("Could not start sqlite-vec insert transaction '{}': {}", self.db_path.display(), e))?;
    for fragment in fragments {
      if fragment.embedding.len() != status.embedding_dimensions {
        return Err(
          format!(
            "Fragment '{}:{}' has embedding dimensions {}, expected {}.",
            fragment.item_id,
            fragment.ordinal,
            fragment.embedding.len(),
            status.embedding_dimensions
          )
          .into(),
        );
      }
      tx.execute(
        INSERT_FRAGMENT_SQL,
        params![
          fragment.item_id,
          usize_to_i64(fragment.ordinal, "ordinal")?,
          fragment.source_kind,
          optional_usize_to_i64(fragment.page_start, "page_start")?,
          optional_usize_to_i64(fragment.page_end, "page_end")?,
          fragment_text_sha256(&fragment.text),
          fragment.text,
        ],
      )
      .map_err(|e| {
        format!(
          "Could not insert sqlite-vec fragment '{}:{}' into '{}': {}",
          fragment.item_id,
          fragment.ordinal,
          self.db_path.display(),
          e
        )
      })?;
      let fragment_id = tx.last_insert_rowid();
      tx.execute(INSERT_FRAGMENT_EMBEDDING_SQL, params![fragment_id, fragment.embedding.as_bytes()]).map_err(|e| {
        format!(
          "Could not insert sqlite-vec embedding for fragment '{}:{}' into '{}': {}",
          fragment.item_id,
          fragment.ordinal,
          self.db_path.display(),
          e
        )
      })?;
    }
    tx.commit()
      .map_err(|e| format!("Could not commit sqlite-vec insert transaction '{}': {}", self.db_path.display(), e))?;
    Ok(())
  }

  async fn finish_rebuild(
    &self,
    metadata: &FragmentVectorDbRebuildMetadata,
  ) -> InfuResult<FragmentVectorDbRebuildStatus> {
    let conn = self.open_connection()?;
    let status = self
      .read_rebuild_status(&conn)?
      .ok_or_else(|| format!("Cannot finish sqlite-vec rebuild '{}': metadata is missing.", self.db_path.display()))?;
    self.validate_rebuild_metadata(&status, metadata)?;
    if status.embedded_fragment_count != metadata.expected_fragment_count {
      return Err(
        format!(
          "Cannot finish sqlite-vec rebuild '{}': inserted {} fragment row(s), expected {}.",
          self.db_path.display(),
          status.embedded_fragment_count,
          metadata.expected_fragment_count
        )
        .into(),
      );
    }
    if status.embedding_row_count != metadata.expected_fragment_count {
      return Err(
        format!(
          "Cannot finish sqlite-vec rebuild '{}': inserted {} embedding row(s), expected {}.",
          self.db_path.display(),
          status.embedding_row_count,
          metadata.expected_fragment_count
        )
        .into(),
      );
    }
    conn
      .execute(UPDATE_REBUILD_COMPLETE_SQL, params![1_i64])
      .map_err(|e| format!("Could not mark sqlite-vec rebuild complete '{}': {}", self.db_path.display(), e))?;
    self.read_rebuild_status(&conn)?.ok_or_else(|| {
      format!("Could not read sqlite-vec rebuild status after completion '{}'.", self.db_path.display()).into()
    })
  }

  async fn search(&self, query_embedding: &[f32], limit: usize) -> InfuResult<Vec<FragmentVectorHit>> {
    if limit == 0 || !self.db_path.exists() {
      return Ok(Vec::new());
    }
    let conn = self.open_connection()?;
    let Some(status) = self.read_rebuild_status(&conn)? else {
      return Ok(Vec::new());
    };
    if !status.complete {
      return Ok(Vec::new());
    }
    if query_embedding.len() != status.embedding_dimensions {
      return Err(
        format!(
          "Query embedding has dimensions {}, but sqlite-vec fragment index '{}' has dimensions {}.",
          query_embedding.len(),
          self.db_path.display(),
          status.embedding_dimensions
        )
        .into(),
      );
    }

    let mut stmt = conn
      .prepare(SEARCH_FRAGMENTS_SQL)
      .map_err(|e| format!("Could not prepare sqlite-vec fragment search '{}': {}", self.db_path.display(), e))?;
    let mut rows = stmt
      .query(params![query_embedding.as_bytes(), usize_to_i64(limit, "limit")?])
      .map_err(|e| format!("Could not query sqlite-vec fragment search '{}': {}", self.db_path.display(), e))?;
    let mut hits = Vec::new();
    while let Some(row) = rows
      .next()
      .map_err(|e| format!("Could not read sqlite-vec fragment search row '{}': {}", self.db_path.display(), e))?
    {
      let ordinal: i64 =
        row.get(1).map_err(|e| format!("Could not read sqlite-vec hit ordinal '{}': {}", self.db_path.display(), e))?;
      let distance: f64 = row
        .get(3)
        .map_err(|e| format!("Could not read sqlite-vec hit distance '{}': {}", self.db_path.display(), e))?;
      let page_start: Option<i64> = row
        .get(5)
        .map_err(|e| format!("Could not read sqlite-vec hit page_start '{}': {}", self.db_path.display(), e))?;
      let page_end: Option<i64> = row
        .get(6)
        .map_err(|e| format!("Could not read sqlite-vec hit page_end '{}': {}", self.db_path.display(), e))?;
      hits.push(FragmentVectorHit {
        item_id: row
          .get(0)
          .map_err(|e| format!("Could not read sqlite-vec hit item id '{}': {}", self.db_path.display(), e))?,
        ordinal: i64_to_usize(ordinal, "ordinal")?,
        source_kind: row
          .get(2)
          .map_err(|e| format!("Could not read sqlite-vec hit source kind '{}': {}", self.db_path.display(), e))?,
        distance: distance as f32,
        text: row
          .get(4)
          .map_err(|e| format!("Could not read sqlite-vec hit text '{}': {}", self.db_path.display(), e))?,
        page_start: page_start.map(|v| i64_to_usize(v, "page_start")).transpose()?,
        page_end: page_end.map(|v| i64_to_usize(v, "page_end")).transpose()?,
      });
    }
    Ok(hits)
  }
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use crate::ai::vector_db::{EmbeddedFragment, FragmentVectorDb, FragmentVectorDbRebuildMetadata};

  use super::{
    CREATE_FRAGMENTS_ITEM_INDEX_SQL, CREATE_FRAGMENTS_TABLE_SQL, CREATE_INDEX_METADATA_TABLE_SQL,
    DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL, DROP_FRAGMENTS_TABLE_SQL, DROP_INDEX_METADATA_TABLE_SQL,
    FRAGMENT_EMBEDDING_COLUMN_NAME, FRAGMENT_EMBEDDINGS_TABLE_NAME, FRAGMENTS_TABLE_NAME, INDEX_METADATA_TABLE_NAME,
    INSERT_FRAGMENT_EMBEDDING_SQL, INSERT_FRAGMENT_SQL, READ_REBUILD_METADATA_SQL, SEARCH_FRAGMENTS_SQL,
    SELECT_FRAGMENT_KEYS_SQL, SqliteVecFragmentVectorDb, create_fragment_embeddings_table_sql, fragment_text_sha256,
  };

  #[test]
  fn stores_configured_db_path() {
    let db = SqliteVecFragmentVectorDb::new(PathBuf::from("/tmp/fragments.sqlite3"));
    assert_eq!(db.db_path(), PathBuf::from("/tmp/fragments.sqlite3").as_path());
  }

  #[test]
  fn creates_fragment_embeddings_table_for_dimensions() {
    let sql = create_fragment_embeddings_table_sql(768).unwrap();
    assert!(sql.contains(FRAGMENT_EMBEDDINGS_TABLE_NAME));
    assert!(sql.contains(FRAGMENT_EMBEDDING_COLUMN_NAME));
    assert!(sql.contains("float[768]"));
    assert!(sql.contains("distance_metric=cosine"));
    assert!(create_fragment_embeddings_table_sql(0).is_err());
  }

  #[test]
  fn schema_sql_creates_metadata_before_virtual_table() {
    let sql = SqliteVecFragmentVectorDb::create_schema_sql(384).unwrap();
    assert_eq!(sql.len(), 4);
    assert!(sql[0].contains("CREATE TABLE IF NOT EXISTS fragment_index_metadata"));
    assert!(sql[0].contains("embedding_dimensions INTEGER NOT NULL"));
    assert!(sql[1].contains("CREATE TABLE IF NOT EXISTS fragments"));
    assert!(sql[1].contains("source_kind TEXT NOT NULL"));
    assert!(sql[1].contains("text_sha256 TEXT NOT NULL"));
    assert!(sql[1].contains("UNIQUE(item_id, ordinal)"));
    assert_eq!(sql[2], CREATE_FRAGMENTS_ITEM_INDEX_SQL.trim());
    assert!(sql[3].contains("CREATE VIRTUAL TABLE IF NOT EXISTS fragment_embeddings"));
    assert!(sql[3].contains("float[384]"));
  }

  #[test]
  fn exposes_sql_for_rebuild_and_search() {
    assert!(CREATE_INDEX_METADATA_TABLE_SQL.contains(INDEX_METADATA_TABLE_NAME));
    assert!(CREATE_FRAGMENTS_TABLE_SQL.contains(FRAGMENTS_TABLE_NAME));
    assert!(INSERT_FRAGMENT_SQL.contains("text_sha256"));
    assert!(INSERT_FRAGMENT_EMBEDDING_SQL.contains(FRAGMENT_EMBEDDINGS_TABLE_NAME));
    assert!(READ_REBUILD_METADATA_SQL.contains(INDEX_METADATA_TABLE_NAME));
    assert!(SELECT_FRAGMENT_KEYS_SQL.contains("text_sha256"));
    assert!(SEARCH_FRAGMENTS_SQL.contains("MATCH ?1"));
    assert!(SEARCH_FRAGMENTS_SQL.contains("AND k = ?2"));
    assert!(SEARCH_FRAGMENTS_SQL.contains("JOIN fragments ON fragments.fragment_id = fragment_embeddings.rowid"));

    let drop_sql = SqliteVecFragmentVectorDb::drop_schema_sql();
    assert_eq!(
      drop_sql,
      vec![DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL, DROP_FRAGMENTS_TABLE_SQL, DROP_INDEX_METADATA_TABLE_SQL]
    );
  }

  #[test]
  fn hashes_fragment_text_for_metadata_rows() {
    assert_eq!(fragment_text_sha256("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  }

  #[tokio::test]
  async fn rebuilds_resumes_and_searches_fragments() {
    let db_path = unique_test_db_path("resume-search");
    let db = SqliteVecFragmentVectorDb::new(db_path.clone());
    let metadata = FragmentVectorDbRebuildMetadata {
      source_digest: "corpus-a".to_owned(),
      expected_fragment_count: 2,
      model: "test-model".to_owned(),
      embedding_dimensions: 2,
    };

    let status = db.begin_rebuild(&metadata, false).await.unwrap();
    assert_eq!(status.embedded_fragment_count, 0);
    assert!(!status.complete);

    db.insert_embedded_fragments(&[EmbeddedFragment {
      item_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
      ordinal: 0,
      source_kind: "page_contents".to_owned(),
      text: "alpha".to_owned(),
      page_start: None,
      page_end: None,
      embedding: vec![1.0, 0.0],
    }])
    .await
    .unwrap();

    let resumed = db.begin_rebuild(&metadata, true).await.unwrap();
    assert_eq!(resumed.embedded_fragment_count, 1);
    let keys = db.embedded_fragment_keys().await.unwrap();
    assert_eq!(keys.len(), 1);

    db.insert_embedded_fragments(&[EmbeddedFragment {
      item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
      ordinal: 0,
      source_kind: "page_contents".to_owned(),
      text: "beta".to_owned(),
      page_start: Some(2),
      page_end: Some(3),
      embedding: vec![0.0, 1.0],
    }])
    .await
    .unwrap();

    let finished = db.finish_rebuild(&metadata).await.unwrap();
    assert_eq!(finished.embedded_fragment_count, 2);
    assert_eq!(finished.embedding_row_count, 2);
    assert!(finished.complete);

    let hits = db.search(&[1.0, 0.0], 1).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].item_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(hits[0].text, "alpha");

    std::fs::remove_file(db_path).unwrap();
  }

  #[tokio::test]
  async fn resume_rejects_different_source_digest() {
    let db_path = unique_test_db_path("resume-mismatch");
    let db = SqliteVecFragmentVectorDb::new(db_path.clone());
    let metadata = FragmentVectorDbRebuildMetadata {
      source_digest: "corpus-a".to_owned(),
      expected_fragment_count: 1,
      model: "test-model".to_owned(),
      embedding_dimensions: 2,
    };
    db.begin_rebuild(&metadata, false).await.unwrap();

    let mismatch = FragmentVectorDbRebuildMetadata { source_digest: "corpus-b".to_owned(), ..metadata };
    let err = db.begin_rebuild(&mismatch, true).await.unwrap_err().to_string();
    assert!(err.contains("source digest differs"));

    std::fs::remove_file(db_path).unwrap();
  }

  fn unique_test_db_path(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("infumap-sqlite-vec-{}-{}.sqlite3", name, std::process::id()));
    if path.exists() {
      std::fs::remove_file(&path).unwrap();
    }
    path
  }
}
