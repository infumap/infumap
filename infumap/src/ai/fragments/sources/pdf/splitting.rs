use super::super::normalized_text;
use super::{
  PDF_FRAGMENT_HARD_LIMIT_CHARS, PDF_FRAGMENT_HARD_LIMIT_TOKENS, PDF_FRAGMENT_SOFT_LIMIT_CHARS,
  PDF_FRAGMENT_SOFT_LIMIT_TOKENS,
};

const EMBEDDING_TOKEN_ESTIMATE_CHARS_PER_TOKEN: usize = 4;

pub(super) fn split_pdf_block_text(text: &str) -> Vec<String> {
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

pub(super) fn estimate_embedding_token_count(text: &str) -> usize {
  let char_based = text.chars().count().div_ceil(EMBEDDING_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  let word_based = text.split_whitespace().count();
  char_based.max(word_based)
}
