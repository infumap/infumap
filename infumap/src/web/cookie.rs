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

use rocket::http::CookieJar;
use serde::Deserialize;
use crate::util::uid::Uid;
use crate::util::infu::InfuResult;


pub const SESSION_COOKIE_NAME: &'static str = "infusession";

#[derive(Deserialize)]
pub struct InfuSession {
  pub username: String,
  #[serde(rename="userId")]
  pub user_id: Uid,
  #[serde(rename="sessionId")]
  pub session_id: Uid,
  #[serde(rename="rootPageId")]
  pub root_page_id: Uid
}

pub fn get_session_cookie<'a>(cookies: &'a CookieJar) -> InfuResult<InfuSession> {
  let cookie = match cookies.get(SESSION_COOKIE_NAME) {
    Some(cookie) => cookie,
    None => { return Err("Session cookie was not present.".into()); }
  };
  Ok(match serde_json::from_str::<InfuSession>(cookie.value()) {
    Ok(s) => s,
    Err(e) => { return Err(format!("Session cookie could not be parsed: {}", e).into()); }
  })
}
