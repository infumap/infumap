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
mod router;
mod search;
mod status;
mod tools;

use std::convert::Infallible;
use std::net::SocketAddr;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use log::{error, info, warn};
use tokio::net::TcpListener;
use tokio::task::JoinSet;

use protocol::handle_http;

fn main() {
  // Namespace setup must run before creating any Tokio threads.
  if let Some(code) = fetch::run_browser_helper() {
    std::process::exit(code);
  }
  let runtime =
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("Could not start server runtime");
  let command = std::env::args().nth(1);
  if matches!(command.as_deref(), Some("--setup-browser" | "--update-browser")) {
    let result = runtime.block_on(fetch::setup_browser(command.as_deref() == Some("--update-browser")));
    drop(runtime);
    match result {
      Ok(path) => println!("{}", path.display()),
      Err(error) => {
        eprintln!("Browser setup failed: {error}");
        std::process::exit(1);
      }
    }
  } else {
    runtime.block_on(run_server());
  }
}

async fn run_server() {
  env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

  if let Err(error) = fetch::initialize() {
    eprintln!("Could not initialize web fetch: {error}");
    std::process::exit(1);
  }

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
    warn!("No search providers configured; web_search is unavailable. web_fetch is still available.");
  } else {
    info!("Configured search provider preference: {}", providers.join(", "));
  }
  for (name, settings) in [("Exa", &config.exa), ("Brave", &config.brave)] {
    let Some(settings) = settings else { continue };
    info!(
      "{name} monthly configuration: {} US cents free, {} US cents paid limit, reset day {} at 00:00 UTC",
      settings.monthly_free_credits_cents, settings.monthly_paid_limit_cents, settings.monthly_reset_day
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
  info!("Web search MCP endpoint: http://{addr}/mcp/search");
  info!("Web fetch MCP endpoint: http://{addr}/mcp/fetch");
  info!("Local provider status available at /status (loopback clients only)");
  let usage_refresh = tokio::spawn(search::refresh_provider_usage());
  let mut connections = JoinSet::new();
  let shutdown = shutdown_signal();
  tokio::pin!(shutdown);

  loop {
    let accepted = tokio::select! {
      biased;
      _ = &mut shutdown => break,
      _ = connections.join_next(), if !connections.is_empty() => continue,
      accepted = listener.accept() => accepted,
    };
    let (stream, peer) = match accepted {
      Ok(conn) => conn,
      Err(e) => {
        error!("accept failed: {e}");
        continue;
      }
    };
    let io = TokioIo::new(stream);
    connections.spawn(async move {
      if let Err(err) = http1::Builder::new()
        .serve_connection(
          io,
          service_fn(move |req| async move {
            let response = if req.uri().path().trim_end_matches('/') == "/status" {
              status::handle_http(&req, peer.ip()).await
            } else {
              handle_http(req).await
            };
            Ok::<_, Infallible>(response)
          }),
        )
        .await
      {
        error!("Error serving connection: {err}");
      }
    });
  }
  drop(listener);
  usage_refresh.abort();
  // Dropping HTTP handlers cancels pending fetch receivers. Browser workers
  // retain ownership/permits until their network and process cleanup finishes.
  connections.abort_all();
  while connections.join_next().await.is_some() {}
  fetch::shutdown().await;
  info!("Web-search server stopped; owned browser cleanup completed.");
}

async fn shutdown_signal() {
  #[cfg(unix)]
  {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("Could not register SIGTERM handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("Could not register SIGINT handler");
    tokio::select! {
      _ = terminate.recv() => {},
      _ = interrupt.recv() => {},
    }
  }
  #[cfg(not(unix))]
  let _ = tokio::signal::ctrl_c().await;
}
