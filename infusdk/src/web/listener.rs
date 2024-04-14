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

use std::sync::Arc;
use bytes::Bytes;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::Mutex;
use std::net::SocketAddr;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::{service::service_fn, server::conn::http1, Request, Response, StatusCode};
use log::{error, warn, info, debug};
use tokio::net::TcpListener;

use crate::{item::Item, util::infu::InfuResult, web::{tokiort::TokioIo, WebApiJsonSerializable}};


const REASON_CLIENT: &str = "client";
const REASON_SERVER: &str = "server";


pub async fn listen<D, F1, F2, F3>(
      data: Arc<Mutex<D>>,
      handle_get_items_item_and_attachments_only: &'static F1,
      handle_get_items_children_and_their_attachments_only: &'static F2,
      handle_update_item: &'static F3) -> InfuResult<()>
    where for<'a> F1: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
          for<'a> F2: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
          for<'a> F3: Fn(&'a Item, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
          for<'a> D: 'a + Send + Sync {

  let addr_str = format!("{}:{}", "127.0.0.1", 8005);
  let addr: SocketAddr = match addr_str.parse() {
    Ok(addr) => addr,
    Err(e) => {
      return Err(format!("Invalid socket address: {} ({})", addr_str, e).into());
    }
  };

  info!("Listening on 127.0.0.1:8005");

  let listener = TcpListener::bind(addr).await?;
  loop {
    let data = data.clone();
    let (stream, _) = listener.accept().await?;
    
    let io = TokioIo::new(stream);
    tokio::task::spawn(async move {
      if let Err(err) = http1::Builder::new()
          .serve_connection(io,service_fn(move |req| http_serve(
            data.clone(),
            handle_get_items_item_and_attachments_only,
            handle_get_items_children_and_their_attachments_only,
            handle_update_item,
            req)))
          .await {
        info!("Error serving connection: {:?}", err);
      }
    });
  }
}


#[derive(Deserialize, Serialize)]
struct CommandRequest {
  pub command: String,
  #[serde(rename="jsonData")]
  pub json_data: String,
  #[serde(rename="base64Data")]
  pub base64_data: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct CommandResponse {
  pub success: bool,
  #[serde(rename="failReason")]
  pub fail_reason: Option<String>,
  #[serde(rename="jsonData")]
  pub json_data: Option<String>,
}

async fn http_serve<D, F1, F2, F3>(
    data: Arc<Mutex<D>>,
    handle_get_items_item_and_attachments_only: &'static F1,
    handle_get_items_children_and_their_attachments_only: &'static F2,
    handle_update_item: &'static F3,
    req: Request<hyper::body::Incoming>) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error>
  where for<'a> F1: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
        for<'a> F2: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
        for<'a> F3: Fn(&'a Item, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync, {

  if req.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return Ok(cors_response());
  }

  if req.method() != "POST" {
    return Ok(not_found_response());
  }

  if req.uri().path() != "/command" {
    error!("Unexpected URI path: {}", req.uri().path());
    return Ok(not_found_response());
  }

  let command: CommandRequest = match incoming_json(req).await {
    Ok(r) => r,
    Err(e) => {
      error!("An error occurred parsing command payload: {}", e);
      return Ok(json_response(&CommandResponse { success: false, fail_reason: Some(REASON_CLIENT.to_owned()), json_data: None }));
    }
  };

  match handle_post(
      &command, data,
      handle_get_items_item_and_attachments_only,
      handle_get_items_children_and_their_attachments_only,
      handle_update_item).await {
    Ok(response) => Ok(response),
    Err(e) => {
      warn!("An error occurred servicing a '{}' command: {}.", command.command, e);
      return Ok(json_response(&CommandResponse { success: false, fail_reason: Some(REASON_SERVER.to_owned()), json_data: None }));
    }
  }
}

#[derive(Deserialize, Serialize)]
struct GetItemsRequest {
  pub id: String,
  pub mode: String
}

async fn handle_post<D, F1, F2, F3>(
    command: &CommandRequest,
    data: Arc<Mutex<D>>,
    handle_get_items_item_and_attachments_only: &'static F1,
    handle_get_items_children_and_their_attachments_only: &'static F2,
    handle_update_item: &'static F3) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>>
  where for<'a> F1: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
        for<'a> F2: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
        for<'a> F3: Fn(&'a Item, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync, {

  let response_data_maybe = match command.command.as_str() {
    "get-items" => handle_get_items(command, data, handle_get_items_item_and_attachments_only, handle_get_items_children_and_their_attachments_only).await,
    "update-item" => handle_update_item_shim(command, &data, handle_update_item).await,
    _ => {
      warn!("Unknown command '{}' issued by anonymous user", command.command);
      return Err(format!("Unexpected command '{}'.", command.command).into());
    }
  };

  let response_data = match response_data_maybe {
    Ok(r) => r,
    Err(e) => {
      warn!("An error occurred servicing a '{}' command: {}.", command.command, e);
      return Ok(json_response(&CommandResponse { success: false, fail_reason: Some(REASON_SERVER.to_owned()), json_data: None }));
    }
  };

  Ok(json_response(&response_data))
}

async fn handle_update_item_shim<D, F1>(
      command: &CommandRequest,
      data: &Arc<Mutex<D>>,
      handle_update_item: &'static F1) -> InfuResult<Option<CommandResponse>>
    where for<'a> F1: Fn(&'a Item, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync {

  let deserializer = serde_json::Deserializer::from_str(&command.json_data);
  let mut iterator = deserializer.into_iter::<serde_json::Value>();
  let item_map_maybe = iterator.next().ok_or("Update item request has no item.")??;
  let item_map = item_map_maybe.as_object().ok_or("Update item request body is not a JSON object.")?;
  let item: Item = Item::from_api_json(item_map)?;

  handle_update_item(&item, data).await?;
  debug!("Executed 'update-item' command for item '{}'.", item.id);

  Ok(None)
}

async fn handle_get_items<D, F1, F2>(
      command: &CommandRequest,
      data: Arc<Mutex<D>>,
      handle_get_items_item_and_attachments_only: &'static F1,
      handle_get_items_children_and_their_attachments_only: &'static F2) -> InfuResult<Option<CommandResponse>>
    where for<'a> F1: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync,
          for<'a> F2: Fn(&'a str, &'a Arc<Mutex<D>>) -> BoxFuture<'a, InfuResult<Option<CommandResponse>>> + Send + Sync {

  let request: GetItemsRequest = serde_json::from_str(&command.json_data)?;

  let response = match request.mode.as_str() {
    "item-and-attachments-only" => { handle_get_items_item_and_attachments_only(&request.id, &data).await },
    "children-and-their-attachments-only" => { handle_get_items_children_and_their_attachments_only(&request.id, &data).await },
    _ => { Err(format!("Unexpected get-items mode '{}'", request.mode).into()) }
  };

  debug!("Executed 'get-items' ({}) command for item '{}'.", request.mode.as_str(), request.id);

  response
}


fn cors_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .status(StatusCode::NO_CONTENT)
    .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
    .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
    .body(empty_body()).unwrap()
}

async fn incoming_json<T>(request: Request<hyper::body::Incoming>) -> InfuResult<T> where T: DeserializeOwned {
  Ok(serde_json::from_str::<T>(
    &String::from_utf8(
      request.collect().await.unwrap().to_bytes().iter().cloned().collect::<Vec<u8>>()
    )?
  )?)
}

fn full_body<T: Into<Bytes>>(data: T) -> BoxBody<Bytes, hyper::Error> {
  Full::new(data.into())
    .map_err(|never| match never {})
    .boxed()
}

fn json_response<T>(v: &T) -> Response<BoxBody<Bytes, hyper::Error>> where T: Serialize {
  let result_str = serde_json::to_string(&v).unwrap();
  match Response::builder()
      .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .header(hyper::header::CONTENT_TYPE, "text/javascript")
      .body(full_body(result_str)) {
    Ok(r) => r,
    Err(_) => {
      Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(empty_body()).unwrap()
    }
  }
}

fn not_found_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder().status(StatusCode::NOT_FOUND).body(empty_body()).unwrap()
}

fn empty_body() -> BoxBody<Bytes, hyper::Error> {
  Empty::<Bytes>::new()
    .map_err(|never| match never {})
    .boxed()
}
