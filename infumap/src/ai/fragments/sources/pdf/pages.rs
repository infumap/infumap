use super::PDF_PAGE_BREAK_MIN_DASH_COUNT;
use super::types::{PdfPage, ResolvedPdfPage};

pub(super) fn split_pdf_markdown_pages(markdown: &str) -> Vec<PdfPage> {
  let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
  let mut pages = Vec::new();
  let mut current_raw_page = None::<usize>;
  let mut current_lines = Vec::<String>::new();
  let mut saw_marker = false;

  for line in normalized.lines() {
    if let Some(raw_page_number) = parse_pdf_page_break_marker(line) {
      saw_marker = true;
      if !current_lines.is_empty() || current_raw_page.is_some() {
        pages.push(PdfPage { raw_page_number: current_raw_page, text: current_lines.join("\n") });
        current_lines.clear();
      }
      current_raw_page = Some(raw_page_number);
      continue;
    }
    current_lines.push(line.to_owned());
  }

  if !current_lines.is_empty() || current_raw_page.is_some() || !saw_marker {
    pages.push(PdfPage { raw_page_number: current_raw_page, text: current_lines.join("\n") });
  }

  pages
}

fn parse_pdf_page_break_marker(line: &str) -> Option<usize> {
  let trimmed = line.trim();
  let closing_brace = trimmed.find('}')?;
  if !trimmed.starts_with('{') || closing_brace <= 1 {
    return None;
  }
  let raw_page_number = trimmed[1..closing_brace].parse::<usize>().ok()?;
  let dashes = trimmed[(closing_brace + 1)..].trim();
  if dashes.len() < PDF_PAGE_BREAK_MIN_DASH_COUNT || !dashes.chars().all(|ch| ch == '-') {
    return None;
  }
  Some(raw_page_number)
}

pub(super) fn resolve_pdf_pages(pages: Vec<PdfPage>) -> Vec<ResolvedPdfPage> {
  let has_zero_based_markers = pages.iter().filter_map(|page| page.raw_page_number).any(|page_number| page_number == 0);

  let mut next_page_number = 1usize;
  pages
    .into_iter()
    .map(|page| {
      let page_number = match page.raw_page_number {
        Some(raw_page_number) if has_zero_based_markers => raw_page_number + 1,
        Some(raw_page_number) => raw_page_number.max(1),
        None => next_page_number,
      };
      next_page_number = page_number + 1;
      ResolvedPdfPage { page_number, text: page.text }
    })
    .collect()
}
