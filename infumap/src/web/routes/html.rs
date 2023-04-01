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

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response, Method};

use crate::{storage::{db::Db, object}, web::serve::full_body};


pub async fn serve_html_routes(
    db: &Arc<tokio::sync::Mutex<Db>>,
    object_store: &Arc<object::ObjectStore>,
    req: &Request<hyper::body::Incoming>) -> Option<Response<BoxBody<Bytes, hyper::Error>>> {
  match (req.method(), req.uri().path()) {
    (&Method::GET, "/add") => Some(Response::builder().header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../../dist/add.html"))).unwrap()),
    // (&Method::POST, "/add") => serve_add_post(db, object_store, req),
    _ => None
  }
}

// fn serve_add_post(
//     db: &Arc<tokio::sync::Mutex<Db>>,
//     object_store: &Arc<object::ObjectStore>,
//     req: &Request<hyper::body::Incoming>) -> Option<Response<BoxBody<Bytes, hyper::Error>>> {
  
//   Some(Response::builder().header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../../dist/upload.html"))).unwrap())
// }
