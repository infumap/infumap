#![allow(dead_code)]

use std::path::PathBuf;

use async_trait::async_trait;
use infusdk::util::infu::InfuResult;

pub mod sqlite_vec;

#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedFragment {
  pub item_id: String,
  pub ordinal: usize,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
  pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FragmentVectorHit {
  pub item_id: String,
  pub ordinal: usize,
  pub distance: f32,
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

#[async_trait]
pub trait FragmentVectorDb: Send + Sync {
  async fn rebuild(&self, fragments: &[EmbeddedFragment]) -> InfuResult<()>;

  async fn search(&self, query_embedding: &[f32], limit: usize) -> InfuResult<Vec<FragmentVectorHit>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FragmentVectorDbBackend {
  SqliteVec,
}

pub fn open_fragment_vector_db(backend: FragmentVectorDbBackend, db_path: PathBuf) -> Box<dyn FragmentVectorDb> {
  match backend {
    FragmentVectorDbBackend::SqliteVec => Box::new(sqlite_vec::SqliteVecFragmentVectorDb::new(db_path)),
  }
}
