use super::super::{labeled_sentence, normalized_text};
use super::types::PdfFragmentBlock;

pub(super) fn render_pdf_fragment_text(
  document_title: Option<&str>,
  context_title: Option<&str>,
  page_start: usize,
  page_end: usize,
  blocks: &[PdfFragmentBlock],
) -> String {
  let document_title = normalized_text(document_title);
  let context_title = normalized_text(context_title)
    .filter(|context| document_title.as_deref().map(|title| !title.eq_ignore_ascii_case(context)).unwrap_or(true));
  let mut lines = Vec::new();

  if let Some(document_title) = document_title.as_deref() {
    lines.push(labeled_sentence("Document", document_title));
  }

  if let Some(context_title) = context_title.as_deref() {
    lines.push(labeled_sentence("Context", context_title));
  }

  let rendered_blocks = collapse_renderable_pdf_blocks(blocks, document_title.as_deref(), context_title.as_deref());
  let section_path = common_heading_path(&rendered_blocks);
  if !section_path.is_empty() {
    lines.push(labeled_sentence("Section", &section_path.join(" > ")));
  }

  let page_label = if page_start == page_end { page_start.to_string() } else { format!("{page_start}-{page_end}") };
  lines.push(labeled_sentence(if page_start == page_end { "Page" } else { "Pages" }, &page_label));

  let body = rendered_blocks
    .iter()
    .map(|block| render_pdf_body_block(block, &section_path))
    .filter(|block| !block.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
  if body.is_empty() {
    lines.join("\n")
  } else if lines.is_empty() {
    body
  } else {
    format!("{}\n\n{}", lines.join("\n"), body)
  }
}

fn collapse_renderable_pdf_blocks(
  blocks: &[PdfFragmentBlock],
  document_title: Option<&str>,
  context_title: Option<&str>,
) -> Vec<RenderablePdfBlock> {
  let mut out = Vec::<RenderablePdfBlock>::new();

  for block in blocks {
    let text = block.text.trim();
    if text.is_empty() {
      continue;
    }
    let headings = normalized_heading_path(&block.headings, document_title, context_title);
    if let Some(last) = out.last_mut() {
      if heading_paths_equal(&last.headings, &headings) {
        last.body_parts.push(text.to_owned());
        continue;
      }
    }
    out.push(RenderablePdfBlock { headings, body_parts: vec![text.to_owned()] });
  }

  out
}

fn render_pdf_body_block(block: &RenderablePdfBlock, shared_heading_path: &[String]) -> String {
  let heading_line = if shared_heading_path.is_empty() {
    if block.headings.is_empty() { None } else { Some(labeled_sentence("Section", &block.headings.join(" > "))) }
  } else {
    let remainder = heading_path_remainder(&block.headings, shared_heading_path);
    if remainder.is_empty() { None } else { Some(labeled_sentence("Subsection", &remainder.join(" > "))) }
  };

  let body =
    block.body_parts.iter().map(|part| part.trim()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
  if body.is_empty() {
    heading_line.unwrap_or_default()
  } else if let Some(heading_line) = heading_line {
    format!("{heading_line}\n{body}")
  } else {
    body
  }
}

fn normalized_heading_path(
  headings: &[String],
  document_title: Option<&str>,
  context_title: Option<&str>,
) -> Vec<String> {
  let document_title = normalized_text(document_title);
  let context_title = normalized_text(context_title);
  let mut out = Vec::new();

  for heading in headings {
    let Some(heading) = normalized_text(Some(heading.as_str())) else {
      continue;
    };
    if document_title.as_deref().map(|title| title.eq_ignore_ascii_case(&heading)).unwrap_or(false) {
      continue;
    }
    if context_title.as_deref().map(|context| context.eq_ignore_ascii_case(&heading)).unwrap_or(false) {
      continue;
    }
    if out.last().map(|prev: &String| prev.eq_ignore_ascii_case(&heading)).unwrap_or(false) {
      continue;
    }
    out.push(heading);
  }

  out
}

fn common_heading_path(blocks: &[RenderablePdfBlock]) -> Vec<String> {
  let mut shared = match blocks.first() {
    Some(block) => block.headings.clone(),
    None => return vec![],
  };

  for block in blocks.iter().skip(1) {
    let shared_len =
      shared.iter().zip(block.headings.iter()).take_while(|(left, right)| left.eq_ignore_ascii_case(right)).count();
    shared.truncate(shared_len);
    if shared.is_empty() {
      break;
    }
  }

  shared
}

fn heading_path_remainder(path: &[String], shared_prefix: &[String]) -> Vec<String> {
  let shared_len =
    shared_prefix.iter().zip(path.iter()).take_while(|(left, right)| left.eq_ignore_ascii_case(right)).count();
  path[shared_len..].to_vec()
}

pub(super) fn heading_paths_equal(left: &[String], right: &[String]) -> bool {
  left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| left.eq_ignore_ascii_case(right))
}

struct RenderablePdfBlock {
  headings: Vec<String>,
  body_parts: Vec<String>,
}
