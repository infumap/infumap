// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::io::Cursor;
use std::sync::Arc;

use exif::{Exif, In, Tag, Value};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, Rgb, RgbImage};
use infusdk::util::infu::InfuResult;
use log::debug;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

// Decoding and resizing large images is CPU intensive. Bound the number of concurrent image processing tasks,
// leaving one core free so other requests (including image cache hits) continue to be served promptly.
pub static IMAGE_PROCESSING_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| {
  let num_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
  Arc::new(Semaphore::new(num_cores.saturating_sub(1).max(1)))
});

pub const IMAGE_PLACEHOLDER_FORMAT_VERSION: u8 = 1;
const IMAGE_PLACEHOLDER_MAX_DIMENSION_PX: u32 = 40;
// The JPEG header depends on the quality (via the quantization tables), so this can't be changed without
// also changing IMAGE_PLACEHOLDER_FORMAT_VERSION and the header template on the client.
const IMAGE_PLACEHOLDER_JPEG_QUALITY: u8 = 30;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ImageMetadata {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub captured_at: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gps_latitude: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gps_longitude: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gps_altitude_meters: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub gps_direction_degrees: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub camera_make: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub camera_model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lens_make: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub lens_model: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub software: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub orientation: Option<u16>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub exif_pixel_width: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub exif_pixel_height: Option<u32>,
}

impl ImageMetadata {
  fn is_empty(&self) -> bool {
    self.captured_at.is_none()
      && self.gps_latitude.is_none()
      && self.gps_longitude.is_none()
      && self.gps_altitude_meters.is_none()
      && self.gps_direction_degrees.is_none()
      && self.camera_make.is_none()
      && self.camera_model.is_none()
      && self.lens_make.is_none()
      && self.lens_model.is_none()
      && self.software.is_none()
      && self.orientation.is_none()
      && self.exif_pixel_width.is_none()
      && self.exif_pixel_height.is_none()
  }
}

pub fn extract_image_metadata(image_bytes: &[u8]) -> Option<ImageMetadata> {
  let mut original_file_cursor = Cursor::new(image_bytes);
  let exif = exif::Reader::new().read_from_container(&mut original_file_cursor).ok()?;

  let metadata = ImageMetadata {
    captured_at: extract_capture_datetime(&exif),
    gps_latitude: extract_gps_coordinate(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef),
    gps_longitude: extract_gps_coordinate(&exif, Tag::GPSLongitude, Tag::GPSLongitudeRef),
    gps_altitude_meters: extract_gps_altitude(&exif),
    gps_direction_degrees: extract_rational_scalar(&exif, Tag::GPSImgDirection),
    camera_make: extract_ascii_tag(&exif, Tag::Make),
    camera_model: extract_ascii_tag(&exif, Tag::Model),
    lens_make: extract_ascii_tag(&exif, Tag::LensMake),
    lens_model: extract_ascii_tag(&exif, Tag::LensModel),
    software: extract_ascii_tag(&exif, Tag::Software),
    orientation: extract_uint_tag(&exif, Tag::Orientation)
      .and_then(|value| u16::try_from(value).ok())
      .filter(|value| *value > 0),
    exif_pixel_width: extract_uint_tag(&exif, Tag::PixelXDimension),
    exif_pixel_height: extract_uint_tag(&exif, Tag::PixelYDimension),
  };

  if metadata.is_empty() { None } else { Some(metadata) }
}

pub fn get_exif_orientation(image_bytes: Vec<u8>, image_identifier: &str) -> u16 {
  let mut original_file_cursor = Cursor::new(image_bytes);
  let exifreader = exif::Reader::new();
  match exifreader.read_from_container(&mut original_file_cursor) {
    Ok(exif) => match exif.fields().find(|f| f.tag == Tag::Orientation) {
      Some(o) => match &o.value {
        exif::Value::Short(s) => match s.get(0) {
          Some(s) => *s,
          None => {
            debug!("EXIF Orientation value present but not present for image '{}', ignoring.", image_identifier);
            1
          }
        },
        _ => {
          debug!(
            "EXIF Orientation value present but does not have type Short for image '{}', ignoring.",
            image_identifier
          );
          1
        }
      },
      None => 0,
    },
    Err(_e) => 1,
  }
}

fn extract_capture_datetime(exif: &Exif) -> Option<String> {
  [
    (Tag::DateTimeOriginal, Tag::SubSecTimeOriginal, Tag::OffsetTimeOriginal),
    (Tag::DateTimeDigitized, Tag::SubSecTimeDigitized, Tag::OffsetTimeDigitized),
    (Tag::DateTime, Tag::SubSecTime, Tag::OffsetTime),
  ]
  .into_iter()
  .find_map(|(datetime_tag, subsec_tag, offset_tag)| {
    let mut datetime = normalize_exif_datetime(&extract_ascii_tag(exif, datetime_tag)?);

    if let Some(subseconds) = extract_ascii_tag(exif, subsec_tag) {
      let subseconds = subseconds.trim().trim_start_matches('.');
      if !subseconds.is_empty() {
        datetime.push('.');
        datetime.push_str(subseconds);
      }
    }

    if let Some(offset) = extract_ascii_tag(exif, offset_tag) {
      let offset = offset.trim();
      if !offset.is_empty() {
        datetime.push_str(offset);
      }
    }

    Some(datetime)
  })
}

fn extract_gps_coordinate(exif: &Exif, coordinate_tag: Tag, reference_tag: Tag) -> Option<f64> {
  let field = exif.get_field(coordinate_tag, In::PRIMARY)?;
  let values = match &field.value {
    Value::Rational(values) if !values.is_empty() => values,
    _ => return None,
  };

  let mut coordinate = values.first()?.to_f64();
  if let Some(minutes) = values.get(1) {
    coordinate += minutes.to_f64() / 60.0;
  }
  if let Some(seconds) = values.get(2) {
    coordinate += seconds.to_f64() / 3600.0;
  }

  let sign = extract_ascii_tag(exif, reference_tag)
    .and_then(|value| value.chars().next())
    .map(|value| match value.to_ascii_uppercase() {
      'S' | 'W' => -1.0,
      _ => 1.0,
    })
    .unwrap_or(1.0);

  Some(coordinate * sign)
}

fn extract_gps_altitude(exif: &Exif) -> Option<f64> {
  let altitude = extract_rational_scalar(exif, Tag::GPSAltitude)?;
  let altitude_ref = extract_uint_tag(exif, Tag::GPSAltitudeRef).unwrap_or(0);
  if altitude_ref == 1 { Some(-altitude) } else { Some(altitude) }
}

fn extract_rational_scalar(exif: &Exif, tag: Tag) -> Option<f64> {
  let field = exif.get_field(tag, In::PRIMARY)?;
  match &field.value {
    Value::Rational(values) => values.first().map(|value| value.to_f64()),
    Value::SRational(values) => values.first().map(|value| value.to_f64()),
    _ => None,
  }
}

fn extract_uint_tag(exif: &Exif, tag: Tag) -> Option<u32> {
  exif.get_field(tag, In::PRIMARY)?.value.get_uint(0)
}

fn extract_ascii_tag(exif: &Exif, tag: Tag) -> Option<String> {
  let field = exif.get_field(tag, In::PRIMARY)?;
  match &field.value {
    Value::Ascii(values) => {
      let text = String::from_utf8_lossy(values.first()?);
      let normalized = text.trim_matches('\0').trim();
      if normalized.is_empty() { None } else { Some(normalized.to_owned()) }
    }
    _ => None,
  }
}

fn normalize_exif_datetime(value: &str) -> String {
  let normalized = value.trim();
  let Some((date_part, time_part)) = normalized.split_once(' ') else {
    return normalized.to_owned();
  };
  let date_parts = date_part.split(':').collect::<Vec<&str>>();
  if date_parts.len() != 3 {
    return normalized.to_owned();
  }
  format!("{}-{}-{}T{}", date_parts[0], date_parts[1], date_parts[2], time_part.trim())
}

pub fn adjust_image_for_exif_orientation(
  img: DynamicImage,
  exif_orientation: u16,
  image_identifier: &str,
) -> DynamicImage {
  // Good overview on exif rotation values here: https://sirv.com/help/articles/rotate-photos-to-be-upright/
  // 1 = 0 degrees: the correct orientation, no adjustment is required.
  // 2 = 0 degrees, mirrored: image has been flipped back-to-front.
  // 3 = 180 degrees: image is upside down.
  // 4 = 180 degrees, mirrored: image has been flipped back-to-front and is upside down.
  // 5 = 90 degrees: image has been flipped back-to-front and is on its side.
  // 6 = 90 degrees, mirrored: image is on its side.
  // 7 = 270 degrees: image has been flipped back-to-front and is on its far side.
  // 8 = 270 degrees, mirrored: image is on its far side.
  let mut img = img;
  match exif_orientation {
    0 => {} // Invalid, but silently ignore. It's relatively common.
    1 => {}
    2 => {
      img = img.fliph();
    }
    3 => {
      img = img.rotate180();
    }
    4 => {
      img = img.fliph();
      img = img.rotate180();
    }
    5 => {
      img = img.rotate90();
      img = img.fliph();
    }
    6 => {
      img = img.rotate90();
    }
    7 => {
      img = img.rotate270();
      img = img.fliph();
    }
    8 => {
      img = img.rotate270();
    }
    o => {
      debug!("Unexpected EXIF orientation {} for image '{}'.", o, image_identifier);
    }
  }
  img
}

const LEGACY_PNG_PLACEHOLDER_BASE64_PREFIX: &str = "iVBORw0KGgo";

/// Whether an image item thumbnail is missing, or in the legacy (8x8 PNG) format, so should be replaced by a
/// placeholder created by create_image_placeholder.
pub fn is_legacy_image_placeholder(thumbnail: Option<&str>) -> bool {
  match thumbnail {
    None => true,
    Some(t) => t.is_empty() || t.starts_with(LEGACY_PNG_PLACEHOLDER_BASE64_PREFIX),
  }
}

/// Create the small placeholder image embedded in image items (the "thumbnail" field), displayed whilst
/// the image itself loads. img should already be adjusted for EXIF orientation.
///
/// The placeholder is a JPEG at most IMAGE_PLACEHOLDER_MAX_DIMENSION_PX on its longest side, stored as:
///   [version (1 byte)][width (1 byte)][height (1 byte)][JPEG entropy-coded data]
/// The JPEG header (everything up to and including the SOS segment) is identical for all placeholders of a
/// given version, except for the dimensions in the SOF0 segment, so it is not stored. The client reconstructs
/// the JPEG from a header template: see web/src/util/imagePlaceholder.ts.
pub fn create_image_placeholder(img: &DynamicImage) -> InfuResult<Vec<u8>> {
  let jpeg = encode_image_placeholder_jpeg(img)?;
  let header_len = jpeg_header_len(&jpeg)?;
  if !jpeg.ends_with(&[0xFF, 0xD9]) {
    return Err("Placeholder JPEG does not end with an EOI marker.".into());
  }
  let (width, height) = jpeg_sof0_dimensions(&jpeg[..header_len])?;
  let mut result = Vec::with_capacity(3 + jpeg.len() - header_len - 2);
  result.push(IMAGE_PLACEHOLDER_FORMAT_VERSION);
  result.push(width as u8);
  result.push(height as u8);
  result.extend_from_slice(&jpeg[header_len..jpeg.len() - 2]);
  Ok(result)
}

fn encode_image_placeholder_jpeg(img: &DynamicImage) -> InfuResult<Vec<u8>> {
  let max = IMAGE_PLACEHOLDER_MAX_DIMENSION_PX;
  // thumbnail averages all source pixels contributing to each target pixel (box filter), which is fast and
  // appropriate for a large reduction. It would scale up small images, so don't use it for those.
  let small = if img.width() > max || img.height() > max { img.thumbnail(max, max) } else { img.clone() };
  // Always encode 3 channels, so the header is the same for all images. Flatten any alpha onto white.
  let rgba = small.to_rgba8();
  let rgb = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
    let p = rgba.get_pixel(x, y).0;
    let a = p[3] as u32;
    Rgb([0, 1, 2].map(|c| ((p[c] as u32 * a + 255 * (255 - a) + 127) / 255) as u8))
  });
  let mut jpeg = Vec::new();
  JpegEncoder::new_with_quality(&mut jpeg, IMAGE_PLACEHOLDER_JPEG_QUALITY)
    .encode_image(&rgb)
    .map_err(|e| format!("Could not encode placeholder JPEG: {}", e))?;
  Ok(jpeg)
}

/// Length of the JPEG header: everything up to and including the SOS segment.
fn jpeg_header_len(jpeg: &[u8]) -> InfuResult<usize> {
  if !jpeg.starts_with(&[0xFF, 0xD8]) {
    return Err("JPEG does not start with an SOI marker.".into());
  }
  let mut i = 2;
  while i + 4 <= jpeg.len() {
    if jpeg[i] != 0xFF {
      return Err(format!("Expecting a JPEG marker at offset {}.", i).into());
    }
    let marker = jpeg[i + 1];
    let segment_len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
    i += 2 + segment_len;
    if marker == 0xDA {
      return if i <= jpeg.len() { Ok(i) } else { Err("Truncated JPEG SOS segment.".into()) };
    }
  }
  Err("JPEG has no SOS segment.".into())
}

/// Offset of the SOF0 marker in a JPEG header.
fn jpeg_sof0_offset(header: &[u8]) -> InfuResult<usize> {
  header.windows(2).position(|w| w == [0xFF, 0xC0]).ok_or("JPEG header has no SOF0 segment.".into())
}

fn jpeg_sof0_dimensions(header: &[u8]) -> InfuResult<(u16, u16)> {
  let sof = jpeg_sof0_offset(header)?;
  let height = u16::from_be_bytes([header[sof + 5], header[sof + 6]]);
  let width = u16::from_be_bytes([header[sof + 7], header[sof + 8]]);
  Ok((width, height))
}

#[cfg(test)]
mod tests {
  use super::*;
  use base64::{Engine as _, engine::general_purpose};
  use image::RgbaImage;

  const CLIENT_SOURCE: &str = include_str!("../../../web/src/util/imagePlaceholder.ts");

  fn test_image(w: u32, h: u32) -> DynamicImage {
    DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
      Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, ((x + y) % 256) as u8])
    }))
  }

  fn header_template(jpeg: &[u8]) -> Vec<u8> {
    let mut header = jpeg[..jpeg_header_len(jpeg).unwrap()].to_vec();
    let sof = jpeg_sof0_offset(&header).unwrap();
    header[sof + 5..sof + 9].fill(0);
    header
  }

  fn client_header_template() -> Vec<u8> {
    let marker = "PLACEHOLDER_V1_JPEG_HEADER_BASE64 =";
    let start = CLIENT_SOURCE.find(marker).expect("header template not found in client source") + marker.len();
    let rest = &CLIENT_SOURCE[start..];
    let open = rest.find('"').unwrap() + 1;
    let close = open + rest[open..].find('"').unwrap();
    general_purpose::STANDARD.decode(&rest[open..close]).unwrap()
  }

  /// Mirrors the client reconstruction in web/src/util/imagePlaceholder.ts.
  fn reconstruct_jpeg(placeholder: &[u8]) -> Vec<u8> {
    let mut jpeg = client_header_template();
    let sof = jpeg_sof0_offset(&jpeg).unwrap();
    jpeg[sof + 5..sof + 7].copy_from_slice(&(placeholder[2] as u16).to_be_bytes());
    jpeg[sof + 7..sof + 9].copy_from_slice(&(placeholder[1] as u16).to_be_bytes());
    jpeg.extend_from_slice(&placeholder[3..]);
    jpeg.extend_from_slice(&[0xFF, 0xD9]);
    jpeg
  }

  #[test]
  fn placeholder_header_matches_client_template() {
    // If this fails after an image crate upgrade, the encoder output has changed. Either keep the old
    // behavior, or bump IMAGE_PLACEHOLDER_FORMAT_VERSION and add a new header template to the client.
    let client = client_header_template();
    for (w, h) in [(4000, 3000), (3000, 4000), (40, 40), (7, 3), (1000, 10)] {
      let jpeg = encode_image_placeholder_jpeg(&test_image(w, h)).unwrap();
      assert_eq!(header_template(&jpeg), client, "header mismatch for {}x{} source image", w, h);
    }
  }

  #[test]
  fn placeholder_roundtrip() {
    for ((w, h), (ew, eh)) in
      [((4032, 3024), (40, 30)), ((3024, 4032), (30, 40)), ((20, 10), (20, 10)), ((4000, 10), (40, 1))]
    {
      let placeholder = create_image_placeholder(&test_image(w, h)).unwrap();
      assert_eq!(placeholder[0], IMAGE_PLACEHOLDER_FORMAT_VERSION);
      assert_eq!((placeholder[1] as u32, placeholder[2] as u32), (ew, eh));
      let decoded = image::load_from_memory(&reconstruct_jpeg(&placeholder)).unwrap();
      assert_eq!((decoded.width(), decoded.height()), (ew, eh));
    }
  }

  #[test]
  fn placeholder_flattens_alpha_onto_white() {
    let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(100, 100, image::Rgba([0, 0, 0, 0])));
    let placeholder = create_image_placeholder(&img).unwrap();
    let decoded = image::load_from_memory(&reconstruct_jpeg(&placeholder)).unwrap().to_rgb8();
    assert!(decoded.pixels().all(|p| p.0.iter().all(|&c| c > 245)));
  }
}
