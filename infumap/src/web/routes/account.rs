// Copyright (C) 2022-2023 The Infumap Authors
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
use log::{info, error, debug};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;
use std::str;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use totp_rs::{Algorithm, TOTP, Secret};
use uuid::Uuid;

use crate::storage::db::Db;
use crate::storage::db::item::{Item, RelationshipToParent};
use crate::storage::db::user::User;
use crate::util::crypto::generate_key;
use crate::util::geometry::{Dimensions, Vector, GRID_SIZE};
use crate::util::infu::InfuResult;
use crate::util::uid::{Uid, new_uid};
use crate::web::cookie::get_session_cookie_maybe;
use crate::web::serve::{json_response, not_found_response, incoming_json};
use crate::web::session::get_and_validate_session;


const TOTP_ALGORITHM: Algorithm = Algorithm::SHA1; // The most broadly compatible algo & SHA1 is just fine for 2FA.
const TOTP_NUM_DIGETS: usize = 6; // 6 digit OTP is pretty standard.
const TOTP_SKEW: u8 = 1; // OTP is valid for this number of time intervals in the past/future.
const TOTP_STEP: u64 = 30; // Time step interval of 30 seconds is pretty standard.


pub async fn serve_account_route(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  match (req.method(), req.uri().path()) {
    (&Method::POST, "/account/login") => login(db, req).await,
    (&Method::POST, "/account/logout") => logout(db, req).await,
    (&Method::POST, "/account/register") => register(db, req).await,
    (&Method::POST, "/account/totp") => totp(),
    (&Method::POST, "/account/validate-session") => validate(db, req).await,
    _ => not_found_response()
  }
}


#[derive(Serialize, Deserialize, Debug)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    #[serde(rename="totpToken")]
    pub totp_token: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LoginResponse {
  pub success: bool,
  pub err: Option<String>,
  #[serde(rename="sessionId")]
  pub session_id: Option<String>,
  #[serde(rename="userId")]
  pub user_id: Option<String>,
}

pub async fn login(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let mut db = db.lock().await;

  async fn failed_response(msg: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
    // TODO (LOW): rate limit login requests properly.
    sleep(Duration::from_millis(250)).await;
    return json_response(&LoginResponse {
      success: false, session_id: None, user_id: None,
      err: Some(String::from(msg))
    });
  }

  let payload: LoginRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      error!("Could not parse login request: {}", e);
      return failed_response("server error").await;
    }
  };

  let user = match db.user.get_by_username_case_insensitive(&payload.username) {
    Some(user) => user,
    None => {
      info!("A login was attempted for a user '{}' that does not exist.", payload.username);
      return failed_response("credentials incorrect").await;
    }
  }.clone();

  let test_hash = User::compute_password_hash(&user.password_salt, &payload.password);
  if test_hash != user.password_hash {
    info!("A login attempt for user '{}' failed due to incorrect password.", payload.username);
    return failed_response("credentials incorrect").await;
  }

  if let Some(totp_secret) = &user.totp_secret {
    if let Some(totp_token) = &payload.totp_token {
      match validate_totp(totp_secret, totp_token) {
        Err(e) => {
          info!("An eror occured whilst trying to validate a TOTP token for user '{}': {}", payload.username, e);
          return failed_response("server error").await;
        },
        Ok(v) => {
          if !v {
            info!("A login attempt for user '{}' failed due to an incorrect TOTP.", payload.username);
            return failed_response("credentials incorrect").await;
          }
        }
      };
    } else {
      info!("A login attempt for user '{}' failed because a TOTP was not specified.", payload.username);
      return failed_response("credentials incorrect").await;
    }
  } else {
    if payload.totp_token.is_some() {
      info!("A login attempt for user '{}' failed because a TOTP token was specified, but this is not expected.", payload.username);
      return failed_response("credentials incorrect").await;
    }
  }

  match db.session.create_session(&user.id, &user.username, &payload.password) {
    Ok(session) => {
      let result = LoginResponse {
        success: true,
        session_id: Some(session.id),
        user_id: Some(user.id),
        err: None
      };
      return json_response(&result);
    },
    Err(e) => {
      error!("Failed to create session for user '{}': {}.", payload.username, e);
      return failed_response("server error").await;
    }
  }
}


#[derive(Serialize, Deserialize)]
pub struct LogoutResponse {
  pub success: bool,
}

pub async fn logout(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let mut db = db.lock().await;

  let session_cookie = match get_session_cookie_maybe(&req) {
    Some(s) => s,
    None => {
      debug!("Could not log out user session: No session cookie is present.");
      return json_response(&LogoutResponse { success: false });
    }
  };

  match db.session.delete_session(&session_cookie.session_id) {
    Err(e) => {
      error!(
        "Could not delete session '{}' for user '{}': {}",
        session_cookie.session_id, session_cookie.user_id, e);
      return json_response(&LogoutResponse { success: false });
    },
    Ok(user_id) => {
      if user_id != session_cookie.user_id {
        error!(
          "Unexpected user_id '{}' deleting session '{}'. Session is associated with user: '{}'",
          session_cookie.user_id, session_cookie.session_id, user_id);
        return json_response(&LogoutResponse { success: false });
      }
    }
  };

  json_response(&LogoutResponse { success: true })
}


#[derive(Deserialize)]
pub struct RegisterRequest {
    username: String,
    password: String,
    #[serde(rename="totpSecret")]
    totp_secret: Option<String>,
    #[serde(rename="totpToken")]
    totp_token: Option<String>,
    #[serde(rename="pageWidthPx")]
    page_width_px: i64,
    #[serde(rename="pageHeightPx")]
    page_height_px: i64,
}

#[derive(Serialize)]
pub struct RegisterResponse {
  success: bool,
  err: Option<String>
}

const RESERVED_NAMES: [&'static str; 21] = [
  "login", "logout", "register", "signin", "signup", "settings",
  "item", "items", "page", "table", "image", "text", "rating",
  "file", "blob", "about", "add", "delete", "remove", "update",
  "admin"];

pub async fn register(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let mut db = db.lock().await;

  let payload: RegisterRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      error!("Could not parse register request: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("application error")) } );
    }
  };

  if db.user.get_by_username_case_insensitive(&payload.username).is_some() ||
     db.pending_user.get_by_username_case_insensitive(&payload.username).is_some() ||
     RESERVED_NAMES.contains(&payload.username.as_str()) {
    return json_response(&RegisterResponse { success: false, err: Some(String::from("username not available")) } )
  }

  const NATURAL_BLOCK_SIZE_PX: i64 = 24;
  let page_size_px = sanitize_page_size(payload.page_width_px, payload.page_height_px);
  let page_width_bl = page_size_px.w / NATURAL_BLOCK_SIZE_PX;
  let natural_aspect = (page_size_px.w as f64) / (page_size_px.h as f64);
  if payload.username.len() < 3 {
    return json_response(&RegisterResponse { success: false, err: Some(String::from("username must be 3 or more characters")) } )
  }
  if payload.password.len() < 4 {
    return json_response(&RegisterResponse { success: false, err: Some(String::from("password must be 4 or more characters")) } )
  }
  if let Some(totp_secret) = &payload.totp_secret {
    if let Some(totp_token) = &payload.totp_token {
      match validate_totp(totp_secret, totp_token) {
        Err(e) => {
          error!("Error occurred validating TOTP token: {}", e);
          return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) } );
        },
        Ok(v) => {
          if !v { return json_response(&RegisterResponse { success: false, err: Some(String::from("incorrect OTP")) } ); }
        }
      }
    } else {
      return json_response(&RegisterResponse { success: false, err: Some(String::from("application error")) } );
    }
  }

  let user_id = new_uid();
  let root_page_id = new_uid();
  let password_salt = new_uid();

  let user = User {
    id: user_id.clone(),
    username: payload.username.clone(),
    password_hash: User::compute_password_hash(&password_salt, &payload.password),
    password_salt,
    totp_secret: payload.totp_secret.clone(),
    root_page_id: root_page_id.clone(),
    default_page_width_bl: 60,
    default_page_natural_aspect: 2.0,
    object_encryption_key: generate_key()
  };

  if payload.username == "root" {
    if let Err(e) = db.user.add(user.clone()).await {
      error!("Error adding user: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) } )
    }
    if let Err(e) = db.item.load_user_items(&user.id, true).await {
      error!("Error initializing item store for user '{}': {}", user.id, e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) } )
    }
    let page = default_page(user_id.as_str(), &payload.username, root_page_id, page_width_bl, natural_aspect);
    if let Err(e) = db.item.add(page).await {
      error!("Error adding default page: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) } )
    }
    info!("Created root user.");
  } else {
    if let Err(e) = db.pending_user.add(user.clone()).await {
      error!("Error adding user to pending user db: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) } )
    }
    info!("Added pending user '{}'.", payload.username);
  }

  json_response(&RegisterResponse { success: true, err: None })
}

fn validate_totp(totp_secret: &str, totp_token: &str) -> InfuResult<bool> {
  let totp = TOTP::new(
    TOTP_ALGORITHM, TOTP_NUM_DIGETS, TOTP_SKEW, TOTP_STEP,
    Secret::Encoded(totp_secret.to_string()).to_bytes().map_err(|e| format!("{:?}", e))?,
    None, "infumap".to_string()
  ).map_err(|e| format!("{:?}", e))?;

  let time = SystemTime::now()
    .duration_since(SystemTime::UNIX_EPOCH)?
    .as_secs();

  let token = totp.generate(time);

  Ok(token == totp_token)
}

fn sanitize_page_size(w_px: i64, h_px: i64) -> Dimensions<i64> {
  let mut w_px = w_px;
  let mut h_px = h_px;
  if (w_px as f64 / h_px as f64) < 1.0 {
    w_px = h_px;
  }
  if (w_px as f64 / h_px as f64) > 3.0 {
    w_px = h_px * 3;
  }
  if w_px > 3000 {
    w_px = 3000;
    h_px = (h_px as f64 * 3000.0 / w_px as f64) as i64;
  }
  if h_px > 2000 {
    h_px = 2000;
    w_px = (w_px as f64 * 2000.0 / h_px as f64) as i64;
  }
  Dimensions { w: w_px, h: h_px }
}

fn default_page(owner_id: &str, title: &str, root_page_id: Uid, inner_spatial_width_br: i64, natural_aspect: f64) -> Item {
  Item {
    item_type: String::from("page"),
    owner_id: String::from(owner_id),
    id: root_page_id,
    parent_id: None,
    relationship_to_parent: RelationshipToParent::NoParent,
    creation_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    last_modified_date: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64,
    ordering: vec![128],
    spatial_position_gr: Vector { x: 0, y: 0 },
    spatial_width_gr: Some(60 * GRID_SIZE),
    spatial_height_gr: None,
    title: Some(title.to_string()),
    original_creation_date: None,
    mime_type: None,
    file_size_bytes: None,
    inner_spatial_width_gr: Some(inner_spatial_width_br * GRID_SIZE),
    natural_aspect: Some(natural_aspect),
    background_color_index: Some(0),
    arrange_algorithm: Some(crate::storage::db::item::ArrangeAlgorithm::SpatialStretch),
    popup_position_gr: Some(Vector { x: 30 * GRID_SIZE, y: 15 * GRID_SIZE }),
    popup_alignment_point: Some(crate::storage::db::item::AlignmentPoint::Center),
    popup_width_gr: Some(10 * GRID_SIZE),
    grid_number_of_columns: Some(10),
    url: None,
    table_columns: None,
    image_size_px: None,
    thumbnail: None,
    rating: None,
    link_to_id: None,
  }
}


#[derive(Serialize)]
pub struct TotpResponse {
  pub success: bool,
  pub qr: Option<String>,
  pub url: Option<String>,
  pub secret: Option<String>
}

pub fn totp() -> Response<BoxBody<Bytes, hyper::Error>> {
  // A 160 bit secret is recommended by https://www.rfc-editor.org/rfc/rfc4226.
  // Construct this from the non-deterministic parts of two new v4 uuids (we require a dependency on Uuid elsewhere anyway).
  // xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
  let u_uuid = Uuid::new_v4(); let u = u_uuid.as_bytes();
  let v_uuid = Uuid::new_v4(); let v = v_uuid.as_bytes();
  let secret_bytes = vec![
    u[0], u[1], u[2], u[3], u[4], u[5], u[11], u[12], u[13], u[14],
    v[0], v[1], v[2], v[3], v[4], v[5], v[11], v[12], v[13], v[14]];

  let totp = TOTP::new(
    TOTP_ALGORITHM, TOTP_NUM_DIGETS, TOTP_SKEW, TOTP_STEP,
    secret_bytes.clone(),
    None, "infumap".to_string()
  ).unwrap();

  json_response(&TotpResponse {
    success: true,
    qr: Some(totp.get_qr().unwrap()),
    url: Some(totp.get_url()),
    secret: Some(Secret::Raw(secret_bytes).to_encoded().to_string())
  })
}


#[derive(Serialize)]
pub struct ValidateResponse {
  pub success: bool,
}

pub async fn validate(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  match get_and_validate_session(&req, db).await {
    Some(_session) => json_response(&ValidateResponse { success: true }),
    None => { json_response(&ValidateResponse { success: false }) }
  }
}
