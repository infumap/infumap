#[derive(Clone)]
pub(super) struct PdfFragmentBlock {
  pub(super) page_number: usize,
  pub(super) headings: Vec<String>,
  pub(super) text: String,
}

pub(super) struct PdfPage {
  pub(super) raw_page_number: Option<usize>,
  pub(super) text: String,
}

pub(super) struct ResolvedPdfPage {
  pub(super) page_number: usize,
  pub(super) text: String,
}

pub(super) struct PdfTextBlock {
  pub(super) page_number: usize,
  pub(super) headings: Vec<String>,
  pub(super) text: String,
}
