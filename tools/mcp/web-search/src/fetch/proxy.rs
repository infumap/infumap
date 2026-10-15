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
//! Browser-specific bypass prevention and policy auditing continue in step 3.

use std::convert::Infallible;
use std::net::SocketAddr;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, PROXY_AUTHORIZATION};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
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

pub(super) struct PublicProxy {
  pub address: SocketAddr,
  shutdown: watch::Sender<bool>,
  _task: AbortTask,
}

impl PublicProxy {
  pub async fn start(deadline: Instant) -> InfuResult<Self> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
      .await
      .map_err(|error| format!("Could not bind browser proxy: {error}"))?;
    let address = listener.local_addr().map_err(|error| format!("Could not inspect browser proxy: {error}"))?;
    let (shutdown, mut stopped) = watch::channel(false);
    let task = tokio::spawn(async move {
      loop {
        tokio::select! {
          _ = stopped.changed() => break,
          _ = tokio::time::sleep_until(deadline) => break,
          accepted = listener.accept() => {
            let Ok((stream, _)) = accepted else { break };
            let mut connection_stopped = stopped.clone();
            let requests_stopped = stopped.clone();
            tokio::spawn(async move {
              let service = service_fn(move |request| {
                let stopped = requests_stopped.clone();
                async move {
                  let response = match forward(request, stopped, deadline).await {
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
                _ = connection_stopped.changed() => {},
                _ = timeout_at(deadline, hyper::server::conn::http1::Builder::new()
                  .serve_connection(TokioIo::new(stream), service).with_upgrades()) => {},
              }
            });
          }
        }
      }
    });
    Ok(Self { address, shutdown, _task: AbortTask(task) })
  }
}

impl Drop for PublicProxy {
  fn drop(&mut self) {
    let _ = self.shutdown.send(true);
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
  mut stopped: watch::Receiver<bool>,
  deadline: Instant,
) -> InfuResult<Response<ProxyBody>> {
  if request.method() == Method::CONNECT {
    let authority = request.uri().authority().ok_or("CONNECT has no authority.")?;
    let url = Url::parse(&format!("https://{authority}/")).map_err(|_| "Invalid CONNECT destination.")?;
    let mut upstream = connect(&url).await?;
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
      tokio::select! {
        _ = stopped.changed() => {},
        _ = timeout_at(deadline, async {
          if let Ok(stream) = upgrade.await {
            let _ = copy_bidirectional(&mut TokioIo::new(stream), &mut upstream).await;
          }
        }) => {},
      }
    });
    return Ok(empty_response(StatusCode::OK));
  }
  let url = Url::parse(&request.uri().to_string()).map_err(|_| "Invalid proxy URL.")?;
  if url.scheme() != "http" {
    return Err("Proxy requires HTTP or an HTTPS CONNECT tunnel.".into());
  }
  let upstream = connect(&url).await?;
  let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(upstream))
    .await
    .map_err(|error| format!("Could not open proxy upstream: {error}"))?;
  tokio::spawn(async move {
    tokio::select! {
      _ = stopped.changed() => {},
      _ = timeout_at(deadline, connection) => {},
    }
  });
  let path = request.uri().path_and_query().map(|path| path.as_str()).unwrap_or("/").to_owned();
  *request.uri_mut() = path.parse().map_err(|_| "Invalid proxy request path.")?;
  request.headers_mut().remove(PROXY_AUTHORIZATION);
  request.headers_mut().remove("proxy-connection");
  request.headers_mut().insert(CONNECTION, hyper::header::HeaderValue::from_static("close"));
  let response = sender.send_request(request).await.map_err(|error| format!("Proxy upstream failed: {error}"))?;
  Ok(response.map(|body| body.boxed_unsync()))
}

fn empty_response(status: StatusCode) -> Response<ProxyBody> {
  let body = Full::new(Bytes::new()).map_err(|never| match never {}).boxed_unsync();
  let mut response = Response::new(body);
  *response.status_mut() = status;
  response
}
