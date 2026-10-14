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

use std::net::IpAddr;

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{ALLOW, CACHE_CONTROL, CONTENT_TYPE, ORIGIN};
use hyper::{Method, Request, Response, StatusCode};
use jiff::Timestamp;
use serde_json::json;

use crate::{protocol, search};

/// Operator endpoint: no provider calls, reservations, ledger writes or keys.
pub fn handle_http<B>(req: &Request<B>, peer: IpAddr) -> Response<Full<Bytes>> {
  let origin_allowed = match req.headers().get(ORIGIN) {
    Some(origin) => origin.to_str().is_ok_and(|origin| protocol::origin_is_allowed(Some(origin))),
    None => true,
  };
  if !peer.is_loopback() || !origin_allowed {
    return response(StatusCode::FORBIDDEN, json!({ "error": "Local access required." }));
  }
  if req.method() != Method::GET {
    let mut response = response(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Use GET." }));
    response.headers_mut().insert(ALLOW, hyper::header::HeaderValue::from_static("GET"));
    return response;
  }
  match search::provider_status() {
    Ok(providers) => {
      let configured = providers.iter().any(|provider| provider.enabled);
      let errors: Vec<&str> = if configured { vec![] } else { vec!["No search providers enabled."] };
      response(
        StatusCode::OK,
        json!({
          "generated_at": Timestamp::now().as_second(),
          "reference_request": { "num_results": search::DEFAULT_MAX_RESULTS },
          "search_available": providers.iter().any(|provider| provider.available),
          "configuration_errors": errors,
          "providers": providers,
        }),
      )
    }
    Err(_) => response(
      StatusCode::SERVICE_UNAVAILABLE,
      json!({
        "error": "Provider status unavailable; inspect server startup diagnostics."
      }),
    ),
  }
}

fn response(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
  let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
  *response.status_mut() = status;
  response.headers_mut().insert(CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
  response.headers_mut().insert(CACHE_CONTROL, hyper::header::HeaderValue::from_static("no-store"));
  response
}
