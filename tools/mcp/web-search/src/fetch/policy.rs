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

use std::net::{IpAddr, SocketAddr};

use reqwest::Url;
use tokio::net::lookup_host;

use crate::error::InfuResult;

const METADATA_HOSTS: &[&str] =
  &["localhost", "ip6-localhost", "metadata", "metadata.google.internal", "metadata.tencentyun.com"];

const SEARCH_ENGINE_HOSTS: &[&str] = &[
  "google.com",
  "bing.com",
  "cn.bing.com",
  "duckduckgo.com",
  "html.duckduckgo.com",
  "lite.duckduckgo.com",
  "yahoo.com",
  "search.yahoo.com",
  "search.brave.com",
  "startpage.com",
  "ecosia.org",
  "baidu.com",
  "yandex.com",
  "yandex.ru",
  "search.aol.com",
  "ask.com",
  "search.ask.com",
];

pub(super) fn normalize_url_scheme(url: &str) -> InfuResult<Url> {
  if url.is_empty() {
    return Err("fetch URL cannot be empty".into());
  }
  let with_scheme = if url.starts_with("http://") || url.starts_with("https://") {
    url.to_string()
  } else if url.starts_with("//") {
    format!("https:{url}")
  } else {
    format!("https://{url}")
  };
  Url::parse(&with_scheme).map_err(|e| format!("invalid URL: {}", e).into())
}

pub(super) async fn assert_public_destination(url: &Url) -> InfuResult<()> {
  if let Some(host) = url.host_str()
    && is_search_engine_host(host)
  {
    return Err(
      format!("Blocked: web_fetch does not fetch search engine URLs ('{host}'). Use web_search for searches.").into(),
    );
  }
  public_addresses(url).await.map(|_| ())
}

/// Resolve once, validate every address, and connect only to these addresses.
pub(super) async fn public_addresses(url: &Url) -> InfuResult<Vec<SocketAddr>> {
  match url.scheme() {
    "http" | "https" => {}
    other => return Err(format!("Blocked: unsupported URL scheme '{other}'.").into()),
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err("Blocked: URL must not include credentials.".into());
  }
  let host = url.host_str().ok_or("Blocked: URL has no host.")?;
  if is_blocked_host(host) {
    return Err(format!("Blocked: refusing to fetch host '{host}'.").into());
  }
  let port = url.port_or_known_default().unwrap_or(80);
  let host = host.trim_start_matches('[').trim_end_matches(']');
  let addrs = lookup_host((host, port)).await.map_err(|e| format!("Failed to resolve host: {}", e))?;
  let mut addresses = Vec::new();
  for addr in addrs {
    if !is_global_ip(addr.ip()) {
      return Err(format!("Blocked: refusing to fetch non-public address {}.", addr.ip()).into());
    }
    addresses.push(addr);
  }
  if addresses.is_empty() {
    return Err(format!("Failed to resolve host: no addresses for '{host}'.").into());
  }
  Ok(addresses)
}

fn is_search_engine_host(host: &str) -> bool {
  let host = normalize_host(host);
  let host = host.strip_prefix("www.").unwrap_or(&host);
  if SEARCH_ENGINE_HOSTS.contains(&host) || host.ends_with(".search.yahoo.com") {
    return true;
  }
  // Include Google's country search domains without blocking product hosts
  // such as docs.google.com or unrelated domains containing "google".
  host.strip_prefix("google.").is_some_and(|suffix| {
    let country = suffix.strip_prefix("co.").or_else(|| suffix.strip_prefix("com.")).unwrap_or(suffix);
    country.len() == 2 && country.bytes().all(|byte| byte.is_ascii_lowercase())
  })
}

fn is_blocked_host(host: &str) -> bool {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  METADATA_HOSTS.iter().any(|blocked| *blocked == host)
    || host.ends_with(".localhost")
    || host.ends_with(".local")
    || host.starts_with("169.254.")
    || host == "::ffff:169.254.169.254"
}

fn is_global_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => {
      let o = v4.octets();
      !(v4.is_unspecified()
        || v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && o[1] & 0b1100_0000 == 64)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || o[0] >= 240)
    }
    IpAddr::V6(v6) => {
      if let Some(v4) = v6.to_ipv4_mapped() {
        return is_global_ip(IpAddr::V4(v4));
      }
      let s = v6.segments();
      !(v6.is_unspecified()
        || v6.is_loopback()
        || v6.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] == 0x2001 && s[1] == 0xdb8))
    }
  }
}

pub(super) fn hosts_differ(requested: &str, final_url: &str) -> bool {
  let requested_host = Url::parse(requested).ok().and_then(|url| url.host_str().map(normalize_host));
  let final_host = Url::parse(final_url).ok().and_then(|url| url.host_str().map(normalize_host));
  match (requested_host, final_host) {
    (Some(requested_host), Some(final_host)) => requested_host != final_host,
    _ => requested != final_url,
  }
}

fn normalize_host(host: &str) -> String {
  host.trim_end_matches('.').to_ascii_lowercase()
}
