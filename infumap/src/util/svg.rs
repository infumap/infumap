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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use image::{DynamicImage, ImageReader, RgbaImage};
use infusdk::util::infu::InfuResult;
use once_cell::sync::Lazy;
use resvg::{tiny_skia, usvg};

const MAX_SVG_BYTES: usize = 8 * 1024 * 1024;
const MAX_SVG_NODES: u32 = 50_000;
const MAX_SVG_DEPTH: usize = 128;
const MAX_SVG_DIMENSION: f32 = 100_000.0;
const MAX_EMBEDDED_IMAGE_PIXELS: u64 = 16_000_000;

static FONTS: Lazy<Arc<usvg::fontdb::Database>> = Lazy::new(|| {
  let mut db = usvg::fontdb::Database::new();
  db.load_system_fonts();
  Arc::new(db)
});

pub fn parse(data: &[u8]) -> InfuResult<usvg::Tree> {
  if data.len() > MAX_SVG_BYTES {
    return Err("SVG images must be no larger than 8 MiB.".into());
  }
  let text = std::str::from_utf8(data).map_err(|_| "SVG images must use UTF-8 encoding.")?;
  // usvg's string parser enables DTDs. Parse XML ourselves so entity declarations cannot expand or read resources.
  let doc = usvg::roxmltree::Document::parse_with_options(
    text,
    usvg::roxmltree::ParsingOptions { allow_dtd: false, nodes_limit: MAX_SVG_NODES, ..Default::default() },
  )
  .map_err(|e| format!("Invalid SVG XML: {}", e))?;
  if !doc.root_element().has_tag_name(("http://www.w3.org/2000/svg", "svg")) {
    return Err("An SVG image must have an svg root in the http://www.w3.org/2000/svg namespace.".into());
  }
  if doc.descendants().any(|node| {
    node.ancestors().filter(|ancestor| ancestor.is_element()).take(MAX_SVG_DEPTH + 1).count() > MAX_SVG_DEPTH
  }) {
    return Err("SVG elements are nested too deeply.".into());
  }

  let rejected_image = AtomicBool::new(false);
  let embedded_pixels = AtomicU64::new(0);
  let default_data_resolver = usvg::ImageHrefResolver::default_data_resolver();
  let options = usvg::Options {
    fontdb: FONTS.clone(),
    image_href_resolver: usvg::ImageHrefResolver {
      // The default resolver reads local paths, even with resources_dir unset. Uploaded SVG must never do that.
      resolve_string: Box::new(|_, _| None),
      resolve_data: Box::new(|mime, bytes, options| {
        // Bound raster decoding and exclude nested SVG, whose parser would bypass our XML and resource limits.
        let dimensions = ImageReader::new(Cursor::new(bytes.as_slice()))
          .with_guessed_format()
          .ok()
          .and_then(|reader| reader.into_dimensions().ok());
        let allowed_mime =
          matches!(mime, "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp" | "text/plain");
        if let Some((w, h)) = dimensions.filter(|_| allowed_mime) {
          let pixels = u64::from(w) * u64::from(h);
          if pixels > 0
            && pixels <= MAX_EMBEDDED_IMAGE_PIXELS
            && embedded_pixels.fetch_add(pixels, Ordering::Relaxed) + pixels <= MAX_EMBEDDED_IMAGE_PIXELS
          {
            return default_data_resolver(mime, bytes, options);
          }
        }
        rejected_image.store(true, Ordering::Relaxed);
        None
      }),
    },
    ..Default::default()
  };
  let tree = usvg::Tree::from_xmltree(&doc, &options).map_err(|e| format!("Invalid SVG image: {}", e))?;
  if rejected_image.load(Ordering::Relaxed) {
    return Err("SVG embedded images must be PNG, JPEG, GIF or WebP, with at most 16 million pixels in total.".into());
  }
  let size = tree.size();
  if size.width() > MAX_SVG_DIMENSION || size.height() > MAX_SVG_DIMENSION {
    return Err("SVG dimensions must be no larger than 100,000 CSS pixels.".into());
  }
  Ok(tree)
}

pub fn placeholder(tree: &usvg::Tree, max_dimension: u32) -> InfuResult<DynamicImage> {
  let size = tree.size();
  let scale = (max_dimension as f32 / size.width().max(size.height())).min(1.0);
  let width = (size.width() * scale).round().max(1.0) as u32;
  let height = (size.height() * scale).round().max(1.0) as u32;
  let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or("Could not allocate SVG placeholder.")?;
  // Composite onto white before rendering: tiny-skia returns premultiplied pixels, whereas image expects straight alpha.
  pixmap.fill(tiny_skia::Color::WHITE);
  resvg::render(tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
  let img = RgbaImage::from_raw(width, height, pixmap.take()).ok_or("Invalid SVG placeholder pixel buffer.")?;
  Ok(DynamicImage::ImageRgba8(img))
}
