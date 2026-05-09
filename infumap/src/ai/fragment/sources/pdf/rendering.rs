use super::super::normalized_text;
use super::types::PdfFragmentBlock;

pub(super) fn render_pdf_fragment_text(
  document_title: Option<&str>,
  context_title: Option<&str>,
  _page_start: usize,
  _page_end: usize,
  blocks: &[PdfFragmentBlock],
) -> String {
  let document_title = normalized_text(document_title);
  let context_title = normalized_text(context_title)
    .filter(|context| document_title.as_deref().map(|title| !title.eq_ignore_ascii_case(context)).unwrap_or(true));
  let mut lines = Vec::new();

  let rendered_blocks = collapse_renderable_pdf_blocks(blocks, document_title.as_deref(), context_title.as_deref());
  let section_path = common_heading_path(&rendered_blocks);
  if !section_path.is_empty() {
    lines.push(labeled_sentence("Section", &section_path.join(" > ")));
  }

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

fn labeled_sentence(label: &str, value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  match trimmed.chars().last() {
    Some('.' | '!' | '?') => format!("{label}: {trimmed}"),
    _ => format!("{label}: {trimmed}."),
  }
}

#[cfg(test)]
mod tests {
  use super::super::types::PdfFragmentBlock;
  use super::render_pdf_fragment_text;

  #[test]
  fn omits_document_and_context_headers_from_pdf_fragment_text() {
    let text = render_pdf_fragment_text(
      Some("Sample.pdf"),
      Some("Shelf"),
      1,
      1,
      &[block(1, &["Sample.pdf", "Shelf", "Chapter One"], "Woodstock appears in the body.")],
    );

    assert!(!text.contains("Document:"));
    assert!(!text.contains("Context:"));
    assert!(text.starts_with("Section: Chapter One.\n\n"));
    assert!(text.contains("Woodstock appears in the body."));
  }

  #[test]
  fn renders_body_only_when_pdf_fragment_has_no_section() {
    let text = render_pdf_fragment_text(
      Some("Sample.pdf"),
      Some("Shelf"),
      1,
      1,
      &[block(1, &[], "A paragraph without headings.")],
    );

    assert_eq!(text, "A paragraph without headings.");
  }

  fn block(page_number: usize, headings: &[&str], text: &str) -> PdfFragmentBlock {
    PdfFragmentBlock {
      page_number,
      headings: headings.iter().map(|heading| heading.to_string()).collect(),
      text: text.to_owned(),
    }
  }
}
