// Copyright (C) 2023 The Infumap Authors
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
use hyper::{Request, Response, StatusCode};
use log::error;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::str;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::storage::cache::FileCache;
use crate::storage::db::Db;
use crate::storage::object::ObjectStore;
use crate::util::infu::InfuResult;

use super::dist_handlers::handle_dist_response_maybe;
use super::routes::account::serve_account_route;
use super::routes::admin::serve_admin_route;
use super::routes::command::serve_command_route;
use super::routes::files::serve_files_route;


pub async fn http_serve(
    db: Arc<Mutex<Db>>,
    object_store: Arc<Mutex<ObjectStore>>,
    cache: Arc<Mutex<FileCache>>,
    config: Arc<Mutex<Config>>,
    req: Request<hyper::body::Incoming>) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error> {
  Ok(
    if req.uri().path() == "/command" { serve_command_route(&db, &object_store, &cache, req).await }
    else if req.uri().path().starts_with("/account") { serve_account_route(&db, req).await }
    else if req.uri().path().starts_with("/files") { serve_files_route(&db, &object_store, &cache, &config, &req).await }
    else if req.uri().path().starts_with("/admin") { serve_admin_route(&db, &req).await }
    else if let Some(response) = handle_dist_response_maybe(&req) { response }
    else { not_found_response() }
  )
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
  match Response::builder().header(hyper::header::CONTENT_TYPE, "text/javascript").body(full_body(result_str)) {
    Ok(r) => r,
    Err(_) => {
      Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
    }
  }
}

pub fn internal_server_error_response(reason: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
  error!("{}", reason);
  Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
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
