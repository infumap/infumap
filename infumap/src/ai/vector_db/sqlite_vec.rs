#![allow(dead_code)]

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;
use sha2::{Digest, Sha256};

use super::{EmbeddedFragment, FragmentVectorDb, FragmentVectorHit};

pub const FRAGMENTS_TABLE_NAME: &str = "fragments";
pub const FRAGMENT_EMBEDDINGS_TABLE_NAME: &str = "fragment_embeddings";
pub const FRAGMENT_EMBEDDING_COLUMN_NAME: &str = "embedding";

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
      CREATE_FRAGMENTS_TABLE_SQL.trim().to_owned(),
      CREATE_FRAGMENTS_ITEM_INDEX_SQL.trim().to_owned(),
      create_fragment_embeddings_table_sql(embedding_dimensions)?,
    ])
  }

  pub fn drop_schema_sql() -> Vec<&'static str> {
    vec![DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL, DROP_FRAGMENTS_TABLE_SQL]
  }

  fn not_implemented_error(&self, operation: &str) -> infusdk::util::infu::InfuError {
    format!(
      "sqlite-vec fragment vector database '{}' cannot {} yet; sqlite-vec storage is not implemented.",
      self.db_path.display(),
      operation
    )
    .into()
  }
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

#[async_trait]
impl FragmentVectorDb for SqliteVecFragmentVectorDb {
  async fn rebuild(&self, _fragments: &[EmbeddedFragment]) -> InfuResult<()> {
    Err(self.not_implemented_error("rebuild"))
  }

  async fn search(&self, _query_embedding: &[f32], _limit: usize) -> InfuResult<Vec<FragmentVectorHit>> {
    Err(self.not_implemented_error("search"))
  }
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::{
    CREATE_FRAGMENTS_ITEM_INDEX_SQL, CREATE_FRAGMENTS_TABLE_SQL, DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL,
    DROP_FRAGMENTS_TABLE_SQL, FRAGMENT_EMBEDDING_COLUMN_NAME, FRAGMENT_EMBEDDINGS_TABLE_NAME, FRAGMENTS_TABLE_NAME,
    INSERT_FRAGMENT_EMBEDDING_SQL, INSERT_FRAGMENT_SQL, SEARCH_FRAGMENTS_SQL, SqliteVecFragmentVectorDb,
    create_fragment_embeddings_table_sql, fragment_text_sha256,
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
    assert_eq!(sql.len(), 3);
    assert!(sql[0].contains("CREATE TABLE IF NOT EXISTS fragments"));
    assert!(sql[0].contains("source_kind TEXT NOT NULL"));
    assert!(sql[0].contains("text_sha256 TEXT NOT NULL"));
    assert!(sql[0].contains("UNIQUE(item_id, ordinal)"));
    assert_eq!(sql[1], CREATE_FRAGMENTS_ITEM_INDEX_SQL.trim());
    assert!(sql[2].contains("CREATE VIRTUAL TABLE IF NOT EXISTS fragment_embeddings"));
    assert!(sql[2].contains("float[384]"));
  }

  #[test]
  fn exposes_sql_for_rebuild_and_search() {
    assert!(CREATE_FRAGMENTS_TABLE_SQL.contains(FRAGMENTS_TABLE_NAME));
    assert!(INSERT_FRAGMENT_SQL.contains("text_sha256"));
    assert!(INSERT_FRAGMENT_EMBEDDING_SQL.contains(FRAGMENT_EMBEDDINGS_TABLE_NAME));
    assert!(SEARCH_FRAGMENTS_SQL.contains("MATCH ?1"));
    assert!(SEARCH_FRAGMENTS_SQL.contains("AND k = ?2"));
    assert!(SEARCH_FRAGMENTS_SQL.contains("JOIN fragments ON fragments.fragment_id = fragment_embeddings.rowid"));

    let drop_sql = SqliteVecFragmentVectorDb::drop_schema_sql();
    assert_eq!(drop_sql, vec![DROP_FRAGMENT_EMBEDDINGS_TABLE_SQL, DROP_FRAGMENTS_TABLE_SQL]);
  }

  #[test]
  fn hashes_fragment_text_for_metadata_rows() {
    assert_eq!(fragment_text_sha256("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  }
}
