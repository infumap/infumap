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
use hyper::{Request, Response, Method};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::{storage::db::Db, web::serve::{json_response, not_found_response}};


#[derive(Serialize)]
pub struct InstallationStateResponse {
  #[serde(rename="hasRootUser")]
  pub has_root_user: bool
}

pub async fn serve_admin_route(db: &Arc<Mutex<Db>>, req: &Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  match (req.method(), req.uri().path()) {
    (&Method::POST, "/admin/installation-state") => json_response(&InstallationStateResponse { has_root_user: db.lock().await.user.get_by_username_case_insensitive("root").is_some() }),
    _ => not_found_response(),
  }
}
