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

use hyper::Request;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::{storage::db::{Db, session::Session}, util::infu::InfuResult};

use super::cookie::get_session_cookie_maybe;


pub async fn get_and_validate_session<'a >(request: &Request<hyper::body::Incoming>, db: &Arc<Mutex<Db>>) -> InfuResult<Session> {
  let mut db = db.lock().await;
  let session_cookie = get_session_cookie_maybe(request).ok_or("Session cookie not available")?;

  let session = match db.session.get_session(&session_cookie.session_id)? {
    Some(s) => s,
    None => {
      return Err(format!("Session '{}' for user '{}' is not availble on the server. It may have expired.",
                         session_cookie.session_id, session_cookie.user_id).into());
    }
  };

  // All data in the session cookie aside from the session id is supurfluous - it is there for client side convenience.
  // TOOD (LOW): just use the session cookie.

  if session_cookie.user_id != session.user_id {
    return Err(format!("Session '{}' is for user '{}' not user '{}'.", session_cookie.session_id, session.user_id, session_cookie.user_id).into());
  }

  let user = db.user.get_by_username(&session_cookie.username).ok_or(format!("No user exists with username '{}'.", session_cookie.username))?;
  if user.id != session_cookie.user_id {
    return Err(format!("Id for user '{}' is '{}' not '{}'.", session_cookie.username, user.id, session_cookie.user_id).into());
  }

  if user.root_page_id != session_cookie.root_page_id {
    return Err(format!("User root page '{}' does not match that in session cookie '{}'.", user.root_page_id, session_cookie.root_page_id).into());
  }

  Ok(session)
}
