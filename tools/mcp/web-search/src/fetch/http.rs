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
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};
use serde::{Deserialize, Serialize};

use crate::error::InfuResult;

use super::config::FetchConfig;
use super::policy::document_addresses;

struct PinnedResolver {
  host: String,
  addresses: Vec<SocketAddr>,
}

impl reqwest::dns::Resolve for PinnedResolver {
  fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
    let matches = name.as_str().trim_end_matches('.').eq_ignore_ascii_case(self.host.trim_end_matches('.'));
    let addresses = self.addresses.clone();
    Box::pin(async move {
      if !matches {
        return Err(std::io::Error::other("Unvalidated DNS destination.").into());
      }
      Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
    })
  }
}

#[derive(PartialEq, Eq)]
pub(super) enum DocumentKind {
  Html,
  Text,
  Pdf,
  Unsupported,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Validators {
  pub etag: Option<String>,
  pub last_modified: Option<String>,
}

pub(super) enum DownloadOutcome {
  Unmodified,
  Document(DownloadedDocument),
}

pub(super) struct DownloadedDocument {
  pub final_url: Url,
  pub content_type: String,
  pub body: Vec<u8>,
  pub validators: Validators,
}

impl DownloadedDocument {
  pub fn kind(&self) -> DocumentKind {
    classify(&self.content_type, &self.body)
  }
}

pub(super) fn is_direct_text_url(url: &Url) -> bool {
  let path = url.path().to_ascii_lowercase();
  [".txt", ".json", ".md", ".markdown", ".csv", ".xml"].iter().any(|suffix| path.ends_with(suffix))
}

pub(super) fn classify(content_type: &str, prefix: &[u8]) -> DocumentKind {
  // MIME and extensions can be wrong. Never decode PDF bytes as readable text.
  if is_pdf(prefix) {
    return DocumentKind::Pdf;
  }
  let prefix = String::from_utf8_lossy(&prefix[..prefix.len().min(1024)]).trim_start().to_ascii_lowercase();
  if content_type.contains("html") || prefix.starts_with("<!doctype html") || prefix.starts_with("<html") {
    DocumentKind::Html
  } else if content_type.split(';').next().is_some_and(|mime| mime.trim() == "application/pdf") {
    DocumentKind::Pdf
  } else if content_type.starts_with("text/")
    || content_type.contains("json")
    || content_type.contains("xml")
    || content_type.is_empty()
  {
    DocumentKind::Text
  } else {
    DocumentKind::Unsupported
  }
}

pub(super) fn is_pdf(bytes: &[u8]) -> bool {
  bytes[..bytes.len().min(1024)].windows(5).any(|window| window == b"%PDF-")
}

pub(super) struct HttpDownloader {
  config: FetchConfig,
}

impl HttpDownloader {
  pub fn new(config: FetchConfig) -> Self {
    Self { config }
  }

  pub async fn download(&self, requested: &Url) -> InfuResult<DownloadedDocument> {
    match self.download_conditional(requested, &Validators::default()).await? {
      DownloadOutcome::Document(document) => Ok(document),
      DownloadOutcome::Unmodified => Err("Unexpected unmodified response without validators.".into()),
    }
  }

  pub async fn download_conditional(&self, requested: &Url, validators: &Validators) -> InfuResult<DownloadOutcome> {
    let mut current = requested.clone();
    for _ in 0..=5 {
      let addresses = document_addresses(&current).await?;
      let host = current.host_str().ok_or("URL has no host.")?;
      let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        // This resolver never falls through to DNS, including spelling or
        // trailing-dot differences. TLS still validates the original hostname.
        .dns_resolver(Arc::new(PinnedResolver { host: host.to_owned(), addresses }))
        .connect_timeout(Duration::from_secs(10))
        .timeout(self.config.timeout)
        .user_agent("Infumap web fetch")
        .build()
        .map_err(|error| format!("Could not prepare document download: {error}"))?;
      let mut request = client.get(current.clone()).header(ACCEPT, "*/*");
      if &current == requested {
        if let Some(etag) = &validators.etag {
          request = request.header("if-none-match", etag);
        } else if let Some(modified) = &validators.last_modified {
          request = request.header("if-modified-since", modified);
        }
      }
      let response = request.send().await.map_err(|error| format!("Failed to download document: {error}"))?;
      if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        if &current == requested && (validators.etag.is_some() || validators.last_modified.is_some()) {
          return Ok(DownloadOutcome::Unmodified);
        }
        return Err("Unexpected unmodified response without matching cache validators.".into());
      }
      if response.status().is_redirection() {
        let location = response
          .headers()
          .get(LOCATION)
          .and_then(|value| value.to_str().ok())
          .ok_or("Redirect missing Location header.")?;
        current = current.join(location).map_err(|error| format!("Invalid redirect: {error}"))?;
        continue;
      }
      if !response.status().is_success() {
        return Err(format!("Failed to fetch URL: HTTP {}", response.status()).into());
      }
      let content_type =
        response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("").to_ascii_lowercase();
      let validators = Validators {
        etag: response
          .headers()
          .get("etag")
          .and_then(|value| value.to_str().ok())
          .filter(|value| value.len() <= 1024)
          .map(str::to_owned),
        last_modified: response
          .headers()
          .get("last-modified")
          .and_then(|value| value.to_str().ok())
          .filter(|value| value.len() <= 1024)
          .map(str::to_owned),
      };
      let mut body = Vec::new();
      let mut stream = response.bytes_stream();
      while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read document: {error}"))?;
        let mut prefix = body[..body.len().min(1024)].to_vec();
        prefix.extend_from_slice(&chunk[..chunk.len().min(1024 - prefix.len())]);
        let limit = if classify(&content_type, &prefix) == DocumentKind::Pdf {
          self.config.max_pdf_bytes
        } else {
          self.config.max_document_bytes
        };
        if chunk.len() > limit.saturating_sub(body.len()) {
          return Err("Document exceeds its download byte limit.".into());
        }
        body.extend_from_slice(&chunk);
      }
      return Ok(DownloadOutcome::Document(DownloadedDocument { final_url: current, content_type, body, validators }));
    }
    Err("Failed to fetch URL: too many redirects.".into())
  }
}
