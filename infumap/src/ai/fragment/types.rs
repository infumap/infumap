pub const PDF_MARKDOWN_SOURCE_KIND: &str = "pdf_markdown";

#[derive(Clone, Copy)]
pub enum FragmentSourceKind {
  PageContents,
  TableContents,
  ImageContents,
  PdfMarkdown,
}

impl FragmentSourceKind {
  pub(super) fn as_str(&self) -> &'static str {
    match self {
      FragmentSourceKind::PageContents => "page_contents",
      FragmentSourceKind::TableContents => "table_contents",
      FragmentSourceKind::ImageContents => "image_contents",
      FragmentSourceKind::PdfMarkdown => PDF_MARKDOWN_SOURCE_KIND,
    }
  }
}

#[derive(Default)]
pub struct FragmentBuildOutcome {
  pub wrote_fragments: bool,
  pub fragment_count: usize,
  pub cleared_existing_fragments: bool,
}

pub struct FragmentInput {
  pub text: String,
  pub page_start: Option<usize>,
  pub page_end: Option<usize>,
}

impl FragmentInput {
  pub fn new(text: String) -> FragmentInput {
    FragmentInput { text, page_start: None, page_end: None }
  }

  pub fn with_page_range(mut self, page_start: Option<usize>, page_end: Option<usize>) -> FragmentInput {
    self.page_start = page_start;
    self.page_end = page_end;
    self
  }
}

pub struct FragmentSource {
  pub source_kind: FragmentSourceKind,
  pub fragments: Vec<FragmentInput>,
}
