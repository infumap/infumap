use super::super::FragmentInput;
use super::blocks::build_pdf_text_blocks;
use super::pages::{resolve_pdf_pages, split_pdf_markdown_pages};
use super::rendering::{heading_paths_equal, render_pdf_fragment_text};
use super::splitting::{estimate_embedding_token_count, split_pdf_block_text};
use super::types::PdfFragmentBlock;
use super::{
  PDF_FRAGMENT_HARD_LIMIT_CHARS, PDF_FRAGMENT_HARD_LIMIT_TOKENS, PDF_FRAGMENT_MIN_CHARS, PDF_FRAGMENT_SOFT_LIMIT_CHARS,
  PDF_FRAGMENT_SOFT_LIMIT_TOKENS,
};

pub(super) fn build_pdf_fragment_inputs(markdown: &str) -> Vec<FragmentInput> {
  let pages = resolve_pdf_pages(split_pdf_markdown_pages(markdown));
  let blocks = build_pdf_text_blocks(&pages);
  if blocks.is_empty() {
    return vec![];
  }
  let prepared_blocks = blocks
    .into_iter()
    .flat_map(|block| {
      split_pdf_block_text(&block.text).into_iter().map(move |part| PdfFragmentBlock {
        page_number: block.page_number,
        headings: block.headings.clone(),
        text: part,
      })
    })
    .collect::<Vec<_>>();

  let mut fragments = Vec::new();
  let mut current: Option<PdfFragmentAccumulator> = None;

  for (index, next_block) in prepared_blocks.iter().enumerate() {
    let should_flush =
      current.as_ref().is_some_and(|current| should_flush_pdf_fragment(current, next_block, &prepared_blocks[index..]));

    if should_flush {
      push_pdf_fragment_input(&mut fragments, current.take());
    }

    let current_fragment = current.get_or_insert_with(|| PdfFragmentAccumulator::new(next_block.page_number));
    current_fragment.push(next_block.clone());
  }

  push_pdf_fragment_input(&mut fragments, current);
  fragments
}

fn push_pdf_fragment_input(out: &mut Vec<FragmentInput>, fragment: Option<PdfFragmentAccumulator>) {
  let Some(fragment) = fragment else {
    return;
  };
  let text = render_pdf_fragment_text(fragment.page_start, fragment.page_end, &fragment.blocks);
  if text.trim().is_empty() {
    return;
  }
  out.push(FragmentInput::new(text).with_page_range(Some(fragment.page_start), Some(fragment.page_end)));
}

fn should_flush_pdf_fragment(
  current: &PdfFragmentAccumulator,
  next_block: &PdfFragmentBlock,
  upcoming_blocks: &[PdfFragmentBlock],
) -> bool {
  let continues_same_heading =
    current.blocks.last().map(|block| heading_paths_equal(&block.headings, &next_block.headings)).unwrap_or(false);
  let current_len = rendered_pdf_fragment_len(current.page_start, current.page_end, &current.blocks, None);
  let candidate_len =
    rendered_pdf_fragment_len(current.page_start, next_block.page_number, &current.blocks, Some(next_block));
  let candidate_tokens =
    rendered_pdf_fragment_token_estimate(current.page_start, next_block.page_number, &current.blocks, Some(next_block));

  if candidate_len > PDF_FRAGMENT_HARD_LIMIT_CHARS || candidate_tokens > PDF_FRAGMENT_HARD_LIMIT_TOKENS {
    return true;
  }

  if continues_same_heading {
    return false;
  }

  if should_flush_before_new_heading_run(current, upcoming_blocks, current_len) {
    return true;
  }

  (candidate_len > PDF_FRAGMENT_SOFT_LIMIT_CHARS || candidate_tokens > PDF_FRAGMENT_SOFT_LIMIT_TOKENS)
    && current_len >= PDF_FRAGMENT_MIN_CHARS
}

fn should_flush_before_new_heading_run(
  current: &PdfFragmentAccumulator,
  upcoming_blocks: &[PdfFragmentBlock],
  current_len: usize,
) -> bool {
  let Some(next_block) = upcoming_blocks.first() else {
    return false;
  };
  let Some(last_block) = current.blocks.last() else {
    return false;
  };
  if heading_paths_equal(&last_block.headings, &next_block.headings) || current_len < PDF_FRAGMENT_MIN_CHARS {
    return false;
  }

  let heading_run_len = consecutive_heading_run_len(upcoming_blocks);
  let heading_run = &upcoming_blocks[..heading_run_len];
  let heading_run_page_start = heading_run.first().map(|block| block.page_number).unwrap_or(next_block.page_number);
  let heading_run_page_end = heading_run.last().map(|block| block.page_number).unwrap_or(next_block.page_number);

  let heading_run_render_len =
    rendered_pdf_fragment_len(heading_run_page_start, heading_run_page_end, heading_run, None);
  let heading_run_render_tokens =
    rendered_pdf_fragment_token_estimate(heading_run_page_start, heading_run_page_end, heading_run, None);
  let heading_run_fits_hard_limits = heading_run_render_len <= PDF_FRAGMENT_HARD_LIMIT_CHARS
    && heading_run_render_tokens <= PDF_FRAGMENT_HARD_LIMIT_TOKENS;

  let mut combined_blocks = current.blocks.clone();
  combined_blocks.extend(heading_run.iter().cloned());
  let combined_render_len = rendered_pdf_fragment_len(current.page_start, heading_run_page_end, &combined_blocks, None);
  let combined_render_tokens =
    rendered_pdf_fragment_token_estimate(current.page_start, heading_run_page_end, &combined_blocks, None);

  if combined_render_len <= PDF_FRAGMENT_SOFT_LIMIT_CHARS && combined_render_tokens <= PDF_FRAGMENT_SOFT_LIMIT_TOKENS {
    return false;
  }

  heading_run_fits_hard_limits || heading_run_len > 1
}

fn consecutive_heading_run_len(blocks: &[PdfFragmentBlock]) -> usize {
  let Some(first_block) = blocks.first() else {
    return 0;
  };
  blocks.iter().take_while(|block| heading_paths_equal(&block.headings, &first_block.headings)).count()
}

fn rendered_pdf_fragment_len(
  page_start: usize,
  page_end: usize,
  blocks: &[PdfFragmentBlock],
  next_block: Option<&PdfFragmentBlock>,
) -> usize {
  let mut candidate_blocks = blocks.to_vec();
  if let Some(next_block) = next_block {
    candidate_blocks.push(next_block.clone());
  }
  render_pdf_fragment_text(page_start, page_end, &candidate_blocks).len()
}

fn rendered_pdf_fragment_token_estimate(
  page_start: usize,
  page_end: usize,
  blocks: &[PdfFragmentBlock],
  next_block: Option<&PdfFragmentBlock>,
) -> usize {
  let mut candidate_blocks = blocks.to_vec();
  if let Some(next_block) = next_block {
    candidate_blocks.push(next_block.clone());
  }
  estimate_embedding_token_count(&render_pdf_fragment_text(page_start, page_end, &candidate_blocks))
}

struct PdfFragmentAccumulator {
  page_start: usize,
  page_end: usize,
  blocks: Vec<PdfFragmentBlock>,
}

impl PdfFragmentAccumulator {
  fn new(page_number: usize) -> PdfFragmentAccumulator {
    PdfFragmentAccumulator { page_start: page_number, page_end: page_number, blocks: Vec::new() }
  }

  fn push(&mut self, block: PdfFragmentBlock) {
    self.page_end = block.page_number;
    self.blocks.push(block);
  }
}
