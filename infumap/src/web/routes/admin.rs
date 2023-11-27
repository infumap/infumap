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
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::storage::db::Db;
use crate::storage::db::item::{default_home_page, default_trash_page, default_dock_page};
use crate::web::serve::{json_response, not_found_response, forbidden_response, incoming_json};
use crate::storage::db::user::ROOT_USER_NAME;
use crate::web::session::get_and_validate_session;


const REASON_CLIENT: &str = "client";
const REASON_SERVER: &str = "server";

#[derive(Serialize)]
pub struct InstallationStateResponse {
  #[serde(rename="hasRootUser")]
  pub has_root_user: bool
}

pub async fn serve_admin_route(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  match (req.method(), req.uri().path()) {
    (&Method::POST, "/admin/installation-state") => installation_state(db).await,
    (&Method::POST, "/admin/list-pending") => list_pending(db, req).await,
    (&Method::POST, "/admin/approve-pending") => approve_pending(db, req).await,
    _ => not_found_response(),
  }
}

pub async fn installation_state(db: &Arc<Mutex<Db>>) -> Response<BoxBody<Bytes, hyper::Error>> {
  json_response(&InstallationStateResponse {
    has_root_user: db.lock().await.user.get_by_username_case_insensitive(ROOT_USER_NAME).is_some()
  })
}


#[derive(Deserialize, Serialize, Debug)]
pub struct ListPendingUsersResponse {
  pub usernames: Vec<String>,
}

pub async fn list_pending(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session_maybe = get_and_validate_session(&req, db).await;
  let session = match session_maybe {
    None => { return forbidden_response(); }
    Some(s) => s
  };

  if session.username != ROOT_USER_NAME {
    return forbidden_response();
  }

  let db = db.lock().await;

  let mut usernames = vec![];
  for (_, user) in db.pending_user.get_iter() {
    usernames.push(user.username.clone());
  }

  let response = ListPendingUsersResponse { usernames };
  json_response(&response)
}


#[derive(Serialize, Deserialize, Debug)]
pub struct ApprovePendingUserRequest {
    pub username: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ApprovePendingUserResponse {
  pub success: bool,
  pub err: Option<String>,
}

pub async fn approve_pending(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session_maybe = get_and_validate_session(&req, db).await;
  let session = match session_maybe {
    None => { return forbidden_response(); }
    Some(s) => s
  };

  if session.username != ROOT_USER_NAME {
    return forbidden_response();
  }

  let request: ApprovePendingUserRequest = match incoming_json(req).await {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred parsing approve pending user payload: {}", e);
      return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_CLIENT.to_owned()) });
    }
  };

  let mut db = db.lock().await;

  let pending_user = match db.pending_user.get_by_username_case_insensitive(&request.username) {
    Some(pu) => pu.clone(),
    None => {
      return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_CLIENT.to_owned()) });
    }
  };

  match db.user.add(pending_user.clone()).await {
    Ok(_) => {
      match db.pending_user.remove(&pending_user.id).await {
        Ok(_) => {},
        Err(e) => {
          error!("An error occured removing pending user from pending list: {}", e);
          return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) });
        }
      };
      if let Err(e) = db.item.load_user_items(&pending_user.id, true).await {
        error!("Error creating item store for user '{}': {}", pending_user.id, e);
        return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) });
      }
      if let Err(e) = db.session.create(&pending_user.id).await {
        error!("Error creating session store for user '{}': {}", pending_user.id, e);
        return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) });
      }
      // TODO (MEDIUM): get and store user specific values when the pending user request is created.
      let page_width_bl = 60;
      let natural_aspect = 2.0;
      let home_page = default_home_page(pending_user.id.as_str(), &pending_user.username, pending_user.home_page_id, page_width_bl, natural_aspect);
      if let Err(e) = db.item.add(home_page).await {
        error!("Error adding default page: {}", e);
        return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) } );
      }
      let trash_page = default_trash_page(pending_user.id.as_str(), pending_user.trash_page_id, natural_aspect);
      if let Err(e) = db.item.add(trash_page).await {
        error!("Error adding default trash page: {}", e);
        return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) } );
      }
      let dock_page = default_dock_page(pending_user.id.as_str(), pending_user.dock_page_id, natural_aspect);
      if let Err(e) = db.item.add(dock_page).await {
        error!("Error adding default trash page: {}", e);
        return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) } );
      }
    },
    Err(e) => {
      error!("An error occured adding pending user: {}", e);
      return json_response(&ApprovePendingUserResponse { success: false, err: Some(REASON_SERVER.to_owned()) });
    }
  }

  info!("Approve pending user complete {}", request.username);

  let response = ApprovePendingUserResponse { success: true, err: None };
  json_response(&response)
}
