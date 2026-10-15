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

//! An owned browser proxy that connects only to validated public addresses.
//! OS confinement in `isolation` prevents browser channels bypassing this proxy.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, HOST, PROXY_AUTHORIZATION, UPGRADE};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, timeout_at};

use crate::error::InfuResult;

use super::policy::public_addresses;

type ProxyBody = UnsyncBoxBody<Bytes, hyper::Error>;

pub(super) struct AbortTask(pub JoinHandle<()>);

impl Drop for AbortTask {
  fn drop(&mut self) {
    self.0.abort();
  }
}

// A session owns every downstream, upstream and upgraded connection. Revoking
// it closes all network activity before the next context can acquire the slot.
#[derive(Clone)]
struct Session {
  deadline: Instant,
  stopped: watch::Receiver<bool>,
  slots: Arc<Semaphore>,
}

pub(super) struct NetworkSession {
  active: Arc<Mutex<Option<Session>>>,
  shutdown: watch::Sender<bool>,
  slots: Arc<Semaphore>,
}

impl NetworkSession {
  pub async fn close(self) {
    self.revoke();
    // Each connection/tunnel retains its permit until its socket work stops.
    let _ = self.slots.acquire_many(64).await;
  }

  fn revoke(&self) {
    self.active.lock().expect("Browser proxy session lock poisoned").take();
    let _ = self.shutdown.send(true);
  }
}

impl Drop for NetworkSession {
  fn drop(&mut self) {
    self.revoke();
  }
}

pub(super) struct PublicProxy {
  pub address: SocketAddr,
  active: Arc<Mutex<Option<Session>>>,
  _task: AbortTask,
}

impl PublicProxy {
  pub async fn start() -> InfuResult<Self> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
      .await
      .map_err(|error| format!("Could not bind browser proxy: {error}"))?;
    let address = listener.local_addr().map_err(|error| format!("Could not inspect browser proxy: {error}"))?;
    let active: Arc<Mutex<Option<Session>>> = Arc::default();
    let sessions = active.clone();
    let task = tokio::spawn(async move {
      let mut connections = JoinSet::new();
      loop {
        tokio::select! {
          _ = connections.join_next(), if !connections.is_empty() => {},
          accepted = listener.accept() => {
            let Ok((stream, _)) = accepted else { break };
            let lease = {
              let active = sessions.lock().expect("Browser proxy session lock poisoned");
              active.as_ref().and_then(|session| {
                session.slots.clone().try_acquire_owned().ok().map(|permit| (session.clone(), Arc::new(permit)))
              })
            };
            // Idle browsers cannot open outbound connections.
            let Some((session, permit)) = lease else { continue };
            let Session { deadline, stopped, .. } = session;
            let connection_stopped = stopped.clone();
            connections.spawn(async move {
              let service = service_fn(move |request| {
                let stopped = stopped.clone();
                let permit = permit.clone();
                async move {
                  let response = match forward(request, stopped, deadline, permit).await {
                    Ok(response) => response,
                    Err(error) => {
                      log::debug!("Browser proxy rejected a request: {error}");
                      empty_response(StatusCode::BAD_GATEWAY)
                    }
                  };
                  Ok::<_, Infallible>(response)
                }
              });
              tokio::select! {
                biased;
                _ = cancelled(connection_stopped) => {},
                _ = timeout_at(deadline, hyper::server::conn::http1::Builder::new()
                  .serve_connection(TokioIo::new(stream), service).with_upgrades()) => {},
              }
            });
          }
        }
      }
    });
    Ok(Self { address, active, _task: AbortTask(task) })
  }

  pub fn activate(&self, deadline: Instant) -> NetworkSession {
    let (shutdown, stopped) = watch::channel(false);
    let slots = Arc::new(Semaphore::new(64));
    let mut active = self.active.lock().expect("Browser proxy session lock poisoned");
    assert!(active.is_none(), "Only one browser network session may be active");
    *active = Some(Session { deadline, stopped, slots: slots.clone() });
    NetworkSession { active: self.active.clone(), shutdown, slots }
  }
}

pub(super) async fn cancelled(mut stopped: watch::Receiver<bool>) {
  if !*stopped.borrow_and_update() {
    let _ = stopped.changed().await;
  }
}

async fn connect(url: &Url) -> InfuResult<TcpStream> {
  let mut last_error = None;
  for address in public_addresses(url).await? {
    match TcpStream::connect(address).await {
      Ok(stream) => return Ok(stream),
      Err(error) => last_error = Some(error),
    }
  }
  Err(
    format!(
      "Could not connect to public destination: {}",
      last_error.map(|error| error.to_string()).unwrap_or_else(|| "no addresses".into())
    )
    .into(),
  )
}

async fn forward(
  mut request: Request<Incoming>,
  stopped: watch::Receiver<bool>,
  deadline: Instant,
  permit: Arc<OwnedSemaphorePermit>,
) -> InfuResult<Response<ProxyBody>> {
  if request.method() == Method::CONNECT {
    let authority = request.uri().authority().ok_or("CONNECT has no authority.")?;
    if authority.port_u16().is_none_or(|port| port == 0) {
      return Err("CONNECT requires an explicit nonzero port.".into());
    }
    let url = Url::parse(&format!("https://{authority}/")).map_err(|_| "Invalid CONNECT destination.")?;
    let mut upstream = connect(&url).await?;
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
      let _permit = permit;
      tokio::select! {
        _ = cancelled(stopped) => {},
        _ = timeout_at(deadline, async {
          if let Ok(stream) = upgrade.await {
            let _ = copy_bidirectional(&mut TokioIo::new(stream), &mut upstream).await;
          }
        }) => {},
      }
    });
    return Ok(empty_response(StatusCode::OK));
  }
  let mut url = Url::parse(&request.uri().to_string()).map_err(|_| "Invalid proxy URL.")?;
  if url.scheme() == "ws" {
    url.set_scheme("http").map_err(|_| "Invalid WebSocket destination.")?;
  }
  if url.scheme() != "http" {
    return Err("Proxy requires HTTP or an HTTPS CONNECT tunnel.".into());
  }
  let upstream = connect(&url).await?;
  let websocket = request.method() == Method::GET
    && request.headers().get(UPGRADE).is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
  let downstream_upgrade = websocket.then(|| hyper::upgrade::on(&mut request));
  let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(upstream))
    .await
    .map_err(|error| format!("Could not open proxy upstream: {error}"))?;
  let upstream_stopped = stopped.clone();
  let upstream_permit = permit.clone();
  tokio::spawn(async move {
    let _permit = upstream_permit;
    tokio::select! {
      _ = cancelled(upstream_stopped) => {},
      _ = timeout_at(deadline, connection.with_upgrades()) => {},
    }
  });
  let path = request.uri().path_and_query().map(|path| path.as_str()).unwrap_or("/").to_owned();
  *request.uri_mut() = path.parse().map_err(|_| "Invalid proxy request path.")?;
  request.headers_mut().remove(PROXY_AUTHORIZATION);
  request.headers_mut().remove("proxy-connection");
  let host =
    format!("{}:{}", url.host_str().ok_or("Proxy URL has no host.")?, url.port_or_known_default().unwrap_or(80));
  request.headers_mut().insert(HOST, host.parse().map_err(|_| "Invalid proxy Host header.")?);
  request
    .headers_mut()
    .insert(CONNECTION, hyper::header::HeaderValue::from_static(if websocket { "Upgrade" } else { "close" }));
  let mut response = sender.send_request(request).await.map_err(|error| format!("Proxy upstream failed: {error}"))?;
  if response.status() == StatusCode::SWITCHING_PROTOCOLS {
    let downstream = downstream_upgrade.ok_or("Unrequested upstream protocol upgrade.")?;
    let upstream = hyper::upgrade::on(&mut response);
    tokio::spawn(async move {
      let _permit = permit;
      tokio::select! {
        _ = cancelled(stopped) => {},
        _ = timeout_at(deadline, async {
          if let Ok((downstream, upstream)) = tokio::try_join!(downstream, upstream) {
            let _ = copy_bidirectional(&mut TokioIo::new(downstream), &mut TokioIo::new(upstream)).await;
          }
        }) => {},
      }
    });
  }
  Ok(response.map(|body| body.boxed_unsync()))
}

fn empty_response(status: StatusCode) -> Response<ProxyBody> {
  let body = Full::new(Bytes::new()).map_err(|never| match never {}).boxed_unsync();
  let mut response = Response::new(body);
  *response.status_mut() = status;
  response
}
