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

use hyper::header::COOKIE;
use hyper::Request;
use log::{debug, warn};
use serde::{Deserialize, Serialize};

use crate::util::uid::Uid;


pub const SESSION_COOKIE_NAME: &'static str = "infusession";

#[derive(Deserialize, Serialize, Clone)]
pub struct InfuSession {
  pub username: String,
  #[serde(rename="userId")]
  pub user_id: Uid,
  #[serde(rename="sessionId")]
  pub session_id: Uid,
}

pub fn get_session_cookie_maybe(request: &Request<hyper::body::Incoming>) -> Option<InfuSession> {
  match request.headers().get(COOKIE) {
    Some(cookies) => {
      match cookies.to_str() {
        Ok(cookies) => {
          let sc = cookie::Cookie::split_parse(cookies);
          for cookie_maybe in sc.into_iter() {
            match cookie_maybe {
              Ok(cookie) => {
                let (name, val) = cookie.name_value();
                if name == SESSION_COOKIE_NAME {
                  return match serde_json::from_str::<InfuSession>(val) {
                    Ok(s) => Some(s),
                    Err(e) => {
                      warn!("Session cookie could not be parsed: {}", e);
                      return None;
                    }
                  }
                }
              },
              Err(_) => {}
            }
          }
          debug!("A valid session cookie not available.");
          None
        },
        Err(_e) => {
          warn!("Cookies http header is not a valid string.");
          None
        }
      }
    },
    None => {
      debug!("Cookie http header not present.");
      None
    }
  }
}
