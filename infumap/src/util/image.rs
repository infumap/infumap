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

use exif::Tag;
use image::DynamicImage;
use log::debug;


pub fn get_exif_orientation(image_bytes: Vec<u8>, image_identifier: &str) -> u16 {
  let mut original_file_cursor = Cursor::new(image_bytes);
  let exifreader = exif::Reader::new();
  match exifreader.read_from_container(&mut original_file_cursor) {
    Ok(exif) => match exif.fields().find(|f| f.tag == Tag::Orientation) {
      Some(o) => {
        match &o.value {
          exif::Value::Short(s) => {
            match s.get(0) {
              Some(s) => *s,
              None => {
                debug!("EXIF Orientation value present but not present for image '{}', ignoring.", image_identifier);
                1
              }
            }
          },
          _ => {
            debug!("EXIF Orientation value present but does not have type Short for image '{}', ignoring.", image_identifier);
            1
          }
        }
      }
      None => 0
    },
    Err(_e) => { 1 }
  }
}


pub fn adjust_image_for_exif_orientation(img: DynamicImage, exif_orientation: u16, image_identifier: &str) -> DynamicImage {
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
    0 => {}, // Invalid, but silently ignore. It's relatively common.
    1 => {},
    2 => { img = img.fliph(); }
    3 => { img = img.rotate180(); }
    4 => { img = img.fliph(); img = img.rotate180(); }
    5 => { img = img.rotate90(); img = img.fliph(); }
    6 => { img = img.rotate90(); }
    7 => { img = img.rotate270(); img = img.fliph(); }
    8 => { img = img.rotate270(); }
    o => {
      debug!("Unexpected EXIF orientation {} for image '{}'.", o, image_identifier);
    }
  }
  img
}
