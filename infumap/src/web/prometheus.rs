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

use std::net::SocketAddr;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use hyper::{server::conn::http1, service::service_fn, Request, Response};
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use prometheus::{TextEncoder, Encoder};
use tokio::{net::TcpListener, task};

use crate::{tokiort::TokioIo, web::serve::{internal_server_error_response, not_found_response, text_response}};

use super::routes::{files::METRIC_CACHED_IMAGE_REQUESTS_TOTAL, command::METRIC_COMMANDS_HANDLED_TOTAL};


pub async fn spawn_promethues_listener(prometheus_addr: SocketAddr) -> InfuResult<()> {
  prometheus::register(Box::new(METRIC_CACHED_IMAGE_REQUESTS_TOTAL.clone())).unwrap();
  prometheus::register(Box::new(METRIC_COMMANDS_HANDLED_TOTAL.clone())).unwrap();

  let _forever = task::spawn(async move {
    let listener = match TcpListener::bind(prometheus_addr).await {
      Ok(listener) => listener,
      Err(e) => {
        error!("Error binding prometheus listener: {:?}", e);
        return;
      }
    };
    loop {
      let (stream, _) = match listener.accept().await {
        Ok((stream, addr)) => (stream, addr),
        Err(e) => {
          error!("Error accepting prometheus connection: {:?}", e);
          continue;
        }
      };

      let io = TokioIo::new(stream);
      tokio::task::spawn(async move {
        if let Err(err) = http1::Builder::new()
            .serve_connection(io,service_fn(move |req| prometheus_http_serve(req)))
            .await {
          info!("Error serving connection: {:?}", err);
        }
      });
    }
  });

  Ok(())
}


async fn prometheus_http_serve(req: Request<hyper::body::Incoming>) -> Result<Response<BoxBody<Bytes, hyper::Error>>, hyper::Error>  {
  debug!("Serving prometheus listener: {}", req.uri().path());

  if req.uri().path() != "/metrics" {
    return Ok(not_found_response());
  }

  let mut buffer = Vec::new();
  let encoder = TextEncoder::new();
  let metric_families = prometheus::gather();
  if let Err(e) = encoder.encode(&metric_families, &mut buffer) {
    error!("Error encoding metrics: {:?}", e);
    return Ok(internal_server_error_response("Error encoding metrics."));
  }
  let output = match String::from_utf8(buffer.clone()) {
    Ok(output) => output,
    Err(e) => {
      error!("Error converting metrics to utf8: {:?}", e);
      return Ok(internal_server_error_response("Error converting metrics to utf8."));
    }
  };

  Ok(text_response(&output))
}
