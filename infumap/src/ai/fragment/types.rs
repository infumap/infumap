pub const PDF_MARKDOWN_SOURCE_KIND: &str = "pdf_markdown";
pub const PDF_FIRST_PAGE_CAPTION_SOURCE_KIND: &str = "pdf_first_page_caption";
pub const ITEM_TITLE_SOURCE_KIND: &str = "item_title";
const MARKDOWN_SOURCE_KIND: &str = "markdown";
const TEXT_SOURCE_KIND: &str = "text";
pub const IMAGE_DOCUMENT_SOURCE_KIND: &str = "image_document_contents";

#[derive(Clone, Copy)]
pub enum FragmentSourceKind {
  ImageContents,
  ImageDocumentContents,
  Markdown,
  Text,
  PdfMarkdown,
  PdfFirstPageCaption,
}

impl FragmentSourceKind {
  pub(super) fn as_str(&self) -> &'static str {
    match self {
      FragmentSourceKind::ImageContents => "image_contents",
      FragmentSourceKind::ImageDocumentContents => IMAGE_DOCUMENT_SOURCE_KIND,
      FragmentSourceKind::Markdown => MARKDOWN_SOURCE_KIND,
      FragmentSourceKind::Text => TEXT_SOURCE_KIND,
      FragmentSourceKind::PdfMarkdown => PDF_MARKDOWN_SOURCE_KIND,
      FragmentSourceKind::PdfFirstPageCaption => PDF_FIRST_PAGE_CAPTION_SOURCE_KIND,
    }
  }
}

pub fn is_lexical_search_source_kind(source_kind: &str) -> bool {
  matches!(
    source_kind,
    ITEM_TITLE_SOURCE_KIND
      | PDF_MARKDOWN_SOURCE_KIND
      | PDF_FIRST_PAGE_CAPTION_SOURCE_KIND
      | MARKDOWN_SOURCE_KIND
      | TEXT_SOURCE_KIND
      | IMAGE_DOCUMENT_SOURCE_KIND
  )
}

pub fn is_markdown_document_source_kind(source_kind: &str) -> bool {
  matches!(source_kind, PDF_MARKDOWN_SOURCE_KIND | MARKDOWN_SOURCE_KIND)
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
