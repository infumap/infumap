pub mod artifact_paths;
pub mod batch_processing;
pub mod fragment;
pub mod geo;
pub mod image_pipeline;
pub mod image_tagging;
pub mod indexing;
pub mod lexical_index;
pub mod metrics;
pub mod text_embedding;
pub mod text_extraction;
pub mod title_indexing;
pub mod vector_db;

pub(crate) fn user_id_for_log(user_id: &str) -> String {
  let mut chars = user_id.chars();
  let prefix = chars.by_ref().take(5).collect::<String>();
  if chars.next().is_some() { format!("{}..", prefix) } else { prefix }
}

pub(crate) fn user_ids_for_log(user_ids: &[String]) -> String {
  user_ids.iter().map(|user_id| user_id_for_log(user_id)).collect::<Vec<_>>().join(", ")
}
