use reqwest::Url;

use super::super::normalized_text;
use super::types::{PdfTextBlock, ResolvedPdfPage};

pub(super) fn build_pdf_text_blocks(pages: &[ResolvedPdfPage]) -> Vec<PdfTextBlock> {
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
