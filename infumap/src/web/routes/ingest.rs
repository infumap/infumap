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

use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::header::AUTHORIZATION;
use hyper::{Method, Request, Response};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::storage::db::ingest_session::IngestSession;
use crate::storage::db::Db;
use crate::storage::object;
use crate::web::routes::command::add_item_for_user;
use crate::web::serve::{cors_response, incoming_json, incoming_json_with_limit, json_response, not_found_response};
use crate::web::session::get_and_validate_session;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{new_uid, Uid};


const REASON_AUTH: &str = "auth";
const REASON_CLIENT: &str = "client";
const REASON_SERVER: &str = "server";

const PAIRING_CODE_TTL_SECS: i64 = 60 * 5;
const ACCESS_TOKEN_TTL_SECS: i64 = 60 * 10;
const REFRESH_TOKEN_TTL_SECS: i64 = 60 * 60 * 24 * 180;

const DEFAULT_DEVICE_NAME: &str = "Chrome extension";
// Uploads are sent as base64 inside JSON. 256 MiB request limit supports roughly
// 190+ MiB raw files while remaining bounded.
const INGEST_ADD_ITEM_REQUEST_MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone)]
struct PairingCode {
  user_id: Uid,
  device_name: Option<String>,
  expires_at: i64,
}

static PAIRING_CODES: Lazy<Mutex<HashMap<String, PairingCode>>> = Lazy::new(|| Mutex::new(HashMap::new()));


pub async fn serve_ingest_route(
    db: &Arc<Mutex<Db>>,
    object_store: &Arc<object::ObjectStore>,
    req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  if req.method() == Method::OPTIONS {
    return cors_response();
  }

  match (req.method(), req.uri().path()) {
    (&Method::POST, "/ingest/pairing/create") => create_pairing_code(db, req).await,
    (&Method::POST, "/ingest/pairing/redeem") => redeem_pairing_code(db, req).await,
    (&Method::POST, "/ingest/token/refresh") => refresh_token(db, req).await,
    (&Method::POST, "/ingest/token/revoke") => revoke_token(db, req).await,
    (&Method::POST, "/ingest/sessions/list") => list_sessions(db, req).await,
    (&Method::POST, "/ingest/sessions/revoke") => revoke_session(db, req).await,
    (&Method::POST, "/ingest/add-item") => add_item(db, object_store.clone(), req).await,
    _ => not_found_response()
  }
}


#[derive(Serialize)]
struct IngestSimpleResponse {
  success: bool,
  err: Option<String>,
}

#[derive(Serialize)]
struct CreatePairingCodeResponse {
  success: bool,
  err: Option<String>,
  #[serde(rename = "pairingCode")]
  pairing_code: Option<String>,
  #[serde(rename = "expiresAt")]
  expires_at: Option<i64>,
}

#[derive(Deserialize)]
struct CreatePairingCodeRequest {
  #[serde(rename = "deviceName")]
  device_name: Option<String>,
}

async fn create_pairing_code(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      return json_response(&CreatePairingCodeResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
        pairing_code: None,
        expires_at: None,
      });
    }
  };

  let payload: CreatePairingCodeRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse create pairing code request: {}", e);
      return json_response(&CreatePairingCodeResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
        pairing_code: None,
        expires_at: None,
      });
    }
  };

  let now_unix_secs = match now_unix_secs() {
    Ok(t) => t,
    Err(e) => {
      error!("Could not mint pairing code due to clock issue: {}", e);
      return json_response(&CreatePairingCodeResponse {
        success: false,
        err: Some(REASON_SERVER.to_owned()),
        pairing_code: None,
        expires_at: None,
      });
    }
  };

  let expires_at = now_unix_secs + PAIRING_CODE_TTL_SECS;
  let sanitized_device_name = sanitize_device_name(payload.device_name.as_deref());

  let mut pairing_codes = PAIRING_CODES.lock().await;
  pairing_codes.retain(|_, code| code.expires_at > now_unix_secs);

  let mut pairing_code = String::new();
  let mut pairing_code_hash = String::new();
  let mut found_unique = false;
  for _ in 0..8 {
    pairing_code = generate_pairing_code();
    pairing_code_hash = hash_token(&normalize_pairing_code(&pairing_code));
    if !pairing_codes.contains_key(&pairing_code_hash) {
      found_unique = true;
      break;
    }
  }

  if !found_unique {
    error!("Could not allocate unique pairing code.");
    return json_response(&CreatePairingCodeResponse {
      success: false,
      err: Some(REASON_SERVER.to_owned()),
      pairing_code: None,
      expires_at: None,
    });
  }

  pairing_codes.insert(pairing_code_hash, PairingCode {
    user_id: session.user_id.clone(),
    device_name: Some(sanitized_device_name),
    expires_at,
  });

  json_response(&CreatePairingCodeResponse {
    success: true,
    err: None,
    pairing_code: Some(pairing_code),
    expires_at: Some(expires_at),
  })
}


#[derive(Deserialize)]
struct RedeemPairingCodeRequest {
  #[serde(rename = "pairingCode")]
  pairing_code: String,
  #[serde(rename = "deviceName")]
  device_name: Option<String>,
}

#[derive(Serialize)]
struct RedeemPairingCodeResponse {
  success: bool,
  err: Option<String>,
  #[serde(rename = "ingestSessionId")]
  ingest_session_id: Option<String>,
  #[serde(rename = "deviceName")]
  device_name: Option<String>,
  #[serde(rename = "accessToken")]
  access_token: Option<String>,
  #[serde(rename = "accessExpires")]
  access_expires: Option<i64>,
  #[serde(rename = "refreshToken")]
  refresh_token: Option<String>,
  #[serde(rename = "refreshExpires")]
  refresh_expires: Option<i64>,
}

async fn redeem_pairing_code(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let payload: RedeemPairingCodeRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse pairing code redeem request: {}", e);
      return json_response(&RedeemPairingCodeResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
        ingest_session_id: None,
        device_name: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  let normalized_pairing_code = normalize_pairing_code(&payload.pairing_code);
  if normalized_pairing_code.len() < 8 {
    return json_response(&RedeemPairingCodeResponse {
      success: false,
      err: Some(REASON_AUTH.to_owned()),
      ingest_session_id: None,
      device_name: None,
      access_token: None,
      access_expires: None,
      refresh_token: None,
      refresh_expires: None,
    });
  }

  let now_unix_secs = match now_unix_secs() {
    Ok(t) => t,
    Err(e) => {
      error!("Could not redeem pairing code due to clock issue: {}", e);
      return json_response(&RedeemPairingCodeResponse {
        success: false,
        err: Some(REASON_SERVER.to_owned()),
        ingest_session_id: None,
        device_name: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  let pairing_code_hash = hash_token(&normalized_pairing_code);
  let pairing_code = {
    let mut pairing_codes = PAIRING_CODES.lock().await;
    pairing_codes.retain(|_, code| code.expires_at > now_unix_secs);
    pairing_codes.remove(&pairing_code_hash)
  };

  let pairing_code = match pairing_code {
    Some(code) => code,
    None => {
      return json_response(&RedeemPairingCodeResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
        ingest_session_id: None,
        device_name: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  if pairing_code.expires_at <= now_unix_secs {
    return json_response(&RedeemPairingCodeResponse {
      success: false,
      err: Some(REASON_AUTH.to_owned()),
      ingest_session_id: None,
      device_name: None,
      access_token: None,
      access_expires: None,
      refresh_token: None,
      refresh_expires: None,
    });
  }

  let ingest_session_id = new_uid();
  let access_token = generate_secret_token("ibat");
  let refresh_token = generate_secret_token("ibrt");
  let device_name = sanitize_device_name(payload.device_name
    .as_deref()
    .or(pairing_code.device_name.as_deref()));
  let access_expires = now_unix_secs + ACCESS_TOKEN_TTL_SECS;
  let refresh_expires = now_unix_secs + REFRESH_TOKEN_TTL_SECS;

  let ingest_session = IngestSession {
    id: ingest_session_id.clone(),
    user_id: pairing_code.user_id.clone(),
    device_name: device_name.clone(),
    access_token_hash: hash_token(&access_token),
    access_expires,
    refresh_token_hash: hash_token(&refresh_token),
    refresh_expires,
    created_at: now_unix_secs,
    last_used_at: now_unix_secs,
    revoked: false,
  };

  let mut db = db.lock().await;
  if let Err(e) = db.ingest_session.add_session(ingest_session).await {
    error!("Could not create ingest session for user '{}': {}", pairing_code.user_id, e);
    return json_response(&RedeemPairingCodeResponse {
      success: false,
      err: Some(REASON_SERVER.to_owned()),
      ingest_session_id: None,
      device_name: None,
      access_token: None,
      access_expires: None,
      refresh_token: None,
      refresh_expires: None,
    });
  }

  info!("Created ingest session '{}' for user '{}'.", ingest_session_id, pairing_code.user_id);

  json_response(&RedeemPairingCodeResponse {
    success: true,
    err: None,
    ingest_session_id: Some(ingest_session_id),
    device_name: Some(device_name),
    access_token: Some(access_token),
    access_expires: Some(access_expires),
    refresh_token: Some(refresh_token),
    refresh_expires: Some(refresh_expires),
  })
}


#[derive(Deserialize)]
struct RefreshTokenRequest {
  #[serde(rename = "refreshToken")]
  refresh_token: String,
}

#[derive(Serialize)]
struct RefreshTokenResponse {
  success: bool,
  err: Option<String>,
  #[serde(rename = "ingestSessionId")]
  ingest_session_id: Option<String>,
  #[serde(rename = "accessToken")]
  access_token: Option<String>,
  #[serde(rename = "accessExpires")]
  access_expires: Option<i64>,
  #[serde(rename = "refreshToken")]
  refresh_token: Option<String>,
  #[serde(rename = "refreshExpires")]
  refresh_expires: Option<i64>,
}

async fn refresh_token(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let payload: RefreshTokenRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse refresh token request: {}", e);
      return json_response(&RefreshTokenResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
        ingest_session_id: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  let now_unix_secs = match now_unix_secs() {
    Ok(t) => t,
    Err(e) => {
      error!("Could not refresh token due to clock issue: {}", e);
      return json_response(&RefreshTokenResponse {
        success: false,
        err: Some(REASON_SERVER.to_owned()),
        ingest_session_id: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  let refresh_token_hash = hash_token(&payload.refresh_token);

  let mut db = db.lock().await;
  let mut ingest_session = match db.ingest_session.get_active_by_refresh_hash(&refresh_token_hash) {
    Some(s) => s,
    None => {
      return json_response(&RefreshTokenResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
        ingest_session_id: None,
        access_token: None,
        access_expires: None,
        refresh_token: None,
        refresh_expires: None,
      });
    }
  };

  let access_token = generate_secret_token("ibat");
  let refresh_token = generate_secret_token("ibrt");
  let access_expires = now_unix_secs + ACCESS_TOKEN_TTL_SECS;
  let refresh_expires = now_unix_secs + REFRESH_TOKEN_TTL_SECS;

  ingest_session.access_token_hash = hash_token(&access_token);
  ingest_session.access_expires = access_expires;
  ingest_session.refresh_token_hash = hash_token(&refresh_token);
  ingest_session.refresh_expires = refresh_expires;
  ingest_session.last_used_at = now_unix_secs;

  if let Err(e) = db.ingest_session.update_session(ingest_session.clone()).await {
    error!("Could not update ingest session '{}': {}", ingest_session.id, e);
    return json_response(&RefreshTokenResponse {
      success: false,
      err: Some(REASON_SERVER.to_owned()),
      ingest_session_id: None,
      access_token: None,
      access_expires: None,
      refresh_token: None,
      refresh_expires: None,
    });
  }

  json_response(&RefreshTokenResponse {
    success: true,
    err: None,
    ingest_session_id: Some(ingest_session.id),
    access_token: Some(access_token),
    access_expires: Some(access_expires),
    refresh_token: Some(refresh_token),
    refresh_expires: Some(refresh_expires),
  })
}


#[derive(Deserialize)]
struct RevokeTokenRequest {
  #[serde(rename = "refreshToken")]
  refresh_token: String,
}

async fn revoke_token(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let payload: RevokeTokenRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse revoke token request: {}", e);
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
      });
    }
  };

  let now_unix_secs = match now_unix_secs() {
    Ok(t) => t,
    Err(e) => {
      error!("Could not revoke token due to clock issue: {}", e);
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_SERVER.to_owned()),
      });
    }
  };

  let refresh_token_hash = hash_token(&payload.refresh_token);

  let mut db = db.lock().await;
  let mut ingest_session = match db.ingest_session.get_active_by_refresh_hash(&refresh_token_hash) {
    Some(s) => s,
    None => {
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
      });
    }
  };

  ingest_session.revoked = true;
  ingest_session.last_used_at = now_unix_secs;
  match db.ingest_session.update_session(ingest_session.clone()).await {
    Ok(_) => {
      info!("Revoked ingest session '{}' via refresh token.", ingest_session.id);
      json_response(&IngestSimpleResponse { success: true, err: None })
    },
    Err(e) => {
      error!("Could not revoke ingest session '{}': {}", ingest_session.id, e);
      json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_SERVER.to_owned()),
      })
    }
  }
}


#[derive(Serialize)]
struct IngestSessionSummary {
  id: String,
  #[serde(rename = "deviceName")]
  device_name: String,
  #[serde(rename = "createdAt")]
  created_at: i64,
  #[serde(rename = "lastUsedAt")]
  last_used_at: i64,
  #[serde(rename = "accessExpires")]
  access_expires: i64,
  #[serde(rename = "refreshExpires")]
  refresh_expires: i64,
  revoked: bool,
}

#[derive(Serialize)]
struct ListSessionsResponse {
  success: bool,
  err: Option<String>,
  sessions: Option<Vec<IngestSessionSummary>>,
}

async fn list_sessions(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      return json_response(&ListSessionsResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
        sessions: None,
      });
    }
  };

  let db = db.lock().await;
  let mut sessions = db.ingest_session.list_sessions_for_user(&session.user_id);
  sessions.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));

  let summaries = sessions.iter()
    .map(|s| IngestSessionSummary {
      id: s.id.clone(),
      device_name: s.device_name.clone(),
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      access_expires: s.access_expires,
      refresh_expires: s.refresh_expires,
      revoked: s.revoked,
    })
    .collect::<Vec<_>>();

  json_response(&ListSessionsResponse {
    success: true,
    err: None,
    sessions: Some(summaries),
  })
}


#[derive(Deserialize)]
struct RevokeSessionRequest {
  #[serde(rename = "sessionId")]
  session_id: String,
}

async fn revoke_session(db: &Arc<Mutex<Db>>, req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let session = match get_and_validate_session(&req, db).await {
    Some(s) => s,
    None => {
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
      });
    }
  };

  let payload: RevokeSessionRequest = match incoming_json(req).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse revoke ingest session request: {}", e);
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
      });
    }
  };

  let mut db = db.lock().await;
  match db.ingest_session.revoke_session(&session.user_id, &payload.session_id).await {
    Ok(_) => {
      info!("Revoked ingest session '{}' for user '{}'.", payload.session_id, session.user_id);
      json_response(&IngestSimpleResponse { success: true, err: None })
    },
    Err(e) => {
      warn!("Could not revoke ingest session '{}': {}", payload.session_id, e);
      json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
      })
    }
  }
}


#[derive(Deserialize)]
struct AddItemRequest {
  #[serde(rename = "jsonData")]
  json_data: String,
  #[serde(rename = "base64Data")]
  base64_data: Option<String>,
}

async fn add_item(
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    req: Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {
  let access_token = match parse_bearer_token(&req) {
    Some(t) => t,
    None => {
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_AUTH.to_owned()),
      });
    }
  };

  let payload: AddItemRequest = match incoming_json_with_limit(req, INGEST_ADD_ITEM_REQUEST_MAX_BYTES).await {
    Ok(p) => p,
    Err(e) => {
      warn!("Could not parse add-item request: {}", e);
      return json_response(&IngestSimpleResponse {
        success: false,
        err: Some(REASON_CLIENT.to_owned()),
      });
    }
  };

  let access_token_hash = hash_token(&access_token);
  let (ingest_session_id, ingest_user_id) = {
    let mut db = db.lock().await;
    let ingest_session = match db.ingest_session.get_active_by_access_hash(&access_token_hash) {
      Some(session) => session,
      None => {
        return json_response(&IngestSimpleResponse {
          success: false,
          err: Some(REASON_AUTH.to_owned()),
        });
      }
    };

    (ingest_session.id, ingest_session.user_id)
  };

  let add_result = add_item_for_user(db, object_store, &payload.json_data, &payload.base64_data, &ingest_user_id).await;
  if let Err(e) = add_result {
    warn!("Could not add ingest item: {}", e);
    return json_response(&IngestSimpleResponse {
      success: false,
      err: Some(REASON_SERVER.to_owned()),
    });
  }

  if let Ok(now_unix_secs) = now_unix_secs() {
    let mut db = db.lock().await;
    if let Some(mut ingest_session) = db.ingest_session.get_session_by_id(&ingest_session_id) {
      if !ingest_session.revoked {
        ingest_session.last_used_at = now_unix_secs;
        if let Err(e) = db.ingest_session.update_session(ingest_session).await {
          warn!("Could not update ingest session '{}': {}", ingest_session_id, e);
        }
      }
    }
  }

  json_response(&IngestSimpleResponse {
    success: true,
    err: None,
  })
}


fn parse_bearer_token(request: &Request<hyper::body::Incoming>) -> Option<String> {
  let header = request.headers().get(AUTHORIZATION)?;
  let header = header.to_str().ok()?;
  let (scheme, token) = header.split_once(' ')?;
  if !scheme.eq_ignore_ascii_case("bearer") {
    return None;
  }
  let token = token.trim();
  if token.is_empty() {
    return None;
  }
  Some(token.to_owned())
}

fn hash_token(token: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(token.as_bytes());
  let hash = hasher.finalize();
  format!("{:x}", hash)
}

fn now_unix_secs() -> InfuResult<i64> {
  Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64)
}

fn generate_pairing_code() -> String {
  let raw = Uuid::new_v4().simple().to_string().to_ascii_uppercase();
  format!("{}-{}-{}", &raw[0..4], &raw[4..8], &raw[8..12])
}

fn generate_secret_token(prefix: &str) -> String {
  format!("{}_{}{}", prefix, Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn normalize_pairing_code(code: &str) -> String {
  code.chars()
    .filter(|c| c.is_ascii_alphanumeric())
    .map(|c| c.to_ascii_uppercase())
    .collect::<String>()
}

fn sanitize_device_name(device_name: Option<&str>) -> String {
  let sanitized = device_name.unwrap_or("")
    .trim()
    .chars()
    .filter(|c| !c.is_control())
    .take(80)
    .collect::<String>();
  if sanitized.is_empty() {
    DEFAULT_DEVICE_NAME.to_owned()
  } else {
    sanitized
  }
}
