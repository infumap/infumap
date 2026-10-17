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

use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::providers::{ProviderError, ProviderErrorKind, ProviderResult};

const WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_LEDGER_BYTES: u64 = 64 * 1024;
const MAX_REQUESTS: usize = 100;

/// You.com's keyless quota has no documented reset boundary. Retain every
/// admitted search for a full 24 hours instead of inventing a daily reset time.
pub struct DailyQuota {
  directory: PathBuf,
  allowance: u32,
  _lock: File,
  state: Mutex<State>,
}

struct State {
  ledger: Ledger,
  failed: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
  version: u32,
  last_observed_at_ms: i64,
  requests_at_ms: Vec<i64>,
  remote_exhausted_until_ms: Option<i64>,
}

#[derive(Serialize)]
pub struct DailyQuotaSnapshot {
  pub window_seconds: u64,
  pub free_allowance_requests: u32,
  pub consumed_requests: u32,
  pub remaining_requests: u32,
  /// Earliest possible eligibility, in Unix milliseconds; not a remote reset.
  pub next_request_at_ms: Option<i64>,
  pub remote_exhausted_until_ms: Option<i64>,
  pub persistence_error: Option<&'static str>,
}

impl DailyQuotaSnapshot {
  pub fn available(&self) -> bool {
    self.persistence_error.is_none() && self.remaining_requests > 0 && self.remote_exhausted_until_ms.is_none()
  }
}

impl DailyQuota {
  pub fn open(directory: &Path, allowance: u32) -> ProviderResult<Arc<Self>> {
    if allowance == 0 || allowance > MAX_REQUESTS as u32 {
      return Err(internal("You.com daily allowance must be between 1 and 100."));
    }
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::DirBuilderExt;
      builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| internal("Could not create You.com quota directory."))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let lock =
      options.open(directory.join("you-quota.lock")).map_err(|_| internal("Could not open You.com quota lock."))?;
    lock.try_lock().map_err(|_| internal("You.com quota directory is already in use or cannot be locked."))?;
    let ledger = match File::open(directory.join("you-quota.json")) {
      Ok(file) => {
        let mut bytes = Vec::new();
        file
          .take(MAX_LEDGER_BYTES + 1)
          .read_to_end(&mut bytes)
          .map_err(|_| internal("Could not read You.com quota ledger."))?;
        if bytes.len() as u64 > MAX_LEDGER_BYTES {
          return Err(internal("You.com quota ledger exceeds the size limit."));
        }
        let ledger: Ledger = serde_json::from_slice(&bytes)
          .map_err(|_| internal("You.com quota ledger is invalid; refusing to reset usage."))?;
        if ledger.version != 1
          || ledger.requests_at_ms.len() > MAX_REQUESTS
          || ledger.requests_at_ms.windows(2).any(|pair| pair[0] > pair[1])
          || ledger.requests_at_ms.iter().any(|&time| time < 0 || time > ledger.last_observed_at_ms)
          || ledger.remote_exhausted_until_ms.is_some_and(|until| until < 0)
        {
          return Err(internal("You.com quota ledger is invalid; refusing to reset usage."));
        }
        ledger
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ledger {
        version: 1,
        last_observed_at_ms: Timestamp::now().as_millisecond(),
        requests_at_ms: Vec::new(),
        remote_exhausted_until_ms: None,
      },
      Err(_) => return Err(internal("Could not open You.com quota ledger.")),
    };
    check_clock(&ledger)?;
    persist(directory, &ledger)?;
    Ok(Arc::new(Self {
      directory: directory.to_owned(),
      allowance,
      _lock: lock,
      state: Mutex::new(State { ledger, failed: false }),
    }))
  }

  pub async fn snapshot(self: &Arc<Self>) -> ProviderResult<DailyQuotaSnapshot> {
    let quota = Arc::clone(self);
    worker(move || {
      let state = quota.state.lock().map_err(|_| internal("You.com quota lock is poisoned."))?;
      let now = check_clock(&state.ledger)?;
      let active: Vec<i64> =
        state.ledger.requests_at_ms.iter().copied().filter(|&time| time > now - WINDOW_MS).collect();
      let consumed_requests = active.len() as u32;
      let remaining_requests = quota.allowance.saturating_sub(consumed_requests);
      let remote_exhausted_until_ms = state.ledger.remote_exhausted_until_ms.filter(|&until| until > now);
      // Lowering a configured limit can require several recorded requests to
      // expire. Report the timestamp that would actually free the first slot.
      let local_expiry = if remaining_requests == 0 {
        active.get(active.len().saturating_sub(quota.allowance as usize)).map(|&time| time + WINDOW_MS)
      } else {
        None
      };
      Ok(DailyQuotaSnapshot {
        window_seconds: (WINDOW_MS / 1000) as u64,
        free_allowance_requests: quota.allowance,
        consumed_requests,
        remaining_requests,
        next_request_at_ms: local_expiry.into_iter().chain(remote_exhausted_until_ms).max(),
        remote_exhausted_until_ms,
        persistence_error: state.failed.then_some("You.com quota persistence failed; restart after repairing storage."),
      })
    })
    .await
  }

  /// Charge before tool dispatch. Late writes, crashes and cancellation retain
  /// the charge conservatively; dropping a request never blocks on disk I/O.
  pub async fn charge(self: &Arc<Self>, deadline: Instant) -> ProviderResult<()> {
    let quota = Arc::clone(self);
    worker(move || {
      check_deadline(deadline)?;
      quota.update(|ledger, now| {
        check_deadline(deadline)?;
        ledger.requests_at_ms.retain(|&time| time > now - WINDOW_MS);
        if ledger.requests_at_ms.len() >= quota.allowance as usize
          || ledger.remote_exhausted_until_ms.is_some_and(|until| until > now)
        {
          return Err(ProviderError::new(
            ProviderErrorKind::InsufficientBudget,
            "You.com daily free request quota is unavailable.",
          ));
        }
        ledger.requests_at_ms.push(now);
        Ok(())
      })
    })
    .await?;
    check_deadline(deadline)
  }

  /// A remote daily-limit error may reflect other clients on the same IP.
  /// Suspend for a full window because the provider's reset time is unknown.
  pub async fn exhaust(self: &Arc<Self>, delay: Duration) -> ProviderResult<()> {
    let quota = Arc::clone(self);
    worker(move || {
      quota.update(|ledger, now| {
        let delay = i64::try_from(delay.as_millis())
          .map_err(|_| internal("You.com quota delay exceeds the supported range."))?
          .max(WINDOW_MS);
        let until = now.checked_add(delay).ok_or_else(|| internal("You.com quota timestamp overflowed."))?;
        ledger.remote_exhausted_until_ms = Some(ledger.remote_exhausted_until_ms.map_or(until, |old| old.max(until)));
        Ok(())
      })
    })
    .await
  }

  fn update(&self, update: impl FnOnce(&mut Ledger, i64) -> ProviderResult<()>) -> ProviderResult<()> {
    let mut state = self.state.lock().map_err(|_| internal("You.com quota lock is poisoned."))?;
    if state.failed {
      return Err(internal("You.com quota persistence failed; restart after repairing storage."));
    }
    let now = check_clock(&state.ledger)?;
    let mut next = state.ledger.clone();
    update(&mut next, now)?;
    next.last_observed_at_ms = now;
    if let Err(error) = persist(&self.directory, &next) {
      state.failed = true;
      return Err(error);
    }
    state.ledger = next;
    Ok(())
  }
}

fn check_clock(ledger: &Ledger) -> ProviderResult<i64> {
  let now = Timestamp::now().as_millisecond();
  if ledger.last_observed_at_ms < 0 || now < ledger.last_observed_at_ms {
    return Err(internal("Clock precedes You.com quota history; refusing to reset usage."));
  }
  Ok(now)
}

fn persist(directory: &Path, ledger: &Ledger) -> ProviderResult<()> {
  let bytes = serde_json::to_vec(ledger).map_err(|_| internal("Could not serialize You.com quota ledger."))?;
  let mut temporary = tempfile::Builder::new()
    .prefix("you-quota-")
    .tempfile_in(directory)
    .map_err(|_| internal("Could not create temporary You.com quota ledger."))?;
  temporary
    .write_all(&bytes)
    .and_then(|_| temporary.as_file().sync_all())
    .map_err(|_| internal("Could not durably write You.com quota ledger."))?;
  temporary
    .persist(directory.join("you-quota.json"))
    .map_err(|_| internal("Could not replace You.com quota ledger."))?;
  #[cfg(unix)]
  File::open(directory)
    .and_then(|file| file.sync_all())
    .map_err(|_| internal("Could not sync You.com quota directory."))?;
  Ok(())
}

async fn worker<T: Send + 'static>(
  operation: impl FnOnce() -> ProviderResult<T> + Send + 'static,
) -> ProviderResult<T> {
  tokio::task::spawn_blocking(operation).await.map_err(|_| internal("You.com quota worker failed."))?
}

fn check_deadline(deadline: Instant) -> ProviderResult<()> {
  if Instant::now() >= deadline {
    return Err(ProviderError::new(ProviderErrorKind::Transient, "You.com search exceeded its deadline."));
  }
  Ok(())
}

fn internal(message: &str) -> ProviderError {
  ProviderError::new(ProviderErrorKind::Internal, message)
}
