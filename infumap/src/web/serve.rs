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
use config::Config;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::{Request, Response, StatusCode, Method};
use hyper::header::HeaderValue;
use infusdk::util::infu::InfuResult;
use log::{error, debug, warn};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::str;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::storage::db::Db;
use crate::storage::cache::ImageCache;
use crate::storage::db::session_db::SESSION_ROTATION_INTERVAL_SECS;
use crate::storage::object::ObjectStore;
use crate::web::dist_handlers::serve_index;
use crate::web::cookie::{get_session_cookie_session_id_maybe, get_session_header_maybe, InfuSession, SESSION_HEADER_NAME};

use super::dist_handlers::serve_dist_routes;
use super::routes::account::{build_session_cookie_value, serve_account_route, set_cookie_header, should_use_secure_cookie};
use super::routes::admin::serve_admin_route;
use super::routes::ingest::serve_ingest_route;
use super::routes::command::serve_command_route;
use super::routes::files::serve_files_route;


pub async fn http_serve(
    db: Arc<Mutex<Db>>,
    object_store: Arc<ObjectStore>,
    image_cache: Arc<std::sync::Mutex<ImageCache>>,
    config: Arc<Config>,
    dev_feature_flag: bool,
    req: Request<hyper::body::Incoming>) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error> {
  debug!("Serving: {} ({})", req.uri().path(), req.method());
  let req_path = req.uri().path().to_string();
  let secure_cookie = should_use_secure_cookie(&req);
  let incoming_cookie_session_id_maybe = get_session_cookie_session_id_maybe(&req);
  let incoming_header_session_maybe = if incoming_cookie_session_id_maybe.is_some() {
    None
  } else {
    get_session_header_maybe(&req)
  };

  let mut response =
    if req.uri().path() == "/command" { serve_command_route(&db, &object_store, image_cache.clone(), req).await }
    else if req.uri().path().starts_with("/account/") { serve_account_route(config.clone(), &db, req).await }
    else if req.uri().path().starts_with("/ingest/") { serve_ingest_route(&db, &object_store, req).await }
    else if req.uri().path().starts_with("/files/") { serve_files_route(config, &db, object_store, image_cache.clone(), &req).await }
    else if req.uri().path().starts_with("/admin/") { serve_admin_route(&db, dev_feature_flag, req).await }
    else if let Some(response) = serve_dist_routes(&req) { response }
    else if req.method() == Method::GET { // &&
      // TODO (MEDIUM): explicit support only for /{item_id}, /{username} and /{username}/{label}
      //       req.uri().path().len() > 32 &&
      //       is_uid(&req.uri().path()[req.uri().path().len()-32..]) {
      serve_index()
    } else {
      not_found_response()
    };

  maybe_rotate_primary_session(
    &db,
    &req_path,
    secure_cookie,
    incoming_cookie_session_id_maybe,
    incoming_header_session_maybe,
    &mut response).await;

  Ok(response)
}

async fn maybe_rotate_primary_session(
  db: &Arc<Mutex<Db>>,
  req_path: &str,
  secure_cookie: bool,
  incoming_cookie_session_id_maybe: Option<String>,
  incoming_header_session_maybe: Option<InfuSession>,
  response: &mut Response<BoxBody<Bytes, hyper::Error>>) {
  if !response.status().is_success() {
    return;
  }

  if req_path == "/account/login" || req_path == "/account/logout" {
    return;
  }

  let session_id = match (&incoming_cookie_session_id_maybe, &incoming_header_session_maybe) {
    (Some(session_id), _) => session_id.clone(),
    (None, Some(session_header)) => session_header.session_id.clone(),
    (None, None) => return,
  };

  let rotated_result = {
    let mut db = db.lock().await;
    db.session.rotate_session_if_due(&session_id, SESSION_ROTATION_INTERVAL_SECS).await
  };

  let rotated = match rotated_result {
    Ok(Some(rotated)) => rotated,
    Ok(None) => return,
    Err(e) => {
      warn!("Could not rotate session '{}': {}", session_id, e);
      return;
    }
  };

  if incoming_cookie_session_id_maybe.is_some() {
    set_cookie_header(response, build_session_cookie_value(&rotated.id, secure_cookie));
    return;
  }

  if let Some(session_header) = incoming_header_session_maybe {
    let rotated_header = InfuSession {
      username: rotated.username,
      user_id: rotated.user_id,
      session_id: rotated.id,
    };
    match serde_json::to_string(&rotated_header)
      .ok()
      .and_then(|header_str| HeaderValue::from_str(&header_str).ok()) {
      Some(header_value) => {
        response.headers_mut().insert(SESSION_HEADER_NAME, header_value);
      },
      None => {
        warn!(
          "Could not set rotated session header for user '{}' session '{}'.",
          session_header.user_id,
          session_id
        );
      }
    }
  }
}

pub fn empty_body() -> BoxBody<Bytes, hyper::Error> {
  Empty::<Bytes>::new()
    .map_err(|never| match never {})
    .boxed()
}

pub fn full_body<T: Into<Bytes>>(data: T) -> BoxBody<Bytes, hyper::Error> {
  Full::new(data.into())
    .map_err(|never| match never {})
    .boxed()
}

pub fn json_response<T>(v: &T) -> Response<BoxBody<Bytes, hyper::Error>> where T: Serialize {
  let result_str = serde_json::to_string(&v).unwrap();
  match Response::builder()
      .header(hyper::header::CONTENT_TYPE, "text/javascript")
      .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
      .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
      .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
      .body(full_body(result_str)) {
    Ok(r) => r,
    Err(_) => {
      Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
    }
  }
}

pub fn text_response(v: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
  match Response::builder().header(hyper::header::CONTENT_TYPE, "text/plain").body(full_body(String::from(v))) {
    Ok(r) => r,
    Err(_) => {
      Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
    }
  }
}

#[allow(dead_code)]
pub fn forbidden_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder().status(StatusCode::FORBIDDEN).body(empty_body()).unwrap()
}

pub fn internal_server_error_response(reason: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
  error!("{}", reason);
  Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
}

pub fn _service_unavailable_response(reason: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
  debug!("{}", reason);
  Response::builder().status(StatusCode::SERVICE_UNAVAILABLE).body(empty_body()).unwrap()
}

pub fn not_found_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder().status(StatusCode::NOT_FOUND).body(empty_body()).unwrap()
}

pub async fn incoming_json<T>(request: Request<hyper::body::Incoming>) -> InfuResult<T> where T: DeserializeOwned {
  // TODO (LOW): Improve efficiency. This method is bad in a couple of ways.
  Ok(serde_json::from_str::<T>(
    &String::from_utf8(
      request.collect().await.unwrap().to_bytes().iter().cloned().collect::<Vec<u8>>()
    )?
  )?)
}

pub fn cors_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .status(StatusCode::NO_CONTENT)
    .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
    .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
    .body(empty_body()).unwrap()
}
