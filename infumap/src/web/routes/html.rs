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
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response, Method};

use crate::web::serve::full_body;


pub fn serve_html_routes(
    req: &Request<hyper::body::Incoming>) -> Option<Response<BoxBody<Bytes, hyper::Error>>> {
  match (req.method(), req.uri().path()) {
    (&Method::GET, "/add") => Some(Response::builder().header(hyper::header::CONTENT_TYPE, "text/html").body(full_body(include_str!("../../../dist/add.html"))).unwrap()),
    _ => None
  }
}
