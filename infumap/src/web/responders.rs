// Copyright (C) 2022 The Infumap Authors
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

use rocket::http::ContentType;
use rocket::response::{self, Responder};
use rocket::request::Request;
use rocket::Response;
use core::time;
use std::io::Cursor;
use std::thread;


pub struct FileResponse<T> {
  pub data: T,
  pub mime_type: ContentType,
}

impl<'r> Responder<'r, 'static> for FileResponse<Vec<u8>> {
  fn respond_to(self, _request: &'r Request<'_>) -> response::Result<'static> {
    Response::build()
      .header(self.mime_type)
      .sized_body(self.data.len(), Cursor::new(self.data))
      .ok()
  }
}

impl<'r> Responder<'r, 'static> for FileResponse<&'static [u8]> {
  fn respond_to(self, _request: &'r Request<'_>) -> response::Result<'static> {
    Response::build()
      .header(self.mime_type)
      .sized_body(self.data.len(), Cursor::new(self.data))
      .ok()
  }
}


pub struct RateLimitResponse<R>(pub R);

impl<'r, 'o: 'r, R: Responder<'r, 'o>> Responder<'r, 'o> for RateLimitResponse<R> {
  fn respond_to(self, req: &'r Request<'_>) -> response::Result<'o> {
    thread::sleep(time::Duration::from_millis(100));
    let mut build = Response::build();
    build.merge(self.0.respond_to(req)?);
    build.ok()
  }
}
