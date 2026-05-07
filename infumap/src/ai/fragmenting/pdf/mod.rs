use infusdk::item::Item;
use infusdk::util::infu::InfuResult;

use crate::ai::fragments::FragmentSourceKind;

use super::FragmentSource;

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

pub async fn pdf_fragment_source_for_item(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let Some(markdown) = load_pdf_markdown_artifact(data_dir, &item.owner_id, &item.id).await? else {
    return Ok(None);
  };

  let fragments = build_pdf_fragment_inputs(item.title.as_deref(), context_title.as_deref(), &markdown);
  if fragments.is_empty() {
    return Ok(None);
  }

  Ok(Some(FragmentSource { source_kind: FragmentSourceKind::PdfMarkdown, fragments }))
}
