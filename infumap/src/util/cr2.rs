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

use image::{ImageFormat, ImageReader};
use infusdk::util::infu::InfuResult;

pub fn is_cr2(data: &[u8]) -> bool {
  data.len() >= 16 && matches!(&data[..4], b"II*\0" | b"MM\0*") && &data[8..12] == b"CR\x02\0"
}

/// Extracts the largest JPEG preview from the CR2's top-level TIFF directories.
/// Sensor data is not developed: its lossless JPEG is separate from the display previews.
pub fn embedded_preview(data: &[u8]) -> InfuResult<&[u8]> {
  if !is_cr2(data) {
    return Err("Not a Canon CR2 file.".into());
  }
  let tiff = Tiff { data, little_endian: &data[..2] == b"II" };
  let raw_ifd = tiff.u32_at(12)? as usize;
  let mut ifd = tiff.u32_at(4)? as usize;
  let mut visited = Vec::new();
  let mut best = None;
  let mut best_pixels = 0;

  while ifd != 0 && ifd != raw_ifd {
    // CR2 normally has four IFDs. Bound traversal and reject cycles in malformed uploads.
    if visited.len() >= 16 || visited.contains(&ifd) {
      return Err("Invalid CR2: cyclic or excessive TIFF directories.".into());
    }
    visited.push(ifd);
    let count = usize::from(tiff.u16_at(ifd)?);
    let end =
      ifd.checked_add(2).and_then(|start| start.checked_add(count * 12)).ok_or("Invalid CR2 directory size.")?;
    // Check the complete directory, including its next-IFD pointer, before reading entries.
    tiff.u32_at(end)?;
    let mut strip_offset = None;
    let mut strip_length = None;
    let mut jpeg_offset = None;
    let mut jpeg_length = None;
    for index in 0..count {
      let entry = ifd + 2 + index * 12;
      let tag = tiff.u16_at(entry)?;
      let target = match tag {
        273 => &mut strip_offset,
        279 => &mut strip_length,
        513 => &mut jpeg_offset,
        514 => &mut jpeg_length,
        _ => continue,
      };
      *target = tiff.scalar(entry)?;
    }
    // Canon stores its large preview as one JPEG-compressed strip in IFD0; the thumbnail uses
    // JPEGInterchangeFormat/Length. Follow TIFF references rather than scanning the RAW payload for JPEG markers.
    for (offset, length) in [strip_offset.zip(strip_length), jpeg_offset.zip(jpeg_length)].into_iter().flatten() {
      let start = offset as usize;
      let end = start.checked_add(length as usize).ok_or("Invalid CR2 preview size.")?;
      let preview = data.get(start..end).ok_or("CR2 preview extends beyond the original file.")?;
      if !preview.starts_with(&[0xff, 0xd8]) {
        continue;
      }
      if let Ok((width, height)) = ImageReader::with_format(Cursor::new(preview), ImageFormat::Jpeg).into_dimensions() {
        let pixels = u64::from(width) * u64::from(height);
        if pixels > best_pixels {
          best = Some(preview);
          best_pixels = pixels;
        }
      }
    }
    ifd = tiff.u32_at(end)? as usize;
  }
  best.ok_or_else(|| "CR2 file has no usable embedded JPEG preview.".into())
}

struct Tiff<'a> {
  data: &'a [u8],
  little_endian: bool,
}

impl Tiff<'_> {
  fn bytes<const N: usize>(&self, offset: usize) -> InfuResult<[u8; N]> {
    let end = offset.checked_add(N).ok_or("Invalid CR2 TIFF offset.")?;
    let slice = self.data.get(offset..end).ok_or("Truncated CR2 TIFF directory.")?;
    let mut bytes = [0; N];
    bytes.copy_from_slice(slice);
    Ok(bytes)
  }

  fn u16_at(&self, offset: usize) -> InfuResult<u16> {
    let bytes = self.bytes(offset)?;
    Ok(if self.little_endian { u16::from_le_bytes(bytes) } else { u16::from_be_bytes(bytes) })
  }

  fn u32_at(&self, offset: usize) -> InfuResult<u32> {
    let bytes = self.bytes(offset)?;
    Ok(if self.little_endian { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) })
  }

  fn scalar(&self, entry: usize) -> InfuResult<Option<u32>> {
    if self.u32_at(entry + 4)? != 1 {
      return Ok(None);
    }
    Ok(match self.u16_at(entry + 2)? {
      3 => Some(u32::from(self.u16_at(entry + 8)?)),
      4 => Some(self.u32_at(entry + 8)?),
      _ => None,
    })
  }
}
