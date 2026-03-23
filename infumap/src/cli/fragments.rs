use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Arg, ArgMatches, Command};
use infusdk::item::{ArrangeAlgorithm, Item, ItemType, RelationshipToParent};
use infusdk::util::infu::InfuResult;
use log::info;
use reqwest::Url;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::fs;
use tokio::sync::Mutex;

use crate::config::CONFIG_DATA_DIR;
use crate::rag::{
  FragmentBuildOutcome, FragmentInput, FragmentSourceKind, build_fragment_inputs_for_item, clear_fragments_for_item,
};
use crate::setup::get_config;
use crate::storage::db::Db;
use crate::util::fs::expand_tilde;
use crate::util::ordering::compare_orderings;
use crate::web::image_tagging::should_tag_image_item;

const PDF_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_CONTENT_MIME_TYPE: &str = "text/markdown";
const PDF_FRAGMENT_SOFT_LIMIT_CHARS: usize = 1400;
const PDF_FRAGMENT_HARD_LIMIT_CHARS: usize = 1900;
const PDF_PAGE_BREAK_MIN_DASH_COUNT: usize = 8;

#[derive(Clone, Copy)]
enum FragmentTargetKind {
  Content,
  Image,
  Pdf,
}

impl FragmentTargetKind {
  fn matches_item(self, item: &Item) -> bool {
    match self {
      FragmentTargetKind::Content => matches!(item.item_type, ItemType::Page | ItemType::Table),
      FragmentTargetKind::Image => should_tag_image_item(item),
      FragmentTargetKind::Pdf => item.item_type == ItemType::File && item.mime_type.as_deref() == Some(PDF_MIME_TYPE),
    }
  }

  fn singular_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page or table",
      FragmentTargetKind::Image => "supported image",
      FragmentTargetKind::Pdf => "PDF file",
    }
  }

  fn summary_label(self) -> &'static str {
    match self {
      FragmentTargetKind::Content => "page/table",
      FragmentTargetKind::Image => "image",
      FragmentTargetKind::Pdf => "pdf",
    }
  }
}

#[derive(Default)]
struct FragmentRunSummary {
  items_with_fragments: usize,
  items_cleared: usize,
  fragments_written: usize,
}

pub fn make_clap_subcommand() -> Command {
  Command::new("fragments")
    .about("Build on-disk RAG fragment artifacts without starting the web server.")
    .subcommand_required(true)
    .arg_required_else_help(true)
    .subcommand(make_content_subcommand())
    .subcommand(make_image_subcommand())
    .subcommand(make_pdf_subcommand())
}

pub async fn execute(sub_matches: &ArgMatches) -> InfuResult<()> {
  match sub_matches.subcommand() {
    Some(("content", sub_matches)) => execute_content(sub_matches).await,
    Some(("page-table", sub_matches)) => execute_content(sub_matches).await,
    Some(("image", sub_matches)) => execute_image(sub_matches).await,
    Some(("images", sub_matches)) => execute_image(sub_matches).await,
    Some(("pdf", sub_matches)) => execute_pdf(sub_matches).await,
    Some(("pdfs", sub_matches)) => execute_pdf(sub_matches).await,
    _ => Err("Missing fragments subcommand. Use 'fragments content', 'fragments image', or 'fragments pdf'.".into()),
  }
}

fn make_content_subcommand() -> Command {
  Command::new("content")
    .visible_alias("page-table")
    .about("Build fragments for page and table content.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this page or table item."))
}

fn make_image_subcommand() -> Command {
  Command::new("image")
    .visible_alias("images")
    .about(
      "Build semantic text fragments for supported images using item metadata, image-tagging output, and geo output.",
    )
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this supported image item."))
}

fn make_pdf_subcommand() -> Command {
  Command::new("pdf")
    .visible_alias("pdfs")
    .about("Build semantic text fragments from extracted markdown for PDF file items.")
    .arg(settings_arg())
    .arg(item_id_arg("Build fragments only for this PDF item."))
}

fn settings_arg() -> Arg {
  Arg::new("settings_path")
    .short('s')
    .long("settings")
    .help("Path to a toml settings configuration file. If not specified, the default will be assumed.")
    .num_args(1)
    .required(false)
}

fn item_id_arg(help: &'static str) -> Arg {
  Arg::new("item_id").long("item-id").help(help).num_args(1).required(false)
}

async fn execute_content(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Content).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let fragment_source = {
      let db = db.lock().await;
      content_fragment_source_for_item(&db, &item)
    };
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Content, &summary);
  Ok(())
}

async fn execute_image(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Image).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let context_title = {
      let db = db.lock().await;
      embedding_context_title_for_item(&db, &item)
    };
    let fragment_source = image_fragment_source_for_item(&data_dir, &item, context_title).await?;
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Image, &summary);
  Ok(())
}

async fn execute_pdf(sub_matches: &ArgMatches) -> InfuResult<()> {
  let (data_dir, db, items) = load_db_and_items(sub_matches, FragmentTargetKind::Pdf).await?;
  let mut summary = FragmentRunSummary::default();

  for item in items {
    let context_title = {
      let db = db.lock().await;
      embedding_context_title_for_item(&db, &item)
    };
    let fragment_source = pdf_fragment_source_for_item(&data_dir, &item, context_title).await?;
    let outcome = apply_fragment_source(&data_dir, &item, fragment_source).await?;
    record_fragment_outcome(&mut summary, &outcome);
  }

  log_fragment_summary(FragmentTargetKind::Pdf, &summary);
  Ok(())
}

async fn load_db_and_items(
  sub_matches: &ArgMatches,
  target_kind: FragmentTargetKind,
) -> InfuResult<(String, Arc<Mutex<Db>>, Vec<Item>)> {
  let config = get_config(sub_matches.get_one::<String>("settings_path")).await?;
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let db = Arc::new(Mutex::new(Db::new(&data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?));

  {
    let mut db = db.lock().await;
    let all_user_ids: Vec<String> = db.user.all_user_ids().iter().map(|value| value.clone()).collect();
    for user_id in all_user_ids {
      db.item.load_user_items(&user_id, false).await?;
    }
  }

  let items = {
    let db = db.lock().await;
    if let Some(item_id) = sub_matches.get_one::<String>("item_id") {
      let item = db.item.get(item_id).map_err(|e| e.to_string())?.clone();
      if !target_kind.matches_item(&item) {
        return Err(format!("Item '{}' is not a {}.", item_id, target_kind.singular_label()).into());
      }
      vec![item]
    } else {
      let mut items = db
        .item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
        .filter(|item| target_kind.matches_item(item))
        .collect::<Vec<Item>>();
      items.sort_by(|a, b| a.owner_id.cmp(&b.owner_id).then(a.id.cmp(&b.id)));
      items
    }
  };

  Ok((data_dir, db, items))
}

async fn apply_fragment_source(
  data_dir: &str,
  item: &Item,
  fragment_source: Option<FragmentSource>,
) -> InfuResult<FragmentBuildOutcome> {
  match fragment_source {
    Some(fragment_source) => {
      build_fragment_inputs_for_item(data_dir, item, fragment_source.source_kind, fragment_source.fragments).await
    }
    None => clear_fragments_for_item(data_dir, item).await,
  }
}

fn record_fragment_outcome(summary: &mut FragmentRunSummary, outcome: &FragmentBuildOutcome) {
  if outcome.wrote_fragments {
    summary.items_with_fragments += 1;
    summary.fragments_written += outcome.fragment_count;
  } else if outcome.cleared_existing_fragments {
    summary.items_cleared += 1;
  }
}

fn log_fragment_summary(target_kind: FragmentTargetKind, summary: &FragmentRunSummary) {
  info!(
    "Built {} RAG fragments for {} item(s), wrote {} fragment(s), cleared {} empty item artifact dir(s).",
    target_kind.summary_label(),
    summary.items_with_fragments,
    summary.fragments_written,
    summary.items_cleared
  );
}

struct FragmentSource {
  source_kind: FragmentSourceKind,
  fragments: Vec<FragmentInput>,
}

fn content_fragment_source_for_item(db: &Db, item: &Item) -> Option<FragmentSource> {
  match item.item_type {
    ItemType::Page => container_fragment_source(db, item, FragmentSourceKind::PageContents),
    ItemType::Table => container_fragment_source(db, item, FragmentSourceKind::TableContents),
    _ => None,
  }
}

fn container_fragment_source(db: &Db, item: &Item, source_kind: FragmentSourceKind) -> Option<FragmentSource> {
  let own_title = normalized_text(item.title.as_deref());
  let lines = container_child_title_lines(db, item);
  if lines.is_empty() && own_title.is_none() {
    return None;
  }

  Some(single_fragment_source(
    source_kind,
    build_titled_fragment_text(lines.join("\n"), own_title.or_else(|| container_title_for_item(db, item))),
  ))
}

async fn image_fragment_source_for_item(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let image_tag_artifact = load_image_tag_artifact(data_dir, &item.owner_id, &item.id).await?;
  let geo_artifact = load_geo_artifact(data_dir, &item.owner_id, &item.id).await?;
  let dimensions = item.image_size_px.as_ref().map(|dims| (dims.w, dims.h));
  let fragment_text = build_image_fragment_text(
    item.title.as_deref(),
    context_title.as_deref(),
    dimensions,
    image_tag_artifact.as_ref(),
    geo_artifact.as_ref(),
  );

  Ok(fragment_text.map(|source_text| single_fragment_source(FragmentSourceKind::ImageContents, source_text)))
}

async fn pdf_fragment_source_for_item(
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

fn single_fragment_source(source_kind: FragmentSourceKind, text: String) -> FragmentSource {
  FragmentSource { source_kind, fragments: vec![FragmentInput::new(text)] }
}

fn build_titled_fragment_text(source_text: String, container_title: Option<String>) -> String {
  let source_text = source_text.trim();
  let container_title = container_title.map(|title| title.trim().to_owned()).filter(|title| !title.is_empty());

  match container_title.as_deref() {
    Some(container_title) if source_text.is_empty() => format!("## {}", container_title),
    Some(container_title) => format!("## {}\n\n{}", container_title, source_text),
    None => source_text.to_owned(),
  }
}

async fn load_pdf_markdown_artifact(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<Option<String>> {
  let Some(manifest) = load_pdf_text_manifest(data_dir, user_id, item_id).await? else {
    return Ok(None);
  };
  if manifest.status != "succeeded" || manifest.content_mime_type != MARKDOWN_CONTENT_MIME_TYPE {
    return Ok(None);
  }

  let path = pdf_text_path(data_dir, user_id, item_id)?;
  let text = match fs::read_to_string(&path).await {
    Ok(text) => text,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read extracted PDF markdown '{}': {}", path.display(), error).into()),
  };

  Ok(normalize_markdown_source(&text))
}

async fn load_pdf_text_manifest(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<StoredPdfTextManifest>> {
  let path = pdf_manifest_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "pdf text manifest").await
}

fn build_pdf_fragment_inputs(
  document_title: Option<&str>,
  context_title: Option<&str>,
  markdown: &str,
) -> Vec<FragmentInput> {
  let document_title = normalized_text(document_title);
  let context_title = normalized_text(context_title)
    .filter(|context| document_title.as_deref().map(|title| !title.eq_ignore_ascii_case(context)).unwrap_or(true));

  let pages = resolve_pdf_pages(split_pdf_markdown_pages(markdown));
  let blocks = build_pdf_text_blocks(&pages);
  if blocks.is_empty() {
    return vec![];
  }

  let mut fragments = Vec::new();
  let mut current: Option<PdfFragmentAccumulator> = None;

  for block in blocks {
    for part in split_pdf_block_text(&block.text) {
      let should_flush = current.as_ref().is_some_and(|current| {
        current.page_end != block.page_number
          || current.headings != block.headings
          || rendered_pdf_fragment_len(
            document_title.as_deref(),
            context_title.as_deref(),
            &current.headings,
            current.page_start,
            block.page_number,
            &current.blocks,
            Some(part.as_str()),
          ) > PDF_FRAGMENT_SOFT_LIMIT_CHARS
      });

      if should_flush {
        push_pdf_fragment_input(&mut fragments, current.take(), document_title.as_deref(), context_title.as_deref());
      }

      let current_fragment =
        current.get_or_insert_with(|| PdfFragmentAccumulator::new(block.page_number, block.headings.clone()));
      current_fragment.push(part, block.page_number);
    }
  }

  push_pdf_fragment_input(&mut fragments, current, document_title.as_deref(), context_title.as_deref());
  fragments
}

fn push_pdf_fragment_input(
  out: &mut Vec<FragmentInput>,
  fragment: Option<PdfFragmentAccumulator>,
  document_title: Option<&str>,
  context_title: Option<&str>,
) {
  let Some(fragment) = fragment else {
    return;
  };
  let text = render_pdf_fragment_text(
    document_title,
    context_title,
    &fragment.headings,
    fragment.page_start,
    fragment.page_end,
    &fragment.blocks,
  );
  if text.trim().is_empty() {
    return;
  }
  out.push(FragmentInput::new(text).with_page_range(Some(fragment.page_start), Some(fragment.page_end)));
}

fn rendered_pdf_fragment_len(
  document_title: Option<&str>,
  context_title: Option<&str>,
  headings: &[String],
  page_start: usize,
  page_end: usize,
  blocks: &[String],
  next_block: Option<&str>,
) -> usize {
  let mut candidate_blocks = blocks.to_vec();
  if let Some(next_block) = next_block {
    candidate_blocks.push(next_block.to_owned());
  }
  render_pdf_fragment_text(document_title, context_title, headings, page_start, page_end, &candidate_blocks).len()
}

fn render_pdf_fragment_text(
  document_title: Option<&str>,
  context_title: Option<&str>,
  headings: &[String],
  page_start: usize,
  page_end: usize,
  blocks: &[String],
) -> String {
  let mut lines = Vec::new();

  if let Some(document_title) = normalized_text(document_title) {
    lines.push(labeled_sentence("Document", &document_title));
  }

  if let Some(context_title) = normalized_text(context_title)
    .filter(|context| document_title.map(|title| !title.trim().eq_ignore_ascii_case(context)).unwrap_or(true))
  {
    lines.push(labeled_sentence("Context", &context_title));
  }

  let section_path = normalized_heading_path(headings, document_title, context_title);
  if !section_path.is_empty() {
    lines.push(labeled_sentence("Section", &section_path.join(" > ")));
  }

  let page_label = if page_start == page_end { page_start.to_string() } else { format!("{page_start}-{page_end}") };
  lines.push(labeled_sentence(if page_start == page_end { "Page" } else { "Pages" }, &page_label));

  let body = blocks.iter().map(|block| block.trim()).filter(|block| !block.is_empty()).collect::<Vec<_>>().join("\n\n");
  if body.is_empty() {
    lines.join("\n")
  } else if lines.is_empty() {
    body
  } else {
    format!("{}\n\n{}", lines.join("\n"), body)
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

fn split_pdf_block_text(text: &str) -> Vec<String> {
  let text = text.trim();
  if text.is_empty() {
    return vec![];
  }
  if text.len() <= PDF_FRAGMENT_HARD_LIMIT_CHARS {
    return vec![text.to_owned()];
  }

  let sentences = split_text_into_sentences(text);
  if sentences.len() <= 1 {
    return split_text_by_words(text, PDF_FRAGMENT_SOFT_LIMIT_CHARS, PDF_FRAGMENT_HARD_LIMIT_CHARS);
  }

  let mut out = Vec::new();
  let mut current = String::new();

  for sentence in sentences {
    if sentence.len() > PDF_FRAGMENT_HARD_LIMIT_CHARS {
      if !current.is_empty() {
        out.push(current);
        current = String::new();
      }
      out.extend(split_text_by_words(&sentence, PDF_FRAGMENT_SOFT_LIMIT_CHARS, PDF_FRAGMENT_HARD_LIMIT_CHARS));
      continue;
    }

    if current.is_empty() {
      current = sentence;
      continue;
    }

    if current.len() + 1 + sentence.len() > PDF_FRAGMENT_SOFT_LIMIT_CHARS {
      out.push(current);
      current = sentence;
    } else {
      current.push(' ');
      current.push_str(&sentence);
    }
  }

  if !current.is_empty() {
    out.push(current);
  }

  out
}

fn split_text_into_sentences(text: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut current = String::new();
  let chars = text.chars().collect::<Vec<char>>();

  for (index, ch) in chars.iter().enumerate() {
    current.push(*ch);
    let next_char = chars.get(index + 1).copied();
    if matches!(ch, '.' | '!' | '?' | ';') && next_char.map(|next| next.is_whitespace()).unwrap_or(true) {
      if let Some(normalized) = normalized_text(Some(current.as_str())) {
        out.push(normalized);
      }
      current.clear();
    }
  }

  if let Some(normalized) = normalized_text(Some(current.as_str())) {
    out.push(normalized);
  }

  out
}

fn split_text_by_words(text: &str, soft_limit: usize, hard_limit: usize) -> Vec<String> {
  let words = text.split_whitespace().collect::<Vec<&str>>();
  let mut out = Vec::new();
  let mut current = String::new();

  for word in words {
    if word.len() > hard_limit {
      if !current.is_empty() {
        out.push(current);
        current = String::new();
      }
      let mut remaining = word;
      while remaining.len() > hard_limit {
        out.push(remaining[..hard_limit].to_owned());
        remaining = &remaining[hard_limit..];
      }
      if !remaining.is_empty() {
        current = remaining.to_owned();
      }
      continue;
    }

    if current.is_empty() {
      current.push_str(word);
      continue;
    }

    if current.len() + 1 + word.len() > soft_limit {
      out.push(current);
      current = word.to_owned();
    } else {
      current.push(' ');
      current.push_str(word);
    }
  }

  if !current.is_empty() {
    out.push(current);
  }

  out
}

fn build_pdf_text_blocks(pages: &[ResolvedPdfPage]) -> Vec<PdfTextBlock> {
  let mut blocks = Vec::new();
  let mut heading_stack = Vec::<String>::new();

  for page in pages {
    let mut paragraph_lines = Vec::<String>::new();
    for line in page.text.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
        continue;
      }
      if is_markdown_rule_line(trimmed) {
        flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
        continue;
      }
      if let Some((level, text)) = parse_markdown_heading(trimmed) {
        flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
        while heading_stack.len() >= level {
          heading_stack.pop();
        }
        heading_stack.push(text);
        continue;
      }
      if let Some(list_item) = parse_markdown_list_item(trimmed) {
        flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
        blocks.push(PdfTextBlock { page_number: page.page_number, headings: heading_stack.clone(), text: list_item });
        continue;
      }

      let sanitized = sanitize_markdown_inline(trimmed);
      if sanitized.is_empty() {
        flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
        continue;
      }
      paragraph_lines.push(sanitized);
    }
    flush_pdf_paragraph_block(&mut blocks, &mut paragraph_lines, page.page_number, &heading_stack);
  }

  blocks
}

fn flush_pdf_paragraph_block(
  blocks: &mut Vec<PdfTextBlock>,
  paragraph_lines: &mut Vec<String>,
  page_number: usize,
  headings: &[String],
) {
  let text = paragraph_lines.join(" ");
  paragraph_lines.clear();
  let Some(text) = normalized_multiline_text(&text) else {
    return;
  };
  blocks.push(PdfTextBlock { page_number, headings: headings.to_vec(), text });
}

fn sanitize_markdown_inline(text: &str) -> String {
  let with_links = replace_markdown_links(text);
  let mut out = Vec::new();
  let mut previous_domain = None::<String>;

  for token in with_links.split_whitespace() {
    let normalized = normalize_inline_token(token);
    if normalized.is_empty() {
      continue;
    }

    if is_domain_like(&normalized)
      && previous_domain.as_deref().map(|previous| previous.eq_ignore_ascii_case(&normalized)).unwrap_or(false)
    {
      continue;
    }

    previous_domain = if is_domain_like(&normalized) { Some(normalized.to_lowercase()) } else { None };
    out.push(normalized);
  }

  cleanup_spacing(&out.join(" "))
}

fn replace_markdown_links(text: &str) -> String {
  let mut out = String::new();
  let mut cursor = 0usize;

  while let Some(open_bracket_offset) = text[cursor..].find('[') {
    let open_bracket = cursor + open_bracket_offset;
    out.push_str(&text[cursor..open_bracket]);

    let label_start = open_bracket + 1;
    let Some(label_end_offset) = text[label_start..].find("](") else {
      out.push_str(&text[open_bracket..]);
      return out;
    };
    let label_end = label_start + label_end_offset;
    let url_start = label_end + 2;
    let Some(url_end_offset) = text[url_start..].find(')') else {
      out.push_str(&text[open_bracket..]);
      return out;
    };
    let url_end = url_start + url_end_offset;

    let replacement = markdown_link_replacement(&text[label_start..label_end], &text[url_start..url_end]);
    if !replacement.is_empty() {
      if !out.is_empty() && !out.chars().last().map(|ch| ch.is_whitespace()).unwrap_or(false) {
        out.push(' ');
      }
      out.push_str(&replacement);
      out.push(' ');
    }

    cursor = url_end + 1;
  }

  out.push_str(&text[cursor..]);
  out
}

fn markdown_link_replacement(label: &str, url: &str) -> String {
  let label = strip_inline_markdown(label);
  let label = normalized_text(Some(label.as_str())).filter(|label| !label.starts_with('/'));
  let host = extract_url_host(url);

  match (label, host) {
    (Some(label), Some(host)) if label.eq_ignore_ascii_case(&host) => host,
    (Some(label), Some(host)) if is_domain_like(&label) => host,
    (Some(label), _) => label,
    (None, Some(host)) => host,
    (None, None) => String::new(),
  }
}

fn normalize_inline_token(token: &str) -> String {
  let trailing = token
    .chars()
    .rev()
    .take_while(|ch| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']'))
    .collect::<String>()
    .chars()
    .rev()
    .collect::<String>();
  let core = token
    .trim_matches(|ch: char| matches!(ch, '(' | '[' | '{' | '"' | '\''))
    .trim_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '"' | '\''));
  if core.is_empty() {
    return String::new();
  }

  if core.starts_with('/') {
    return trailing;
  }

  let normalized_core = extract_url_host(core).unwrap_or_else(|| strip_inline_markdown(core));
  if normalized_core.is_empty() {
    return trailing;
  }

  format!("{}{}", normalized_core, trailing)
}

fn strip_inline_markdown(text: &str) -> String {
  text.chars().filter(|ch| !matches!(ch, '*' | '_' | '`' | '~')).collect::<String>()
}

fn cleanup_spacing(text: &str) -> String {
  text
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .replace(" .", ".")
    .replace(" ,", ",")
    .replace(" ;", ";")
    .replace(" :", ":")
    .replace(" !", "!")
    .replace(" ?", "?")
}

fn extract_url_host(value: &str) -> Option<String> {
  if !(value.starts_with("http://") || value.starts_with("https://")) {
    return None;
  }
  Url::parse(value).ok()?.host_str().map(|host| host.to_owned())
}

fn is_domain_like(value: &str) -> bool {
  let trimmed = value.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-');
  trimmed.contains('.') && trimmed.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
}

fn parse_markdown_heading(line: &str) -> Option<(usize, String)> {
  let hashes = line.chars().take_while(|ch| *ch == '#').count();
  if hashes == 0 || hashes > 6 {
    return None;
  }
  let remainder = line[hashes..].trim_start();
  if remainder.is_empty() {
    return None;
  }
  let text = sanitize_markdown_inline(remainder);
  if text.is_empty() { None } else { Some((hashes, text)) }
}

fn parse_markdown_list_item(line: &str) -> Option<String> {
  let content = if let Some(stripped) = line.strip_prefix("- ") {
    stripped
  } else if let Some(stripped) = line.strip_prefix("* ") {
    stripped
  } else if let Some(stripped) = line.strip_prefix("+ ") {
    stripped
  } else {
    let digits = line.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if digits == 0 || !line[digits..].starts_with(". ") {
      return None;
    }
    &line[(digits + 2)..]
  };

  let text = sanitize_markdown_inline(content);
  if text.is_empty() { None } else { Some(format!("- {}", text)) }
}

fn is_markdown_rule_line(line: &str) -> bool {
  line.len() >= 3 && line.chars().all(|ch| matches!(ch, '-' | '*' | '_' | '='))
}

fn normalized_multiline_text(text: &str) -> Option<String> {
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() { None } else { Some(normalized) }
}

fn normalize_markdown_source(text: &str) -> Option<String> {
  let normalized = text.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
  if normalized.is_empty() { None } else { Some(normalized) }
}

fn split_pdf_markdown_pages(markdown: &str) -> Vec<PdfPage> {
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

fn resolve_pdf_pages(pages: Vec<PdfPage>) -> Vec<ResolvedPdfPage> {
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

struct PdfFragmentAccumulator {
  page_start: usize,
  page_end: usize,
  headings: Vec<String>,
  blocks: Vec<String>,
}

impl PdfFragmentAccumulator {
  fn new(page_number: usize, headings: Vec<String>) -> PdfFragmentAccumulator {
    PdfFragmentAccumulator { page_start: page_number, page_end: page_number, headings, blocks: Vec::new() }
  }

  fn push(&mut self, text: String, page_number: usize) {
    self.page_end = page_number;
    self.blocks.push(text);
  }
}

struct PdfPage {
  raw_page_number: Option<usize>,
  text: String,
}

struct ResolvedPdfPage {
  page_number: usize,
  text: String,
}

struct PdfTextBlock {
  page_number: usize,
  headings: Vec<String>,
  text: String,
}

async fn load_image_tag_artifact(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<StoredImageTagArtifact>> {
  let path = image_tag_text_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "image-tag artifact").await
}

async fn load_geo_artifact(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<Option<StoredGeoArtifact>> {
  let path = geo_content_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "geo artifact").await
}

async fn read_json_if_exists<T: DeserializeOwned>(path: &PathBuf, artifact_label: &str) -> InfuResult<Option<T>> {
  let bytes = match fs::read(path).await {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Could not read {} '{}': {}", artifact_label, path.display(), error).into()),
  };

  serde_json::from_slice(&bytes)
    .map(Some)
    .map_err(|error| format!("Could not parse {} '{}': {}", artifact_label, path.display(), error).into())
}

fn build_image_fragment_text(
  title: Option<&str>,
  context_title: Option<&str>,
  item_dimensions: Option<(i64, i64)>,
  image_tag_artifact: Option<&StoredImageTagArtifact>,
  geo_artifact: Option<&StoredGeoArtifact>,
) -> Option<String> {
  let mut sentences = Vec::new();

  let title = normalized_text(title);
  let context_title = normalized_text(context_title)
    .filter(|context| title.as_deref().map(|title| title.to_lowercase() != context.to_lowercase()).unwrap_or(true));

  if let Some(title) = title {
    sentences.push(labeled_sentence("Title", &title));
  }
  if let Some(context_title) = context_title {
    sentences.push(labeled_sentence("Context", &context_title));
  }

  if let Some(image_tag_artifact) = image_tag_artifact {
    if let Some(scene) = normalized_text(image_tag_artifact.scene.as_deref()) {
      sentences.push(labeled_sentence("Scene", &scene));
    }
    if let Some(caption) = normalized_text(image_tag_artifact.detailed_caption.as_deref()) {
      sentences.push(labeled_sentence("Description", &caption));
    }

    let ocr_text = normalized_text_list(&image_tag_artifact.ocr_text);
    if !ocr_text.is_empty() {
      sentences.push(labeled_sentence("Visible text", &ocr_text.join("; ")));
    }

    let tags = normalized_text_list(&image_tag_artifact.tags);
    if !tags.is_empty() {
      sentences.push(labeled_sentence("Tags", &tags.join(", ")));
    }

    if let Some(face_count) = positive_face_count(image_tag_artifact.visible_face_count_estimate.as_deref()) {
      sentences.push(labeled_sentence("Visible faces", &face_count.to_string()));
    }
  }

  if let Some(location) = best_geo_location_text(geo_artifact) {
    sentences.push(labeled_sentence("Location", &location));
  } else if let Some((lat, lon)) = best_coordinate_pair(image_tag_artifact, geo_artifact) {
    sentences.push(labeled_sentence("Coordinates", &format!("{lat:.6}, {lon:.6}")));
  }

  if let Some(location_codes) = best_geo_location_codes(geo_artifact) {
    sentences.push(labeled_sentence("Location codes", &location_codes.join(", ")));
  }

  if let Some(captured_at) = image_tag_artifact
    .and_then(|artifact| artifact.image_metadata.as_ref())
    .and_then(|metadata| normalized_text(metadata.captured_at.as_deref()))
  {
    sentences.push(labeled_sentence("Captured at", &captured_at));
  }

  if let Some(camera) =
    image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()).and_then(camera_description)
  {
    sentences.push(labeled_sentence("Camera", &camera));
  }

  if let Some((width, height)) = best_image_dimensions(item_dimensions, image_tag_artifact) {
    sentences.push(labeled_sentence("Dimensions", &format!("{width}x{height}")));
  }

  if sentences.is_empty() { None } else { Some(sentences.join("\n")) }
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

fn normalized_text(value: Option<&str>) -> Option<String> {
  let value = value?;
  let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
  if collapsed.is_empty() { None } else { Some(collapsed) }
}

fn normalized_text_list(values: &[String]) -> Vec<String> {
  let mut out = Vec::new();
  let mut seen = HashSet::new();

  for value in values {
    let Some(normalized) = normalized_text(Some(value.as_str())) else {
      continue;
    };
    let key = normalized.to_lowercase();
    if seen.insert(key) {
      out.push(normalized);
    }
  }

  out
}

fn positive_face_count(value: Option<&str>) -> Option<usize> {
  let parsed = value?.trim().parse::<usize>().ok()?;
  (parsed > 0).then_some(parsed)
}

fn best_geo_location_text(geo_artifact: Option<&StoredGeoArtifact>) -> Option<String> {
  let best_result = geo_artifact?.results.first()?;
  normalized_text(best_result.formatted.as_deref()).or_else(|| {
    let mut parts = Vec::new();
    if let Some(name) = normalized_text(best_result.name.as_deref()) {
      parts.push(name);
    }
    if let Some(city) = normalized_text(best_result.city.as_deref()) {
      parts.push(city);
    }
    if let Some(province) = normalized_text(best_result.province.as_deref()) {
      parts.push(province);
    }
    if let Some(country) = normalized_text(best_result.country.as_deref()) {
      parts.push(country);
    }
    if parts.is_empty() { None } else { Some(parts.join(", ")) }
  })
}

fn best_geo_location_codes(geo_artifact: Option<&StoredGeoArtifact>) -> Option<Vec<String>> {
  let best_result = geo_artifact?.results.first()?;
  let mut codes = Vec::new();
  let mut seen = HashSet::new();

  for key in ["iata", "icao"] {
    let Some(value) = best_result.other_names.get(key) else {
      continue;
    };
    let Some(code) = normalized_text(Some(value.as_str())) else {
      continue;
    };
    let normalized_code = code.to_uppercase();
    if seen.insert(normalized_code.clone()) {
      codes.push(normalized_code);
    }
  }

  if codes.is_empty() { None } else { Some(codes) }
}

fn best_coordinate_pair(
  image_tag_artifact: Option<&StoredImageTagArtifact>,
  geo_artifact: Option<&StoredGeoArtifact>,
) -> Option<(f64, f64)> {
  if let Some(metadata) = image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()) {
    if let (Some(lat), Some(lon)) = (metadata.gps_latitude, metadata.gps_longitude) {
      return Some((lat, lon));
    }
  }

  let query = geo_artifact?.query.as_ref()?;
  match (query.lat, query.lon) {
    (Some(lat), Some(lon)) => Some((lat, lon)),
    _ => None,
  }
}

fn camera_description(metadata: &StoredImageMetadata) -> Option<String> {
  let make = normalized_text(metadata.camera_make.as_deref());
  let model = normalized_text(metadata.camera_model.as_deref());

  match (make, model) {
    (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => Some(model),
    (Some(make), Some(model)) => Some(format!("{make} {model}")),
    (Some(make), None) => Some(make),
    (None, Some(model)) => Some(model),
    (None, None) => None,
  }
}

fn best_image_dimensions(
  item_dimensions: Option<(i64, i64)>,
  image_tag_artifact: Option<&StoredImageTagArtifact>,
) -> Option<(i64, i64)> {
  if let Some(metadata) = image_tag_artifact.and_then(|artifact| artifact.image_metadata.as_ref()) {
    if let (Some(width), Some(height)) = (metadata.exif_pixel_width, metadata.exif_pixel_height) {
      return Some((i64::from(width), i64::from(height)));
    }
  }

  item_dimensions.filter(|(width, height)| *width > 0 && *height > 0)
}

#[derive(Default, Deserialize)]
struct StoredImageTagArtifact {
  detailed_caption: Option<String>,
  scene: Option<String>,
  visible_face_count_estimate: Option<String>,
  #[serde(default)]
  tags: Vec<String>,
  #[serde(default)]
  ocr_text: Vec<String>,
  image_metadata: Option<StoredImageMetadata>,
}

#[derive(Default, Deserialize)]
struct StoredImageMetadata {
  captured_at: Option<String>,
  gps_latitude: Option<f64>,
  gps_longitude: Option<f64>,
  camera_make: Option<String>,
  camera_model: Option<String>,
  exif_pixel_width: Option<u32>,
  exif_pixel_height: Option<u32>,
}

#[derive(Default, Deserialize)]
struct StoredGeoArtifact {
  query: Option<StoredGeoQuery>,
  #[serde(default)]
  results: Vec<StoredGeoResult>,
}

#[derive(Default, Deserialize)]
struct StoredPdfTextManifest {
  status: String,
  content_mime_type: String,
}

#[derive(Default, Deserialize)]
struct StoredGeoQuery {
  lat: Option<f64>,
  lon: Option<f64>,
}

#[derive(Default, Deserialize)]
struct StoredGeoResult {
  name: Option<String>,
  formatted: Option<String>,
  city: Option<String>,
  province: Option<String>,
  country: Option<String>,
  #[serde(default)]
  other_names: BTreeMap<String, String>,
}

fn container_child_title_lines(db: &Db, item: &Item) -> Vec<String> {
  ordered_container_children(db, item)
    .into_iter()
    .flat_map(|child| fragment_lines_for_display_item(db, child))
    .collect()
}

fn ordered_container_children<'a>(db: &'a Db, item: &Item) -> Vec<&'a Item> {
  let mut children = db.item.get_children(&item.id).unwrap_or_default();
  match item.item_type {
    ItemType::Page => match item.arrange_algorithm {
      Some(ArrangeAlgorithm::SpatialStretch) => {
        children.sort_by(|a, b| compare_spatial_position(a, b).then_with(|| compare_item_order(a, b)));
      }
      Some(ArrangeAlgorithm::Calendar) => {
        children.sort_by(|a, b| a.datetime.cmp(&b.datetime).then_with(|| compare_item_order(a, b)));
      }
      _ => sort_children_for_display(db, item, &mut children),
    },
    ItemType::Table | ItemType::Composite => sort_children_for_display(db, item, &mut children),
    _ => {}
  }
  children
}

fn sort_children_for_display(db: &Db, container: &Item, children: &mut Vec<&Item>) {
  let order_children_by = container.order_children_by.as_deref().unwrap_or_default();
  let use_title_sort = order_children_by == "title[ASC]"
    && !(container.item_type == ItemType::Page && container.arrange_algorithm == Some(ArrangeAlgorithm::Document));

  if use_title_sort {
    children.sort_by(|a, b| compare_items_by_display_title(db, a, b));
  } else {
    children.sort_by(|a, b| compare_item_order(a, b));
  }
}

fn compare_items_by_display_title(db: &Db, a: &Item, b: &Item) -> Ordering {
  let a_resolved = resolved_link_target(db, a);
  let b_resolved = resolved_link_target(db, b);

  let a_is_unresolved = a.item_type == ItemType::Link && a_resolved.is_none();
  let b_is_unresolved = b.item_type == ItemType::Link && b_resolved.is_none();

  match (a_is_unresolved, b_is_unresolved) {
    (true, false) => Ordering::Greater,
    (false, true) => Ordering::Less,
    _ => display_title_for_sort(a_resolved.unwrap_or(a))
      .cmp(&display_title_for_sort(b_resolved.unwrap_or(b)))
      .then_with(|| a.id.cmp(&b.id)),
  }
}

fn compare_item_order(a: &Item, b: &Item) -> Ordering {
  compare_ordering_bytes(&a.ordering, &b.ordering).then_with(|| a.id.cmp(&b.id))
}

fn compare_spatial_position(a: &Item, b: &Item) -> Ordering {
  let (a_y, a_x) = item_position_sort_key(a);
  let (b_y, b_x) = item_position_sort_key(b);
  a_y.cmp(&b_y).then(a_x.cmp(&b_x))
}

fn item_position_sort_key(item: &Item) -> (i64, i64) {
  item.spatial_position_gr.as_ref().map(|pos| (pos.y, pos.x)).unwrap_or((0, 0))
}

fn compare_ordering_bytes(a: &Vec<u8>, b: &Vec<u8>) -> Ordering {
  match compare_orderings(a, b) {
    -1 => Ordering::Less,
    1 => Ordering::Greater,
    _ => Ordering::Equal,
  }
}

fn display_title_for_sort(item: &Item) -> String {
  item.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("").to_lowercase()
}

fn fragment_lines_for_display_item(db: &Db, item: &Item) -> Vec<String> {
  if item.item_type == ItemType::Link {
    return resolved_link_target(db, item)
      .map(|target| fragment_lines_for_non_link_item(db, target))
      .unwrap_or_default();
  }
  fragment_lines_for_non_link_item(db, item)
}

fn fragment_lines_for_non_link_item(db: &Db, item: &Item) -> Vec<String> {
  match item.item_type {
    ItemType::Composite => ordered_container_children(db, item)
      .into_iter()
      .flat_map(|child| fragment_lines_for_display_item(db, child))
      .collect(),
    _ => item
      .title
      .as_deref()
      .map(str::trim)
      .filter(|title| !title.is_empty())
      .map(|title| vec![title.to_owned()])
      .unwrap_or_default(),
  }
}

fn resolved_link_target<'a>(db: &'a Db, item: &Item) -> Option<&'a Item> {
  if item.item_type != ItemType::Link {
    return None;
  }
  item.link_to.as_ref().and_then(|target_id| db.item.get(target_id).ok())
}

fn container_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, false)
}

fn embedding_context_title_for_item(db: &Db, item: &Item) -> Option<String> {
  parent_title_for_item(db, item, true)
}

fn parent_title_for_item(db: &Db, item: &Item, include_attachment_parents: bool) -> Option<String> {
  match item.relationship_to_parent {
    RelationshipToParent::Child => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment if include_attachment_parents => titled_non_system_parent(db, item),
    RelationshipToParent::Attachment | RelationshipToParent::NoParent => None,
  }
}

fn titled_non_system_parent(db: &Db, item: &Item) -> Option<String> {
  let parent_id = item.parent_id.as_ref()?;
  let user = db.user.get(&item.owner_id)?;
  if parent_id == &user.home_page_id || parent_id == &user.trash_page_id || parent_id == &user.dock_page_id {
    return None;
  }
  let parent = db.item.get(parent_id).ok()?;
  normalized_text(parent.title.as_deref())
}

fn image_tag_text_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_text", item_id));
  Ok(path)
}

fn pdf_text_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_text", item_id));
  Ok(path)
}

fn pdf_manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_manifest.json", item_id));
  Ok(path)
}

fn geo_content_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_geo.json", item_id));
  Ok(path)
}

fn text_shard_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("text");
  path.push(&item_id[..2]);
  Ok(path)
}

#[cfg(test)]
mod tests {
  use super::{
    StoredGeoArtifact, StoredGeoQuery, StoredGeoResult, StoredImageMetadata, StoredImageTagArtifact,
    build_image_fragment_text, build_pdf_fragment_inputs, resolve_pdf_pages, sanitize_markdown_inline,
    split_pdf_markdown_pages,
  };
  use std::collections::BTreeMap;

  #[test]
  fn builds_image_fragment_text_from_semantic_fields() {
    let tag = StoredImageTagArtifact {
      detailed_caption: Some("An angled view captures a luxurious airplane seat.".to_owned()),
      scene: Some("Airplane cabin interior".to_owned()),
      visible_face_count_estimate: Some("0".to_owned()),
      tags: vec!["airplane".to_owned(), "business class".to_owned(), "travel".to_owned()],
      ocr_text: vec!["SAWASDEE".to_owned(), "Adventures for the Soul".to_owned()],
      image_metadata: Some(StoredImageMetadata {
        captured_at: Some("2025-12-03T08:24:45.233+07:00".to_owned()),
        gps_latitude: Some(13.682677777777776),
        gps_longitude: Some(100.74934444444445),
        camera_make: Some("Apple".to_owned()),
        camera_model: Some("iPhone 15 Pro".to_owned()),
        exif_pixel_width: Some(4032),
        exif_pixel_height: Some(3024),
      }),
    };

    let mut other_names = BTreeMap::new();
    other_names.insert("iata".to_owned(), "BKK".to_owned());
    other_names.insert("icao".to_owned(), "VTBS".to_owned());

    let geo = StoredGeoArtifact {
      query: Some(StoredGeoQuery { lat: Some(13.682677777777776), lon: Some(100.74934444444445) }),
      results: vec![StoredGeoResult {
        name: Some("Suvarnabhumi Airport".to_owned()),
        formatted: Some("Suvarnabhumi Airport, Kingkaew 31/2, Racha Thewa Subdistrict, 10520, Thailand".to_owned()),
        city: Some("Racha Thewa Subdistrict".to_owned()),
        province: Some("Samut Prakan Province".to_owned()),
        country: Some("Thailand".to_owned()),
        other_names,
      }],
    };

    let text = build_image_fragment_text(
      Some("Thai Airways Business Class Seat"),
      Some("Bangkok Trip"),
      Some((1200, 800)),
      Some(&tag),
      Some(&geo),
    )
    .unwrap();

    assert!(text.contains("Title: Thai Airways Business Class Seat."));
    assert!(text.contains("Context: Bangkok Trip."));
    assert!(text.contains("Scene: Airplane cabin interior."));
    assert!(text.contains("Description: An angled view captures a luxurious airplane seat."));
    assert!(text.contains("Visible text: SAWASDEE; Adventures for the Soul."));
    assert!(text.contains("Tags: airplane, business class, travel."));
    assert!(text.contains("Location: Suvarnabhumi Airport, Kingkaew 31/2, Racha Thewa Subdistrict, 10520, Thailand."));
    assert!(text.contains("Location codes: BKK, VTBS."));
    assert!(text.contains("Captured at: 2025-12-03T08:24:45.233+07:00."));
    assert!(text.contains("Camera: Apple iPhone 15 Pro."));
    assert!(text.contains("Dimensions: 4032x3024."));
  }

  #[test]
  fn falls_back_to_coordinates_and_positive_face_count() {
    let tag = StoredImageTagArtifact {
      detailed_caption: None,
      scene: None,
      visible_face_count_estimate: Some("2".to_owned()),
      tags: vec![],
      ocr_text: vec![],
      image_metadata: Some(StoredImageMetadata {
        captured_at: None,
        gps_latitude: Some(1.25),
        gps_longitude: Some(103.75),
        camera_make: None,
        camera_model: None,
        exif_pixel_width: None,
        exif_pixel_height: None,
      }),
    };

    let text = build_image_fragment_text(Some("Family photo"), None, Some((1600, 900)), Some(&tag), None).unwrap();

    assert!(text.contains("Title: Family photo."));
    assert!(text.contains("Visible faces: 2."));
    assert!(text.contains("Coordinates: 1.250000, 103.750000."));
    assert!(text.contains("Dimensions: 1600x900."));
  }

  #[test]
  fn returns_none_when_no_embedding_useful_text_exists() {
    let text = build_image_fragment_text(None, None, None, None, None);
    assert!(text.is_none());
  }

  #[test]
  fn sanitizes_markdown_links_for_pdf_embeddings() {
    let text = sanitize_markdown_inline(
      "**chatgpt.com**[/c/6923](https://chatgpt.com/c/6923) and [American Express](https://www.americanexpress.com/en-ca/travel/discover/property/Vietnam/Ninh-Hoa/six-senses-ninh-van-bay#:~:text=At)",
    );

    assert!(text.contains("chatgpt.com"));
    assert!(text.contains("American Express"));
    assert!(!text.contains("https://"));
    assert!(!text.contains("/c/6923"));
    assert!(!text.contains("#:~:text"));
  }

  #[test]
  fn resolves_zero_based_pdf_page_markers_to_human_page_numbers() {
    let pages = resolve_pdf_pages(split_pdf_markdown_pages("{0}--------\nFirst page\n\n{1}--------\nSecond page"));

    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].page_number, 1);
    assert_eq!(pages[1].page_number, 2);
  }

  #[test]
  fn builds_multiple_pdf_fragments_without_full_urls() {
    let markdown = r#"
{0}------------------------------------------------

# **Best agent for resorts**

**chatgpt.com**[/c/6923be50-86f0-8321-a4d5-c1c38e42d63a](https://chatgpt.com/c/6923be50-86f0-8321-a4d5-c1c38e42d63a)

### **Six Senses Ninh Van Bay - Agents, Deals & Relationships**

- **QX Travel** This agency is an IHG-preferred advisor. Guests receive a US$100 property credit, daily breakfast for two, upgrades, and late checkout [qxtravel.io](https://www.qxtravel.io/properties/amanoi#:~:text=Enjoy%20amazing%20benefits).
- **Lyxresan Travels** As a Virtuoso affiliate, Lyxresan offers complimentary breakfast, room upgrades, early check-in, and a special perk such as a complimentary massage [lyxresantravels.com](https://lyxresantravels.com/en/six-senses/#:~:text=Six%20Senses%20Ninh%20Van%20Bay).
- **American Express Fine Hotels + Resorts** FHR bookings provide noon check-in, daily breakfast for two, a unique US$100 property credit, and a guaranteed 4 p.m. checkout [americanexpress.com](https://www.americanexpress.com/en-ca/travel/discover/property/Vietnam/Ninh-Hoa/six-senses-ninh-van-bay#:~:text=At%20Six%20Senses).

{1}------------------------------------------------

- **Mr & Mrs Smith** This boutique-hotel club frequently offers deep discounts, breakfast, and an extra such as champagne or a spa treatment [mrandmrssmith.com](https://www.mrandmrssmith.com/luxury-hotels/six-senses-ninh-van-bay/offers#:~:text=Smith%20Member%20Exclusive).
- **ASmallWorld Premium** Members gain access to an exclusive VIP rate with room upgrades, hotel credit, early check-in and special discounted rates [asmallworld.com](https://www.asmallworld.com/collection/hotels/six-senses-ninh-van-bay#:~:text=VIP%20Rate).

### **Which agent is best for Six Senses Ninh Van Bay?**

- **For loyalty benefits and preferential treatment:** book through QX Travel or another Virtuoso advisor because those channels can stack perks with direct-hotel style treatment.
- **For substantial discounts:** PrivateUpgrades and Mr & Mrs Smith often run promotions, so use them when price matters more than earning points.
- **For cardholders seeking guaranteed late checkout:** Amex FHR may be ideal because it offers a guaranteed 4 p.m. checkout and a US$100 credit.
"#;

    let fragments = build_pdf_fragment_inputs(Some("Best agent for resorts"), Some("Travel research"), markdown);

    assert!(fragments.len() >= 3);
    assert_eq!(fragments[0].page_start, Some(1));
    assert!(fragments.iter().any(|fragment| fragment.page_start == Some(2)));
    assert!(fragments.iter().all(|fragment| fragment.text.contains("Document: Best agent for resorts.")));
    assert!(fragments.iter().all(|fragment| fragment.text.contains("Context: Travel research.")));
    assert!(fragments.iter().all(|fragment| !fragment.text.contains("https://")));
    assert!(fragments.iter().all(|fragment| !fragment.text.contains("#:~:text")));
    assert!(fragments.iter().any(|fragment| fragment.text.contains("Page: 1.")));
    assert!(fragments.iter().any(|fragment| fragment.text.contains("Page: 2.")));
    assert!(
      fragments
        .iter()
        .any(|fragment| fragment.text.contains("Section: Six Senses Ninh Van Bay - Agents, Deals & Relationships."))
    );
  }
}
