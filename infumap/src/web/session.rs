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

use hyper::Request;
use log::{debug, error, warn};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::storage::db::{Db, session::Session};

use super::cookie::{get_session_cookie_session_id_maybe, get_session_header_maybe};


pub async fn get_and_validate_session(request: &Request<hyper::body::Incoming>, db: &Arc<Mutex<Db>>) -> Option<Session> {
  let mut db = db.lock().await;
  let (session_id, session_header_maybe) = match get_session_cookie_session_id_maybe(request) {
    Some(cookie_session_id) => (cookie_session_id, None),
    None => match get_session_header_maybe(request) {
      Some(header_session) => (header_session.session_id.clone(), Some(header_session)),
      None => {
        debug!("No session cookie or header is present.");
        return None;
      }
    }
  };

  let session = match db.session.get_session(&session_id) {
    Ok(session_maybe) => match session_maybe {
      Some(s) => s,
      None => {
        debug!("Session '{}' is not available on the server. This can happen if the server is restarted or the session has expired.",
              session_id);
        return None;
      }
    },
    Err(e) => {
      error!("Error occurred getting user session: {}", e);
      return None;
    }
  };

  if let Some(session_header) = session_header_maybe {
    if session_header.user_id != session.user_id {
      warn!("Error validating session '{}': Session is for user '{}' not user '{}'.", session_header.session_id, session.user_id, session_header.user_id);
      return None;
    }

    let user = match db.user.get_by_username_case_insensitive(&session_header.username).ok_or(format!("No user exists with username '{}'.", session_header.username)) {
      Ok(user) => user,
      Err(e) => {
        error!("Error occurred getting user to validate session: {}", e);
        return None;
      }
    };
    if user.id != session_header.user_id {
      warn!("Error validating session '{}': Id for user '{}' is '{}' not '{}'.", session_header.session_id, session_header.username, user.id, session_header.user_id);
      return None;
    }
  }

  Some(session)
}
