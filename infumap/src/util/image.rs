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

use exif::{Exif, In, Tag, Value};
use image::DynamicImage;
use log::debug;
use serde::Serialize;

#[derive(Serialize, Clone, Default)]
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
