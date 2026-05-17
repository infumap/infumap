use infusdk::item::Item;
use infusdk::util::infu::InfuResult;

use super::super::FragmentBuildOutcome;
use super::{FragmentSource, FragmentSourceKind, write_fragment_source_artifact};

mod blocks;
mod chunking;
mod loader;
mod pages;
mod rendering;
mod splitting;
mod types;

use chunking::build_pdf_fragment_inputs;
use loader::load_pdf_markdown_artifact;

pub(super) const PDF_FRAGMENT_MIN_CHARS: usize = 500;
pub(super) const PDF_FRAGMENT_SOFT_LIMIT_CHARS: usize = 1400;
pub(super) const PDF_FRAGMENT_HARD_LIMIT_CHARS: usize = 1900;
pub(super) const PDF_FRAGMENT_SOFT_LIMIT_TOKENS: usize = 380;
pub(super) const PDF_FRAGMENT_HARD_LIMIT_TOKENS: usize = 440;
pub(super) const PDF_PAGE_BREAK_MIN_DASH_COUNT: usize = 8;

pub struct PdfFragmentBuildResult {
  pub outcome: FragmentBuildOutcome,
}

pub async fn pdf_fragment_source_for_item(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let Some(markdown) = load_pdf_markdown_artifact(data_dir, &item.owner_id, &item.id).await? else {
    return Ok(None);
  };

  Ok(markdown_fragment_source(
    FragmentSourceKind::PdfMarkdown,
    item.title.as_deref(),
    context_title.as_deref(),
    &markdown,
  ))
}

pub async fn build_pdf_fragment_artifact(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<PdfFragmentBuildResult> {
  let fragment_source = pdf_fragment_source_for_item(data_dir, item, context_title).await?;
  let outcome = write_fragment_source_artifact(data_dir, item, fragment_source).await?;
  Ok(PdfFragmentBuildResult { outcome })
}

pub(super) fn markdown_fragment_source(
  source_kind: FragmentSourceKind,
  document_title: Option<&str>,
  context_title: Option<&str>,
  markdown: &str,
) -> Option<FragmentSource> {
  let fragments = build_pdf_fragment_inputs(document_title, context_title, markdown);
  if fragments.is_empty() {
    return None;
  }

  Some(FragmentSource { source_kind, fragments })
}
