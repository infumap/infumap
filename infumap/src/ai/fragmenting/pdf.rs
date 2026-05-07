use std::io::ErrorKind;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::Deserialize;
use tokio::fs;

use crate::ai::artifacts::{item_text_content_path, item_text_manifest_path};
use crate::ai::fragments::{FragmentInput, FragmentSourceKind};

use super::{FragmentSource, labeled_sentence, normalized_text, read_json_if_exists};

const MARKDOWN_CONTENT_MIME_TYPE: &str = "text/markdown";
const PDF_FRAGMENT_MIN_CHARS: usize = 500;
const PDF_FRAGMENT_SOFT_LIMIT_CHARS: usize = 1400;
const PDF_FRAGMENT_HARD_LIMIT_CHARS: usize = 1900;
const PDF_FRAGMENT_SOFT_LIMIT_TOKENS: usize = 380;
const PDF_FRAGMENT_HARD_LIMIT_TOKENS: usize = 440;
const EMBEDDING_TOKEN_ESTIMATE_CHARS_PER_TOKEN: usize = 4;
const PDF_PAGE_BREAK_MIN_DASH_COUNT: usize = 8;

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

async fn load_pdf_markdown_artifact(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<Option<String>> {
  let Some(manifest) = load_pdf_text_manifest(data_dir, user_id, item_id).await? else {
    return Ok(None);
  };
  if manifest.status != "succeeded" || manifest.content_mime_type != MARKDOWN_CONTENT_MIME_TYPE {
    return Ok(None);
  }

  let path = item_text_content_path(data_dir, user_id, item_id)?;
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
  let path = item_text_manifest_path(data_dir, user_id, item_id)?;
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
    let should_flush = current.as_ref().is_some_and(|current| {
      should_flush_pdf_fragment(
        document_title.as_deref(),
        context_title.as_deref(),
        current,
        next_block,
        &prepared_blocks[index..],
      )
    });

    if should_flush {
      push_pdf_fragment_input(&mut fragments, current.take(), document_title.as_deref(), context_title.as_deref());
    }

    let current_fragment = current.get_or_insert_with(|| PdfFragmentAccumulator::new(next_block.page_number));
    current_fragment.push(next_block.clone());
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
  let text =
    render_pdf_fragment_text(document_title, context_title, fragment.page_start, fragment.page_end, &fragment.blocks);
  if text.trim().is_empty() {
    return;
  }
  out.push(FragmentInput::new(text).with_page_range(Some(fragment.page_start), Some(fragment.page_end)));
}

fn should_flush_pdf_fragment(
  document_title: Option<&str>,
  context_title: Option<&str>,
  current: &PdfFragmentAccumulator,
  next_block: &PdfFragmentBlock,
  upcoming_blocks: &[PdfFragmentBlock],
) -> bool {
  let continues_same_heading =
    current.blocks.last().map(|block| heading_paths_equal(&block.headings, &next_block.headings)).unwrap_or(false);
  let current_len = rendered_pdf_fragment_len(
    document_title,
    context_title,
    current.page_start,
    current.page_end,
    &current.blocks,
    None,
  );
  let candidate_len = rendered_pdf_fragment_len(
    document_title,
    context_title,
    current.page_start,
    next_block.page_number,
    &current.blocks,
    Some(next_block),
  );
  let candidate_tokens = rendered_pdf_fragment_token_estimate(
    document_title,
    context_title,
    current.page_start,
    next_block.page_number,
    &current.blocks,
    Some(next_block),
  );

  if candidate_len > PDF_FRAGMENT_HARD_LIMIT_CHARS || candidate_tokens > PDF_FRAGMENT_HARD_LIMIT_TOKENS {
    return true;
  }

  if continues_same_heading {
    return false;
  }

  if should_flush_before_new_heading_run(document_title, context_title, current, upcoming_blocks, current_len) {
    return true;
  }

  (candidate_len > PDF_FRAGMENT_SOFT_LIMIT_CHARS || candidate_tokens > PDF_FRAGMENT_SOFT_LIMIT_TOKENS)
    && current_len >= PDF_FRAGMENT_MIN_CHARS
}

fn should_flush_before_new_heading_run(
  document_title: Option<&str>,
  context_title: Option<&str>,
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

  let heading_run_render_len = rendered_pdf_fragment_len(
    document_title,
    context_title,
    heading_run_page_start,
    heading_run_page_end,
    heading_run,
    None,
  );
  let heading_run_render_tokens = rendered_pdf_fragment_token_estimate(
    document_title,
    context_title,
    heading_run_page_start,
    heading_run_page_end,
    heading_run,
    None,
  );
  let heading_run_fits_hard_limits = heading_run_render_len <= PDF_FRAGMENT_HARD_LIMIT_CHARS
    && heading_run_render_tokens <= PDF_FRAGMENT_HARD_LIMIT_TOKENS;

  let mut combined_blocks = current.blocks.clone();
  combined_blocks.extend(heading_run.iter().cloned());
  let combined_render_len = rendered_pdf_fragment_len(
    document_title,
    context_title,
    current.page_start,
    heading_run_page_end,
    &combined_blocks,
    None,
  );
  let combined_render_tokens = rendered_pdf_fragment_token_estimate(
    document_title,
    context_title,
    current.page_start,
    heading_run_page_end,
    &combined_blocks,
    None,
  );

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
  document_title: Option<&str>,
  context_title: Option<&str>,
  page_start: usize,
  page_end: usize,
  blocks: &[PdfFragmentBlock],
  next_block: Option<&PdfFragmentBlock>,
) -> usize {
  let mut candidate_blocks = blocks.to_vec();
  if let Some(next_block) = next_block {
    candidate_blocks.push(next_block.clone());
  }
  render_pdf_fragment_text(document_title, context_title, page_start, page_end, &candidate_blocks).len()
}

fn rendered_pdf_fragment_token_estimate(
  document_title: Option<&str>,
  context_title: Option<&str>,
  page_start: usize,
  page_end: usize,
  blocks: &[PdfFragmentBlock],
  next_block: Option<&PdfFragmentBlock>,
) -> usize {
  let mut candidate_blocks = blocks.to_vec();
  if let Some(next_block) = next_block {
    candidate_blocks.push(next_block.clone());
  }
  estimate_embedding_token_count(&render_pdf_fragment_text(
    document_title,
    context_title,
    page_start,
    page_end,
    &candidate_blocks,
  ))
}

fn render_pdf_fragment_text(
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
    lines.push(labeled_sentence("Document", &document_title));
  }

  if let Some(context_title) = context_title.as_deref() {
    lines.push(labeled_sentence("Context", &context_title));
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

fn heading_paths_equal(left: &[String], right: &[String]) -> bool {
  left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn split_pdf_block_text(text: &str) -> Vec<String> {
  let text = text.trim();
  if text.is_empty() {
    return vec![];
  }
  if text.len() <= PDF_FRAGMENT_HARD_LIMIT_CHARS
    && estimate_embedding_token_count(text) <= PDF_FRAGMENT_HARD_LIMIT_TOKENS
  {
    return vec![text.to_owned()];
  }

  let sentences = split_text_into_sentences(text);
  if sentences.len() <= 1 {
    return split_text_by_words(
      text,
      PDF_FRAGMENT_SOFT_LIMIT_CHARS,
      PDF_FRAGMENT_HARD_LIMIT_CHARS,
      PDF_FRAGMENT_SOFT_LIMIT_TOKENS,
      PDF_FRAGMENT_HARD_LIMIT_TOKENS,
    );
  }

  let mut out = Vec::new();
  let mut current = String::new();

  for sentence in sentences {
    if sentence.len() > PDF_FRAGMENT_HARD_LIMIT_CHARS
      || estimate_embedding_token_count(&sentence) > PDF_FRAGMENT_HARD_LIMIT_TOKENS
    {
      if !current.is_empty() {
        out.push(current);
        current = String::new();
      }
      out.extend(split_text_by_words(
        &sentence,
        PDF_FRAGMENT_SOFT_LIMIT_CHARS,
        PDF_FRAGMENT_HARD_LIMIT_CHARS,
        PDF_FRAGMENT_SOFT_LIMIT_TOKENS,
        PDF_FRAGMENT_HARD_LIMIT_TOKENS,
      ));
      continue;
    }

    if current.is_empty() {
      current = sentence;
      continue;
    }

    let candidate = format!("{current} {sentence}");
    if candidate.len() > PDF_FRAGMENT_SOFT_LIMIT_CHARS
      || estimate_embedding_token_count(&candidate) > PDF_FRAGMENT_SOFT_LIMIT_TOKENS
    {
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

fn split_text_by_words(
  text: &str,
  soft_limit_chars: usize,
  hard_limit_chars: usize,
  soft_limit_tokens: usize,
  hard_limit_tokens: usize,
) -> Vec<String> {
  let words = text.split_whitespace().collect::<Vec<&str>>();
  let mut out = Vec::new();
  let mut current = String::new();

  for word in words {
    if word.len() > hard_limit_chars {
      if !current.is_empty() {
        out.push(current);
        current = String::new();
      }
      let mut remaining = word;
      while remaining.len() > hard_limit_chars {
        let split_at = split_index_for_char_budget(remaining, hard_limit_chars);
        out.push(remaining[..split_at].to_owned());
        remaining = &remaining[split_at..];
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

    let candidate = format!("{current} {word}");
    if candidate.len() > soft_limit_chars || estimate_embedding_token_count(&candidate) > soft_limit_tokens {
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
    .into_iter()
    .flat_map(|part| {
      if part.len() > hard_limit_chars || estimate_embedding_token_count(&part) > hard_limit_tokens {
        split_oversized_word_fallback(&part, hard_limit_chars)
      } else {
        vec![part]
      }
    })
    .collect()
}

fn split_oversized_word_fallback(text: &str, hard_limit_chars: usize) -> Vec<String> {
  let mut out = Vec::new();
  let mut remaining = text.trim();

  while !remaining.is_empty() {
    if remaining.len() <= hard_limit_chars {
      out.push(remaining.to_owned());
      break;
    }
    let split_at = split_index_for_char_budget(remaining, hard_limit_chars);
    out.push(remaining[..split_at].to_owned());
    remaining = remaining[split_at..].trim_start();
  }

  out
}

fn split_index_for_char_budget(text: &str, max_chars: usize) -> usize {
  text.char_indices().nth(max_chars).map(|(index, _)| index).unwrap_or(text.len())
}

fn estimate_embedding_token_count(text: &str) -> usize {
  let char_based = text.chars().count().div_ceil(EMBEDDING_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  let word_based = text.split_whitespace().count();
  char_based.max(word_based)
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

#[derive(Clone)]
struct PdfFragmentBlock {
  page_number: usize,
  headings: Vec<String>,
  text: String,
}

struct RenderablePdfBlock {
  headings: Vec<String>,
  body_parts: Vec<String>,
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

#[derive(Default, Deserialize)]
struct StoredPdfTextManifest {
  status: String,
  content_mime_type: String,
}
