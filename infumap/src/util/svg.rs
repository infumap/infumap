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

use infusdk::util::infu::InfuResult;

const MAX_SVG_BYTES: usize = 8 * 1024 * 1024;
const MAX_SVG_NODES: u32 = 50_000;
const MAX_SVG_DEPTH: usize = 128;
const MAX_SVG_DIMENSION: f64 = 100_000.0;
const DEFAULT_SIZE: (f64, f64) = (300.0, 150.0);

pub fn dimensions(data: &[u8]) -> InfuResult<(u32, u32)> {
  if data.len() > MAX_SVG_BYTES {
    return Err("SVG images must be no larger than 8 MiB.".into());
  }
  let text = std::str::from_utf8(data).map_err(|_| "SVG images must use UTF-8 encoding.")?;
  // No DTDs or resource resolution: only inspect the XML and root sizing attributes.
  let doc = roxmltree::Document::parse_with_options(
    text,
    roxmltree::ParsingOptions { allow_dtd: false, nodes_limit: MAX_SVG_NODES, ..Default::default() },
  )
  .map_err(|e| format!("Invalid SVG XML: {}", e))?;
  let root = doc.root_element();
  if !root.has_tag_name(("http://www.w3.org/2000/svg", "svg")) {
    return Err("An SVG image must have an svg root in the http://www.w3.org/2000/svg namespace.".into());
  }
  if doc.descendants().any(|node| {
    node.ancestors().filter(|ancestor| ancestor.is_element()).take(MAX_SVG_DEPTH + 1).count() > MAX_SVG_DEPTH
  }) {
    return Err("SVG elements are nested too deeply.".into());
  }

  // CSS and content bounds are left to the browser. Root attributes give a stable layout size without
  // a renderer or font database; SVGs without usable dimensions or a viewBox use a 300x150 viewport.
  let view_box = root.attribute("viewBox").and_then(view_box_size);
  let (base_width, base_height) = view_box.unwrap_or(DEFAULT_SIZE);
  let width = root.attribute("width").and_then(|value| length_px(value, base_width));
  let height = root.attribute("height").and_then(|value| length_px(value, base_height));
  let (width, height) = match (width, height, view_box) {
    (Some(width), None, Some((vw, vh))) => (width, width * vh / vw),
    (None, Some(height), Some((vw, vh))) => (height * vw / vh, height),
    _ => (width.unwrap_or(base_width), height.unwrap_or(base_height)),
  };
  if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
    return Err("SVG dimensions must be positive and finite.".into());
  }
  if width > MAX_SVG_DIMENSION || height > MAX_SVG_DIMENSION {
    return Err("SVG dimensions must be no larger than 100,000 CSS pixels.".into());
  }
  Ok((width.round().max(1.0) as u32, height.round().max(1.0) as u32))
}

fn view_box_size(value: &str) -> Option<(f64, f64)> {
  let values = value
    .split(|c: char| c.is_ascii_whitespace() || c == ',')
    .filter(|value| !value.is_empty())
    .take(5)
    .map(str::parse::<f64>)
    .collect::<Result<Vec<_>, _>>()
    .ok()?;
  match values.as_slice() {
    [x, y, width, height]
      if x.is_finite() && y.is_finite() && width.is_finite() && height.is_finite() && *width > 0.0 && *height > 0.0 =>
    {
      Some((*width, *height))
    }
    _ => None,
  }
}

fn length_px(value: &str, relative_to: f64) -> Option<f64> {
  let value = value.trim().to_ascii_lowercase();
  for (unit, scale) in [
    ("px", 1.0),
    ("in", 96.0),
    ("cm", 96.0 / 2.54),
    ("mm", 96.0 / 25.4),
    ("q", 96.0 / 101.6),
    ("pt", 96.0 / 72.0),
    ("pc", 16.0),
    ("%", relative_to / 100.0),
  ] {
    if let Some(number) = value.strip_suffix(unit) {
      return number.trim().parse::<f64>().ok().map(|number| number * scale);
    }
  }
  value.parse().ok()
}
