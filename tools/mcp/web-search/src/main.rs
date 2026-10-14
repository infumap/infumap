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

mod budget;
mod config;
mod error;
mod fetch;
mod protocol;
mod providers;
mod search;
mod tools;

use std::convert::Infallible;
use std::net::SocketAddr;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use log::{error, info, warn};
use tokio::net::TcpListener;

use protocol::handle_http;

#[tokio::main]
async fn main() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

  let config = match config::search_config() {
    Ok(config) => config,
    Err(message) => {
      eprintln!("Invalid web-search configuration: {message}");
      std::process::exit(1);
    }
  };
  if let Err(error) = search::initialize_providers() {
    eprintln!("Could not initialize search providers: {error}");
    std::process::exit(1);
  }
  let providers = config.provider_preference();
  if providers.is_empty() {
    warn!("No search providers configured; web_search is unavailable. fetch_page is still available.");
  } else {
    info!("Configured search provider preference: {}", providers.join(", "));
  }
  if let Some(exa) = &config.exa {
    info!(
      "Exa monthly configuration: {} US cents free, {} US cents paid limit, reset day {} at 00:00 UTC",
      exa.monthly_free_credits_cents, exa.monthly_paid_limit_cents, exa.monthly_reset_day
    );
    warn!(
      "Exa adapter and persistent budget accounting are ready, but automatic routing is not implemented yet; searches require DuckDuckGo opt-in."
    );
  }

  let host = std::env::var("WEB_SEARCH_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
  let port = std::env::var("WEB_SEARCH_PORT").unwrap_or_else(|_| "8791".to_owned());
  let addr: SocketAddr = match format!("{host}:{port}").parse() {
    Ok(addr) => addr,
    Err(e) => {
      eprintln!("Invalid WEB_SEARCH_HOST/WEB_SEARCH_PORT ({host}:{port}): {e}");
      std::process::exit(1);
    }
  };

  let listener = match TcpListener::bind(addr).await {
    Ok(listener) => listener,
    Err(e) => {
      eprintln!("Could not bind {addr}: {e}");
      std::process::exit(1);
    }
  };
  info!("infumap-web-search listening on http://{addr}/mcp");
  tokio::spawn(search::refresh_provider_usage());

  loop {
    let (stream, _) = match listener.accept().await {
      Ok(conn) => conn,
      Err(e) => {
        error!("accept failed: {e}");
        continue;
      }
    };
    let io = TokioIo::new(stream);
    tokio::task::spawn(async move {
      if let Err(err) = http1::Builder::new()
        .serve_connection(io, service_fn(|req| async move { Ok::<_, Infallible>(handle_http(req).await) }))
        .await
      {
        error!("Error serving connection: {err}");
      }
    });
  }
}
