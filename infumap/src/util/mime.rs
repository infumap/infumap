use mime_sniffer::MimeTypeSniffer;

const APPLICATION_OCTET_STREAM: &str = "application/octet-stream";
const TEXT_PLAIN: &str = "text/plain";

pub fn detect_mime_type(data: &[u8]) -> String {
  if let Some(kind) = infer::get(data) {
    let normalized = normalized_mime_type(kind.mime_type());
    if normalized != "application/xml" {
      return normalized;
    }
  }

  if looks_like_text(data) {
    return detect_text_mime_type(data);
  }

  if let Some(sniffed) = data.sniff_mime_type() {
    let normalized = normalized_mime_type(sniffed);
    if normalized != APPLICATION_OCTET_STREAM {
      return normalized;
    }
  }

  APPLICATION_OCTET_STREAM.to_owned()
}

pub fn normalized_mime_type(raw: &str) -> String {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return APPLICATION_OCTET_STREAM.to_owned();
  }

  let lower = trimmed.to_ascii_lowercase();
  let canonical_input = match lower.as_str() {
    "application/x-gzip" => "application/gzip",
    "application/x-pdf" => "application/pdf",
    "application/x-zip-compressed" => "application/zip",
    "image/jpg" | "image/pjpeg" => "image/jpeg",
    "text/xml" => "application/xml",
    _ => trimmed,
  };

  match canonical_input.parse::<mime::Mime>() {
    Ok(parsed) => parsed.essence_str().to_owned(),
    Err(_) => APPLICATION_OCTET_STREAM.to_owned(),
  }
}

fn looks_like_text(data: &[u8]) -> bool {
  if data.is_empty() || has_text_bom(data) {
    return true;
  }

  if data.contains(&0) {
    return false;
  }

  match std::str::from_utf8(data) {
    Ok(text) => text
      .chars()
      .all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t' | '\u{000C}')),
    Err(_) => false,
  }
}

fn detect_text_mime_type(data: &[u8]) -> String {
  let text = match std::str::from_utf8(trim_utf8_bom(data)) {
    Ok(text) => text.trim(),
    Err(_) => return TEXT_PLAIN.to_owned(),
  };

  if text.is_empty() {
    return TEXT_PLAIN.to_owned();
  }

  if serde_json::from_str::<serde_json::Value>(text).is_ok() {
    return "application/json".to_owned();
  }

  if looks_like_html_document(text) {
    return "text/html".to_owned();
  }

  if let Some(root_tag) = first_xml_root_tag_name(text) {
    if root_tag.eq_ignore_ascii_case("svg") {
      return "image/svg+xml".to_owned();
    }
    return "application/xml".to_owned();
  }

  TEXT_PLAIN.to_owned()
}

fn trim_utf8_bom(data: &[u8]) -> &[u8] {
  if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
    &data[3..]
  } else {
    data
  }
}

fn looks_like_html_document(text: &str) -> bool {
  let lower = text.trim_start().to_ascii_lowercase();
  lower.starts_with("<!doctype html")
    || lower.starts_with("<html")
    || lower.starts_with("<head")
    || lower.starts_with("<body")
}

fn first_xml_root_tag_name(text: &str) -> Option<&str> {
  let bytes = text.as_bytes();
  let mut i = 0;

  while i < bytes.len() {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
      i += 1;
    }

    if i >= bytes.len() || bytes[i] != b'<' {
      return None;
    }

    if bytes[i..].starts_with(b"<?") {
      i = skip_until(bytes, i + 2, b"?>")?;
      continue;
    }

    if bytes[i..].starts_with(b"<!--") {
      i = skip_until(bytes, i + 4, b"-->")?;
      continue;
    }

    if bytes[i..].starts_with(b"<!doctype") || bytes[i..].starts_with(b"<!DOCTYPE") {
      i = skip_until(bytes, i + 2, b">")?;
      continue;
    }

    if bytes[i..].starts_with(b"<![CDATA[") {
      return None;
    }

    i += 1;
    let start = i;
    while i < bytes.len() {
      let c = bytes[i];
      if c.is_ascii_alphanumeric() || matches!(c, b':' | b'_' | b'-' | b'.') {
        i += 1;
      } else {
        break;
      }
    }

    if start == i {
      return None;
    }

    let tag = &text[start..i];
    return Some(match tag.rsplit_once(':') {
      Some((_, local_name)) => local_name,
      None => tag,
    });
  }

  None
}

fn skip_until(bytes: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
  let remainder = bytes.get(start..)?;
  let offset = remainder.windows(needle.len()).position(|window| window == needle)?;
  Some(start + offset + needle.len())
}

fn has_text_bom(data: &[u8]) -> bool {
  data.starts_with(&[0xEF, 0xBB, 0xBF])
    || data.starts_with(&[0xFE, 0xFF])
    || data.starts_with(&[0xFF, 0xFE])
    || data.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
    || data.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
}

#[cfg(test)]
mod tests {
  use super::{detect_mime_type, normalized_mime_type};

  #[test]
  fn normalizes_common_aliases_and_parameters() {
    assert_eq!(normalized_mime_type("Image/JPG"), "image/jpeg");
    assert_eq!(
      normalized_mime_type("text/plain; charset=utf-8"),
      "text/plain"
    );
    assert_eq!(normalized_mime_type("application/x-pdf"), "application/pdf");
    assert_eq!(normalized_mime_type("image/png"), "image/png");
  }

  #[test]
  fn rejects_invalid_mime_type_strings() {
    assert_eq!(normalized_mime_type("not actually mime"), "application/octet-stream");
  }

  #[test]
  fn detects_plain_text() {
    assert_eq!(detect_mime_type(b"hello world\n"), "text/plain");
  }

  #[test]
  fn detects_json() {
    assert_eq!(detect_mime_type(br#"{"a":1}"#), "application/json");
  }

  #[test]
  fn detects_html() {
    assert_eq!(detect_mime_type(b"<!DOCTYPE html><html><body></body></html>"), "text/html");
  }

  #[test]
  fn detects_svg() {
    assert_eq!(
      detect_mime_type(br#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#),
      "image/svg+xml"
    );
  }

  #[test]
  fn detects_xml() {
    assert_eq!(
      detect_mime_type(br#"<?xml version="1.0"?><note></note>"#),
      "application/xml"
    );
  }

  #[test]
  fn detects_svg_after_xml_declaration() {
    assert_eq!(
      detect_mime_type(br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>"#),
      "image/svg+xml"
    );
  }

  #[test]
  fn detects_pdf_signature() {
    assert_eq!(detect_mime_type(b"%PDF-1.5"), "application/pdf");
  }

  #[test]
  fn falls_back_to_octet_stream_for_binary() {
    assert_eq!(
      detect_mime_type(&[0, 159, 146, 150]),
      "application/octet-stream"
    );
  }
}
