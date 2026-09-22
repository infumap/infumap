pub mod artifact_paths;
pub mod batch_processing;
pub mod document_pipeline;
pub mod fragment;
pub mod fragment_indexing;
pub mod geo;
pub mod gpu_tools;
pub mod image_pipeline;
pub mod image_tagging;
pub mod lexical_index;
pub mod metrics;
pub mod search_index_paths;
pub mod search_status;
pub mod text_extraction;
pub mod title_indexing;
pub mod upload_quiet_period;

pub(crate) fn user_id_for_log(user_id: &str) -> String {
  let mut chars = user_id.chars();
  let prefix = chars.by_ref().take(5).collect::<String>();
  if chars.next().is_some() { format!("{}..", prefix) } else { prefix }
}
