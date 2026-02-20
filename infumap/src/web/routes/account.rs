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
use config::Config;
use http_body_util::combinators::BoxBody;
use hyper::header::{HOST, SET_COOKIE};
use hyper::{Request, Response, Method};
use infusdk::util::geometry::Dimensions;
use infusdk::util::infu::InfuResult;
use infusdk::util::time::{unix_now_secs_i64, unix_now_secs_u64};
use infusdk::util::uid::{is_uid, new_uid};
use log::{info, error, debug, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use totp_rs::{Algorithm, TOTP, Secret};
use uuid::Uuid;

use crate::config::CONFIG_BYPASS_TOTP_CHECK;
use crate::storage::db::users_extra::UserExtra;
use crate::storage::db::Db;
use crate::storage::db::user::{User, ROOT_USER_NAME};
use crate::util::crypto::generate_key;
use crate::web::cookie::SESSION_COOKIE_NAME;
use crate::web::routes::{default_dock_page, default_home_page, default_trash_page};
use crate::web::serve::{forbidden_response, incoming_json, json_response, not_found_response, cors_response};
use crate::web::session::get_and_validate_session;


const TOTP_ALGORITHM: Algorithm = Algorithm::SHA1; // The most broadly compatible algo & SHA1 is just fine for 2FA.
const TOTP_NUM_DIGITS: usize = 6; // 6 digit OTP is pretty standard.
const TOTP_SKEW: u8 = 1; // OTP is valid for this number of time intervals in the past/future.
const TOTP_STEP: u64 = 30; // Time step interval of 30 seconds is pretty standard.

const LOGIN_RATE_WINDOW_SECS: i64 = 60 * 10;
const LOGIN_RATE_LOCKOUT_SECS: i64 = 60 * 10;
const LOGIN_RATE_MAX_ATTEMPTS_PER_IP: u32 = 20;
const LOGIN_RATE_MAX_ATTEMPTS_PER_USERNAME: u32 = 8;
const LOGIN_RATE_KEY_MAX_LEN: usize = 80;
const UNKNOWN_LOGIN_PRINCIPAL: &str = "unknown";

const MIN_PASSWORD_LENGTH: usize = 10;
const MAX_PASSWORD_LENGTH: usize = 256;
const SESSION_COOKIE_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;

#[derive(Clone)]
struct LoginRateLimitEntry {
  window_started_at: i64,
  failed_attempts: u32,
  blocked_until: i64,
}

static LOGIN_RATE_LIMIT_BY_IP: Lazy<Mutex<HashMap<String, LoginRateLimitEntry>>> =
  Lazy::new(|| Mutex::new(HashMap::new()));
static LOGIN_RATE_LIMIT_BY_USERNAME: Lazy<Mutex<HashMap<String, LoginRateLimitEntry>>> =
  Lazy::new(|| Mutex::new(HashMap::new()));


pub async fn serve_account_route(config: Arc<Config>, db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  if req.method() == Method::OPTIONS {
    return cors_response();
  }

  match (req.method(), req.uri().path()) {
    (&Method::POST, "/account/login") => login(config, db, req).await,
    (&Method::POST, "/account/logout") => logout(db, req).await,
    (&Method::POST, "/account/register") => register(db, req).await,
    (&Method::POST, "/account/create-totp") => create_totp(),
    (&Method::POST, "/account/update-totp") => update_totp(db, req).await,
    (&Method::POST, "/account/change-password") => change_password(db, req).await,
    (&Method::POST, "/account/validate-session") => validate(db, req).await,
    (&Method::POST, "/account/extra") => extra(db, req).await,
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
  #[serde(rename="homePageId")]
  pub home_page_id: Option<String>,
  #[serde(rename="trashPageId")]
  pub trash_page_id: Option<String>,
  #[serde(rename="dockPageId")]
  pub dock_page_id: Option<String>,
  #[serde(rename="hasTotp")]
  pub has_totp: bool,
}

pub async fn login(config: Arc<Config>, db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let bypass_totp_check = config.get_bool(CONFIG_BYPASS_TOTP_CHECK).unwrap_or(false);
  let client_ip_key = client_ip_rate_limit_key(&req);
  let secure_cookie = should_use_secure_cookie(&req);

  async fn failed_response(msg: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
    sleep(Duration::from_millis(250)).await;
    return json_response(&LoginResponse {
      success: false, session_id: None, user_id: None, home_page_id: None, trash_page_id: None, dock_page_id: None, has_totp: false,
      err: Some(String::from(msg))
    });
  }

  let payload: LoginRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      error!("Could not parse login request: {}", e);
      record_login_failure(&client_ip_key, UNKNOWN_LOGIN_PRINCIPAL).await;
      return failed_response("server error").await;
    }
  };

  let username_key = username_rate_limit_key(&payload.username);
  if is_login_rate_limited(&client_ip_key, &username_key).await {
    info!("Blocking login attempt due to rate limit. ip='{}', user='{}'.", client_ip_key, username_key);
    return failed_response("credentials incorrect").await;
  }

  let user = {
    let db = db.lock().await;
    db.user.get_by_username_case_insensitive(&payload.username).cloned()
  };

  let user = match user {
    Some(user) => user,
    None => {
      info!("A login was attempted for a user '{}' that does not exist.", payload.username);
      record_login_failure(&client_ip_key, &username_key).await;
      return failed_response("credentials incorrect").await;
    }
  };

  let password_ok = match User::verify_password(&user.password_hash, &payload.password) {
    Ok(v) => v,
    Err(e) => {
      error!("An error occurred verifying password hash for user '{}': {}", payload.username, e);
      return failed_response("server error").await;
    }
  };
  if !password_ok {
    info!("A login attempt for user '{}' failed due to incorrect password.", payload.username);
    record_login_failure(&client_ip_key, &username_key).await;
    return failed_response("credentials incorrect").await;
  }

  // TOTP validation - skipped if bypass_totp_check is enabled
  if !bypass_totp_check {
    if let Some(totp_secret) = &user.totp_secret {
      if let Some(totp_token) = &payload.totp_token {
        match validate_totp(totp_secret, totp_token) {
          Err(e) => {
            info!("An error occurred whilst trying to validate a TOTP token for user '{}': {}", payload.username, e);
            return failed_response("server error").await;
          },
          Ok(v) => {
            if !v {
              info!("A login attempt for user '{}' failed due to an incorrect TOTP.", payload.username);
              record_login_failure(&client_ip_key, &username_key).await;
              return failed_response("credentials incorrect").await;
            }
          }
        };
      } else {
        info!("A login attempt for user '{}' failed because a TOTP was not specified.", payload.username);
        record_login_failure(&client_ip_key, &username_key).await;
        return failed_response("credentials incorrect").await;
      }
    } else {
      if payload.totp_token.is_some() {
        info!("A login attempt for user '{}' failed because a TOTP token was specified, but this is not expected.", payload.username);
        record_login_failure(&client_ip_key, &username_key).await;
        return failed_response("credentials incorrect").await;
      }
    }
  } else {
    info!("TOTP check bypassed for user '{}' due to configuration.", payload.username);
  }

  let created_session = {
    let mut db = db.lock().await;
    db.session.create_session(&user.id, &user.username).await
  };

  match created_session {
    Ok(session) => {
      clear_login_failures_for_username(&username_key).await;
      let result = LoginResponse {
        success: true,
        session_id: Some(session.id.clone()),
        user_id: Some(user.id),
        home_page_id: Some(user.home_page_id),
        trash_page_id: Some(user.trash_page_id),
        dock_page_id: Some(user.dock_page_id),
        has_totp: user.totp_secret.is_some(),
        err: None
      };
      let mut response = json_response(&result);
      set_cookie_header(&mut response, build_session_cookie_value(&session.id, secure_cookie));
      return response;
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
  let secure_cookie = should_use_secure_cookie(&req);
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      debug!("Could not log out user session: no valid session is present.");
      let mut response = json_response(&LogoutResponse { success: false });
      set_cookie_header(&mut response, build_clear_session_cookie_value(secure_cookie));
      return response;
    }
  };

  let mut db = db.lock().await;

  match db.session.delete_session(&session.id).await {
    Err(e) => {
      warn!(
        "Could not delete session '{}' for user '{}': {}",
        session.id, session.user_id, e);
      let mut response = json_response(&LogoutResponse { success: false });
      set_cookie_header(&mut response, build_clear_session_cookie_value(secure_cookie));
      return response;
    },
    Ok(user_id) => {
      if user_id != session.user_id {
        error!(
          "Unexpected user_id '{}' deleting session '{}'. Session is associated with user: '{}'",
          session.user_id, session.id, user_id);
        let mut response = json_response(&LogoutResponse { success: false });
        set_cookie_header(&mut response, build_clear_session_cookie_value(secure_cookie));
        return response;
      }
    }
  };

  let mut response = json_response(&LogoutResponse { success: true });
  set_cookie_header(&mut response, build_clear_session_cookie_value(secure_cookie));
  response
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
     is_uid(&payload.username) ||
     payload.username.len() > 16 ||
     RESERVED_NAMES.contains(&payload.username.as_str()) {
    return json_response(&RegisterResponse { success: false, err: Some(String::from("username not available")) } )
  }

  const NATURAL_BLOCK_SIZE_PX: i64 = 24;
  let page_size_px = sanitize_page_size(payload.page_width_px, payload.page_height_px);
  let page_width_bl = page_size_px.w / NATURAL_BLOCK_SIZE_PX;
  let natural_aspect = ((page_size_px.w as f64) / (page_size_px.h as f64) * 1000.0).round() / 1000.0;
  if payload.username.len() < 3 {
    return json_response(&RegisterResponse { success: false, err: Some(String::from("username must be 3 or more characters")) } )
  }
  if let Err(msg) = validate_password_policy(&payload.password) {
    return json_response(&RegisterResponse { success: false, err: Some(String::from(msg)) } )
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
  let home_page_id = new_uid();
  let trash_page_id = new_uid();
  let dock_page_id = new_uid();
  let password_salt = new_uid();
  let password_hash = match User::hash_password(&payload.password) {
    Ok(hash) => hash,
    Err(e) => {
      error!("Error hashing password for new user '{}': {}", payload.username, e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
  };

  let user = User {
    id: user_id.clone(),
    username: payload.username.clone(),
    password_hash,
    password_salt,
    totp_secret: payload.totp_secret.clone(),
    home_page_id: home_page_id.clone(),
    trash_page_id: trash_page_id.clone(),
    dock_page_id: dock_page_id.clone(),
    default_page_width_bl: 60,
    default_page_natural_aspect: 2.0,
    object_encryption_key: generate_key()
  };

  if payload.username == ROOT_USER_NAME {
    if let Err(e) = db.user.add(user.clone()).await {
      error!("Error adding user: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    if let Err(e) = db.item.load_user_items(&user.id, true).await {
      error!("Error initializing item store for user '{}': {}", user.id, e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    if let Err(e) = db.session.create(&user.id).await {
      error!("Error creating session store for user '{}': {}", user.id, e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    if let Err(e) = db.ingest_session.create(&user.id).await {
      error!("Error creating ingest session store for user '{}': {}", user.id, e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    let home_page = default_home_page(user_id.as_str(), &payload.username, home_page_id, page_width_bl, natural_aspect);
    if let Err(e) = db.item.add(home_page).await {
      error!("Error adding default page: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    let trash_page = default_trash_page(user_id.as_str(), trash_page_id, natural_aspect);
    if let Err(e) = db.item.add(trash_page).await {
      error!("Error adding default trash page: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    let dock_page = default_dock_page(user_id.as_str(), dock_page_id, natural_aspect);
    if let Err(e) = db.item.add(dock_page).await {
      error!("Error adding default dock page: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    info!("Created root user.");
  } else {
    if let Err(e) = db.pending_user.add(user.clone()).await {
      error!("Error adding user to pending user db: {}", e);
      return json_response(&RegisterResponse { success: false, err: Some(String::from("server error")) });
    }
    info!("Added pending user '{}'.", payload.username);
  }

  json_response(&RegisterResponse { success: true, err: None })
}

#[derive(Deserialize)]
pub struct UpdateTotpRequest {
  #[serde(rename="userId")]
  user_id: String,
  #[serde(rename="totpSecret")]
  totp_secret: Option<String>,
  #[serde(rename="totpToken")]
  totp_token: Option<String>,
}

#[derive(Serialize)]
pub struct UpdateTotpResponse {
  success: bool,
  err: Option<String>
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
  #[serde(rename="userId")]
  user_id: String,
  #[serde(rename="currentPassword")]
  current_password: String,
  #[serde(rename="newPassword")]
  new_password: String,
}

#[derive(Serialize)]
pub struct ChangePasswordResponse {
  success: bool,
  err: Option<String>
}

pub async fn update_totp(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      warn!("Could not update totp: no valid session is present.");
      return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("auth")) } );
    }
  };

  let payload: UpdateTotpRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      error!("Could not parse update totp request: {}", e);
      return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("application error")) } );
    }
  };

  if payload.user_id != session.user_id {
    warn!(
      "Could not update totp: session user '{}' does not match request user '{}'.",
      session.user_id, payload.user_id);
    return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("auth")) } );
  }

  let mut db = db.lock().await;

  let mut user = match db.user.get(&session.user_id).ok_or(()) {
    Err(_) => {
      error!("User {} does not exist updating totp.", session.user_id);
      return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("application error")) } );
    },
    Ok(u) => u
  }.clone();

  if let Some(totp_secret) = &payload.totp_secret {
    if let Some(totp_token) = &payload.totp_token {
      match validate_totp(totp_secret, totp_token) {
        Err(e) => {
          error!("Error occurred validating TOTP token (update): {}", e);
          return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("server error")) } );
        },
        Ok(v) => {
          if !v { return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("incorrect OTP")) } ); }
        }
      }
      user.totp_secret = Some(totp_secret.clone());
    } else {
      error!("If totp secret is set, token must also be set.");
      return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("application error")) } );
    }
  } else {
    if payload.totp_token.is_some() {
      error!("If totp secret is not set, token must also be not set.");
      return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("application error")) } );
    }
    user.totp_secret = None;
  }

  if let Err(e) = db.user.update(&user).await {
    error!("User {}: failed to update totp: {}", session.user_id, e);
    return json_response(&UpdateTotpResponse { success: false, err: Some(String::from("server error")) } );
  };

  json_response(&UpdateTotpResponse { success: true, err: None })
}

pub async fn change_password(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      warn!("Could not change password: no valid session is present.");
      return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("auth")) });
    }
  };

  let payload: ChangePasswordRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      error!("Could not parse change password request: {}", e);
      return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("application error")) });
    }
  };

  if payload.user_id != session.user_id {
    warn!(
      "Could not change password: session user '{}' does not match request user '{}'.",
      session.user_id, payload.user_id);
    return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("auth")) });
  }

  if payload.current_password == payload.new_password {
    return json_response(&ChangePasswordResponse {
      success: false,
      err: Some(String::from("new password must be different")),
    });
  }

  if let Err(msg) = validate_password_policy(&payload.new_password) {
    return json_response(&ChangePasswordResponse {
      success: false,
      err: Some(String::from(msg)),
    });
  }

  let user = {
    let db = db.lock().await;
    db.user.get(&session.user_id).cloned()
  };

  let user = match user {
    Some(u) => u,
    None => {
      error!("User {} does not exist changing password.", session.user_id);
      return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("application error")) });
    }
  };

  let current_password_ok = match User::verify_password(&user.password_hash, &payload.current_password) {
    Ok(v) => v,
    Err(e) => {
      error!("An error occurred verifying current password hash for user '{}': {}", user.username, e);
      return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("server error")) });
    }
  };
  if !current_password_ok {
    sleep(Duration::from_millis(250)).await;
    return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("current password incorrect")) });
  }

  let new_password_hash = match User::hash_password(&payload.new_password) {
    Ok(v) => v,
    Err(e) => {
      error!("Error hashing new password for user '{}': {}", user.username, e);
      return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("server error")) });
    }
  };
  let new_password_salt = new_uid();

  let update_result = {
    let mut db = db.lock().await;
    db.user.update_password_hash_and_salt(&session.user_id, &new_password_hash, &new_password_salt).await
  };

  if let Err(e) = update_result {
    error!("User {}: failed to update password hash: {}", session.user_id, e);
    return json_response(&ChangePasswordResponse { success: false, err: Some(String::from("server error")) });
  };

  json_response(&ChangePasswordResponse { success: true, err: None })
}

fn validate_totp(totp_secret: &str, totp_token: &str) -> InfuResult<bool> {
  let totp = TOTP::new(
    TOTP_ALGORITHM, TOTP_NUM_DIGITS, TOTP_SKEW, TOTP_STEP,
    Secret::Encoded(totp_secret.to_string()).to_bytes().map_err(|e| format!("{:?}", e))?,
    None, "infumap".to_string()
  ).map_err(|e| format!("{:?}", e))?;

  let token = totp.generate(unix_now_secs_u64().unwrap());

  Ok(token == totp_token)
}

fn should_use_secure_cookie(req: &Request<hyper::body::Incoming>) -> bool {
  if let Some(xfp) = req.headers().get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
    if let Some(proto) = xfp.split(',').next() {
      return proto.trim().eq_ignore_ascii_case("https");
    }
  }

  if let Some(host) = req.headers().get(HOST).and_then(|v| v.to_str().ok()) {
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" {
      return false;
    }
  }

  true
}

fn build_session_cookie_value(session_id: &str, secure: bool) -> String {
  let mut cookie = format!(
    "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
    SESSION_COOKIE_NAME,
    session_id,
    SESSION_COOKIE_MAX_AGE_SECS
  );
  if secure {
    cookie.push_str("; Secure");
  }
  cookie
}

fn build_clear_session_cookie_value(secure: bool) -> String {
  let mut cookie = format!("{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", SESSION_COOKIE_NAME);
  if secure {
    cookie.push_str("; Secure");
  }
  cookie
}

fn set_cookie_header(response: &mut Response<BoxBody<Bytes, hyper::Error>>, value: String) {
  match hyper::header::HeaderValue::from_str(&value) {
    Ok(header_value) => {
      response.headers_mut().append(SET_COOKIE, header_value);
    },
    Err(e) => {
      warn!("Could not set session cookie header: {}", e);
    }
  }
}

fn validate_password_policy(password: &str) -> Result<(), &'static str> {
  if password.len() < MIN_PASSWORD_LENGTH {
    return Err("password must be 10 or more characters");
  }
  if password.len() > MAX_PASSWORD_LENGTH {
    return Err("password must be 256 or fewer characters");
  }
  if password.chars().any(|c| c.is_control()) {
    return Err("password contains invalid characters");
  }
  if !password.chars().any(|c| c.is_ascii_alphabetic()) || !password.chars().any(|c| c.is_ascii_digit()) {
    return Err("password must include at least one letter and one number");
  }
  Ok(())
}

fn sanitize_rate_limit_key(raw: &str) -> String {
  raw.chars()
    .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == ':' || *c == '-' || *c == '_')
    .take(LOGIN_RATE_KEY_MAX_LEN)
    .collect::<String>()
}

fn username_rate_limit_key(username: &str) -> String {
  let normalized = sanitize_rate_limit_key(&username.trim().to_ascii_lowercase());
  if normalized.is_empty() {
    UNKNOWN_LOGIN_PRINCIPAL.to_owned()
  } else {
    normalized
  }
}

fn client_ip_rate_limit_key(req: &Request<hyper::body::Incoming>) -> String {
  let from_forwarded_for = req.headers().get("x-forwarded-for")
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.split(',').next())
    .map(|v| sanitize_rate_limit_key(v.trim()))
    .filter(|v| !v.is_empty());

  if let Some(v) = from_forwarded_for {
    return format!("xff:{}", v);
  }

  let from_real_ip = req.headers().get("x-real-ip")
    .and_then(|v| v.to_str().ok())
    .map(|v| sanitize_rate_limit_key(v.trim()))
    .filter(|v| !v.is_empty());

  if let Some(v) = from_real_ip {
    return format!("xri:{}", v);
  }

  UNKNOWN_LOGIN_PRINCIPAL.to_owned()
}

fn now_for_rate_limit() -> i64 {
  match unix_now_secs_i64() {
    Ok(now) => now,
    Err(e) => {
      warn!("Could not read wall clock for login rate limiting: {}", e);
      0
    }
  }
}

fn prune_rate_limit_entries(map: &mut HashMap<String, LoginRateLimitEntry>, now: i64) {
  map.retain(|_, entry| {
    if entry.blocked_until > now {
      return true;
    }
    entry.window_started_at + LOGIN_RATE_WINDOW_SECS > now
  });
}

fn is_entry_limited(entry_maybe: Option<&LoginRateLimitEntry>, now: i64, max_attempts: u32) -> bool {
  match entry_maybe {
    None => false,
    Some(entry) => {
      if entry.blocked_until > now {
        return true;
      }
      entry.window_started_at + LOGIN_RATE_WINDOW_SECS > now && entry.failed_attempts >= max_attempts
    }
  }
}

fn add_login_failure(map: &mut HashMap<String, LoginRateLimitEntry>, key: &str, max_attempts: u32, now: i64) {
  let entry = map.entry(key.to_owned()).or_insert(LoginRateLimitEntry {
    window_started_at: now,
    failed_attempts: 0,
    blocked_until: 0,
  });

  if entry.window_started_at + LOGIN_RATE_WINDOW_SECS <= now {
    entry.window_started_at = now;
    entry.failed_attempts = 0;
    entry.blocked_until = 0;
  }

  if entry.blocked_until > now {
    return;
  }

  entry.failed_attempts += 1;
  if entry.failed_attempts >= max_attempts {
    entry.blocked_until = now + LOGIN_RATE_LOCKOUT_SECS;
  }
}

async fn is_login_rate_limited(client_ip_key: &str, username_key: &str) -> bool {
  let now = now_for_rate_limit();

  if client_ip_key != UNKNOWN_LOGIN_PRINCIPAL {
    let ip_limited = {
      let mut by_ip = LOGIN_RATE_LIMIT_BY_IP.lock().await;
      prune_rate_limit_entries(&mut by_ip, now);
      is_entry_limited(by_ip.get(client_ip_key), now, LOGIN_RATE_MAX_ATTEMPTS_PER_IP)
    };
    if ip_limited {
      return true;
    }
  }

  let mut by_username = LOGIN_RATE_LIMIT_BY_USERNAME.lock().await;
  prune_rate_limit_entries(&mut by_username, now);
  is_entry_limited(by_username.get(username_key), now, LOGIN_RATE_MAX_ATTEMPTS_PER_USERNAME)
}

async fn record_login_failure(client_ip_key: &str, username_key: &str) {
  let now = now_for_rate_limit();

  if client_ip_key != UNKNOWN_LOGIN_PRINCIPAL {
    let mut by_ip = LOGIN_RATE_LIMIT_BY_IP.lock().await;
    prune_rate_limit_entries(&mut by_ip, now);
    add_login_failure(&mut by_ip, client_ip_key, LOGIN_RATE_MAX_ATTEMPTS_PER_IP, now);
  }

  let mut by_username = LOGIN_RATE_LIMIT_BY_USERNAME.lock().await;
  prune_rate_limit_entries(&mut by_username, now);
  add_login_failure(&mut by_username, username_key, LOGIN_RATE_MAX_ATTEMPTS_PER_USERNAME, now);
}

async fn clear_login_failures_for_username(username_key: &str) {
  let mut by_username = LOGIN_RATE_LIMIT_BY_USERNAME.lock().await;
  by_username.remove(username_key);
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


#[derive(Serialize)]
pub struct TotpResponse {
  pub success: bool,
  pub qr: Option<String>,
  pub url: Option<String>,
  pub secret: Option<String>
}

pub fn create_totp() -> Response<BoxBody<Bytes, hyper::Error>> {
  // A 160 bit secret is recommended by https://www.rfc-editor.org/rfc/rfc4226.
  // Construct this from the non-deterministic parts of two new v4 uuids (we require a dependency on Uuid elsewhere anyway).
  // xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
  let u_uuid = Uuid::new_v4(); let u = u_uuid.as_bytes();
  let v_uuid = Uuid::new_v4(); let v = v_uuid.as_bytes();
  let secret_bytes = vec![
    u[0], u[1], u[2], u[3], u[4], u[5], u[11], u[12], u[13], u[14],
    v[0], v[1], v[2], v[3], v[4], v[5], v[11], v[12], v[13], v[14]];

  let totp = TOTP::new(
    TOTP_ALGORITHM, TOTP_NUM_DIGITS, TOTP_SKEW, TOTP_STEP,
    secret_bytes.clone(),
    None, "infumap".to_string()
  ).unwrap();

  json_response(&TotpResponse {
    success: true,
    qr: Some(totp.get_qr_base64().unwrap()),
    url: Some(totp.get_url()),
    secret: Some(Secret::Raw(secret_bytes).to_encoded().to_string())
  })
}


#[derive(Serialize)]
pub struct ValidateResponse {
  pub success: bool,
  #[serde(rename="username")]
  pub username: Option<String>,
  #[serde(rename="userId")]
  pub user_id: Option<String>,
  #[serde(rename="homePageId")]
  pub home_page_id: Option<String>,
  #[serde(rename="trashPageId")]
  pub trash_page_id: Option<String>,
  #[serde(rename="dockPageId")]
  pub dock_page_id: Option<String>,
  #[serde(rename="hasTotp")]
  pub has_totp: Option<bool>,
}

pub async fn validate(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      return json_response(&ValidateResponse {
        success: false,
        username: None,
        user_id: None,
        home_page_id: None,
        trash_page_id: None,
        dock_page_id: None,
        has_totp: None,
      });
    }
  };

  let user = {
    let db = db.lock().await;
    db.user.get(&session.user_id).cloned()
  };

  match user {
    None => {
      warn!("Session '{}' references unknown user '{}'.", session.id, session.user_id);
      json_response(&ValidateResponse {
        success: false,
        username: None,
        user_id: None,
        home_page_id: None,
        trash_page_id: None,
        dock_page_id: None,
        has_totp: None,
      })
    },
    Some(user) => {
      json_response(&ValidateResponse {
        success: true,
        username: Some(user.username),
        user_id: Some(user.id),
        home_page_id: Some(user.home_page_id),
        trash_page_id: Some(user.trash_page_id),
        dock_page_id: Some(user.dock_page_id),
        has_totp: Some(user.totp_secret.is_some()),
      })
    }
  }
}


pub async fn extra(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session_maybe = get_and_validate_session(&req, db).await;

  match session_maybe {
    None => {
      forbidden_response()
    },
    Some(s) => {
      let user_extra = match db.lock().await.user_extra.get(&s.user_id) {
        None => {
          UserExtra {
            id: s.user_id.clone(),
            last_backup_time: 0,
            last_failed_backup_time: 0
          }
        },
        Some(s) => s.clone()
      };
      json_response(&user_extra)
    }
  }
}
