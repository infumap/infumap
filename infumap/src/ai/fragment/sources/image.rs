use std::collections::{BTreeMap, HashSet};

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::ai::artifact_paths::{item_geo_content_path, item_text_content_path};

use super::{FragmentSource, FragmentSourceKind, normalized_text, read_json_if_exists, single_fragment_source};

const IMAGE_DOCUMENT_LEXICAL_CONFIDENCE_THRESHOLD: f64 = 0.9;

pub async fn image_fragment_source_for_item(
  data_dir: &str,
  item: &Item,
  context_title: Option<String>,
) -> InfuResult<Option<FragmentSource>> {
  let image_tag_artifact = load_image_tag_artifact(data_dir, &item.owner_id, &item.id).await?;
  let geo_artifact = load_geo_artifact(data_dir, &item.owner_id, &item.id).await?;
  let fragment_text = build_image_fragment_text(
    item.title.as_deref(),
    context_title.as_deref(),
    image_tag_artifact.as_ref(),
    geo_artifact.as_ref(),
  );

  Ok(
    fragment_text
      .map(|source_text| single_fragment_source(image_fragment_source_kind(image_tag_artifact.as_ref()), source_text)),
  )
}

async fn load_image_tag_artifact(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Option<StoredImageTagArtifact>> {
  let path = item_text_content_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "image-tag artifact").await
}

async fn load_geo_artifact(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<Option<StoredGeoArtifact>> {
  let path = item_geo_content_path(data_dir, user_id, item_id)?;
  read_json_if_exists(&path, "geo artifact").await
}

fn build_image_fragment_text(
  title: Option<&str>,
  context_title: Option<&str>,
  image_tag_artifact: Option<&StoredImageTagArtifact>,
  geo_artifact: Option<&StoredGeoArtifact>,
) -> Option<String> {
  let mut upper_lines = Vec::new();
  let mut lower_lines = Vec::new();

  let title = embedding_useful_image_title(title);
  let context_title = normalized_text(context_title)
    .filter(|context| title.as_deref().map(|title| title.to_lowercase() != context.to_lowercase()).unwrap_or(true));

  if let Some(image_tag_artifact) = image_tag_artifact {
    if let Some(scene) = normalized_text(image_tag_artifact.scene.as_deref()) {
      upper_lines.push(scene);
    }
    if let Some(caption) = normalized_text(image_tag_artifact.detailed_caption.as_deref()) {
      upper_lines.push(caption);
    }

    let tags = normalized_text_list(&image_tag_artifact.tags);
    if !tags.is_empty() {
      upper_lines.push(labeled_line("Tags", &tags.join(", ")));
    }

    let ocr_text = embedding_visible_text(&image_tag_artifact.ocr_text, image_tag_artifact.document_confidence);
    if !ocr_text.is_empty() {
      lower_lines.push(labeled_line("Visible text", &ocr_text.join("; ")));
    }
  }

  if let Some(location) = best_geo_location_text(geo_artifact) {
    lower_lines.push(labeled_line("Location", &location));
  }

  if let Some(location_codes) = best_geo_location_codes(geo_artifact) {
    lower_lines.push(labeled_line("Location codes", &location_codes.join(", ")));
  }

  if let Some(captured_at) = image_tag_artifact
    .and_then(|artifact| artifact.image_metadata.as_ref())
    .and_then(|metadata| metadata.captured_at.as_deref())
    .and_then(format_image_capture_date)
  {
    lower_lines.push(labeled_line("Date", &captured_at));
  }

  if let Some(context_title) = context_title {
    lower_lines.push(labeled_line("Context", &context_title));
  }
  if let Some(title) = title {
    lower_lines.push(labeled_line("Title", &title));
  }

  let mut sections = Vec::new();
  if !upper_lines.is_empty() {
    sections.push(upper_lines.join("\n"));
  }
  if !lower_lines.is_empty() {
    sections.push(lower_lines.join("\n"));
  }

  if sections.is_empty() { None } else { Some(sections.join("\n\n")) }
}

fn labeled_line(label: &str, value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }
  format!("{label}: {trimmed}")
}

fn embedding_useful_image_title(title: Option<&str>) -> Option<String> {
  let title = normalized_text(title)?;
  (!looks_like_camera_generated_title(&title)).then_some(title)
}

fn looks_like_camera_generated_title(title: &str) -> bool {
  let stem = file_stem_for_title(title);
  let upper = stem.to_ascii_uppercase();
  ["IMG", "DSC", "PXL", "MVIMG", "VID", "MOV", "GOPR", "DJI"]
    .iter()
    .any(|prefix| upper.strip_prefix(prefix).is_some_and(is_camera_generated_suffix))
}

fn file_stem_for_title(title: &str) -> &str {
  let trimmed = title.trim();
  match trimmed.rsplit_once('.') {
    Some((stem, extension))
      if !stem.is_empty()
        && !extension.is_empty()
        && extension.len() <= 5
        && extension.chars().all(|c| c.is_ascii_alphanumeric()) =>
    {
      stem
    }
    _ => trimmed,
  }
}

fn is_camera_generated_suffix(suffix: &str) -> bool {
  let trimmed = suffix.trim_start_matches(['_', '-', ' ']);
  !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit() || matches!(c, '_' | '-'))
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

fn embedding_visible_text(values: &[String], document_confidence: f64) -> Vec<String> {
  let mut out = normalized_text_list(values);
  if document_confidence < 0.85 && out.len() > 2 {
    out.truncate(2);
  }
  out
}

fn image_fragment_source_kind(image_tag_artifact: Option<&StoredImageTagArtifact>) -> FragmentSourceKind {
  if image_tag_artifact
    .is_some_and(|artifact| artifact.document_confidence >= IMAGE_DOCUMENT_LEXICAL_CONFIDENCE_THRESHOLD)
  {
    FragmentSourceKind::ImageDocumentContents
  } else {
    FragmentSourceKind::ImageContents
  }
}

fn format_image_capture_date(value: &str) -> Option<String> {
  let normalized = normalized_text(Some(value))?;

  if let Ok(datetime) = OffsetDateTime::parse(&normalized, &Rfc3339) {
    return Some(format_date_and_month_year(datetime.year(), datetime.month() as u8, datetime.day()));
  }

  parse_leading_iso_date(&normalized)
    .map(|(year, month, day)| format_date_and_month_year(year, month, day))
    .or(Some(normalized))
}

fn parse_leading_iso_date(value: &str) -> Option<(i32, u8, u8)> {
  let date_prefix = value.get(0..10)?;
  let mut parts = date_prefix.split('-');
  let year = parts.next()?.parse::<i32>().ok()?;
  let month = parts.next()?.parse::<u8>().ok()?;
  let day = parts.next()?.parse::<u8>().ok()?;
  if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
    return None;
  }
  Some((year, month, day))
}

fn format_date_and_month_year(year: i32, month: u8, day: u8) -> String {
  format!("{year:04}-{month:02}-{day:02}; {} {year}", month_name(month))
}

fn month_name(month: u8) -> &'static str {
  match month {
    1 => "January",
    2 => "February",
    3 => "March",
    4 => "April",
    5 => "May",
    6 => "June",
    7 => "July",
    8 => "August",
    9 => "September",
    10 => "October",
    11 => "November",
    12 => "December",
    _ => "Unknown",
  }
}

fn best_geo_location_text(geo_artifact: Option<&StoredGeoArtifact>) -> Option<String> {
  let best_result = geo_artifact?.results.first()?;
  let mut parts = Vec::new();
  let mut seen = HashSet::new();

  for value in [best_result.city.as_deref(), best_result.province.as_deref(), best_result.country.as_deref()] {
    let Some(part) = normalized_text(value) else {
      continue;
    };
    let key = part.to_lowercase();
    if seen.insert(key) {
      parts.push(part);
    }
  }

  if parts.is_empty() { None } else { Some(parts.join(", ")) }
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

#[derive(Default, Deserialize)]
struct StoredImageTagArtifact {
  detailed_caption: Option<String>,
  scene: Option<String>,
  #[serde(default)]
  document_confidence: f64,
  #[serde(default)]
  tags: Vec<String>,
  #[serde(default)]
  ocr_text: Vec<String>,
  image_metadata: Option<StoredImageMetadata>,
}

#[derive(Default, Deserialize)]
struct StoredImageMetadata {
  captured_at: Option<String>,
}

#[derive(Default, Deserialize)]
struct StoredGeoArtifact {
  #[serde(default)]
  results: Vec<StoredGeoResult>,
}

#[derive(Default, Deserialize)]
struct StoredGeoResult {
  city: Option<String>,
  province: Option<String>,
  country: Option<String>,
  #[serde(default)]
  other_names: BTreeMap<String, String>,
}
