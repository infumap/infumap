use std::path::{Path, PathBuf};

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;

use super::{EmbeddedFragment, FragmentVectorDb, FragmentVectorHit};

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

  fn not_implemented_error(&self, operation: &str) -> infusdk::util::infu::InfuError {
    format!(
      "sqlite-vec fragment vector database '{}' cannot {} yet; sqlite-vec storage is not implemented.",
      self.db_path.display(),
      operation
    )
    .into()
  }
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

  use super::SqliteVecFragmentVectorDb;

  #[test]
  fn stores_configured_db_path() {
    let db = SqliteVecFragmentVectorDb::new(PathBuf::from("/tmp/fragments.sqlite3"));
    assert_eq!(db.db_path(), PathBuf::from("/tmp/fragments.sqlite3").as_path());
  }
}
