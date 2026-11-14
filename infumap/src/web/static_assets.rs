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

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::header::{ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE, HeaderMap, VARY};
use hyper::{Response, StatusCode};

use super::serve::{empty_body, full_body};

enum Encoding {
  Gzip,
  Identity,
  NotAcceptable,
}

pub(super) fn serve_javascript(
  headers: &HeaderMap,
  uncompressed: &'static [u8],
  gzipped: &'static [u8],
) -> Response<BoxBody<Bytes, hyper::Error>> {
  // Both representations need Vary so a shared cache cannot reuse an
  // uncompressed response for a client that explicitly refuses identity.
  let response = Response::builder().header(VARY, "Accept-Encoding");
  let (body, gzip) = match select_encoding(headers) {
    Encoding::Gzip => (gzipped, true),
    Encoding::Identity => (uncompressed, false),
    Encoding::NotAcceptable => {
      return response.status(StatusCode::NOT_ACCEPTABLE).body(empty_body()).unwrap();
    }
  };
  let response = response.header(CACHE_CONTROL, "max-age=31536000").header(CONTENT_TYPE, "text/javascript");
  let response = if gzip { response.header(CONTENT_ENCODING, "gzip") } else { response };
  response.body(full_body(body)).unwrap()
}

fn select_encoding(headers: &HeaderMap) -> Encoding {
  let mut gzip = None;
  let mut identity = None;
  let mut wildcard = None;

  for value in headers.get_all(ACCEPT_ENCODING) {
    let Ok(value) = value.to_str() else { continue };
    for entry in value.split(',') {
      let mut parts = entry.split(';');
      let coding = parts.next().unwrap_or("").trim();
      let mut quality = 1000;
      for parameter in parts {
        let Some((name, value)) = parameter.split_once('=') else {
          quality = 0;
          break;
        };
        if name.trim().eq_ignore_ascii_case("q") {
          quality = parse_quality(value.trim()).unwrap_or(0);
        } else {
          quality = 0;
          break;
        }
      }
      if coding.eq_ignore_ascii_case("gzip") {
        gzip = Some(quality);
      } else if coding.eq_ignore_ascii_case("identity") {
        identity = Some(quality);
      } else if coding == "*" {
        wildcard = Some(quality);
      }
    }
  }

  // Explicit entries override '*', including gzip;q=0. Without a header,
  // preserve the existing uncompressed response. Identity is acceptable
  // by default, but only an explicit preference should outweigh gzip.
  let gzip = gzip.or(wildcard).unwrap_or(0);
  if gzip > 0 && identity.is_none_or(|quality| gzip >= quality) {
    Encoding::Gzip
  } else if identity.unwrap_or(if wildcard == Some(0) { 0 } else { 1000 }) > 0 {
    Encoding::Identity
  } else {
    Encoding::NotAcceptable
  }
}

fn parse_quality(value: &str) -> Option<u16> {
  let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
  if fraction.len() > 3 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  let fraction =
    fraction.bytes().fold(0, |acc, byte| acc * 10 + u16::from(byte - b'0')) * 10_u16.pow(3 - fraction.len() as u32);
  match whole {
    "0" => Some(fraction),
    "1" if fraction == 0 => Some(1000),
    _ => None,
  }
}
