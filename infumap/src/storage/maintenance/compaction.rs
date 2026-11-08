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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use infusdk::db::kv_store::{JsonLogSerializable, KVStore};
use infusdk::util::infu::InfuResult;
use log::{debug, info, warn};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::task::spawn_blocking;

use super::replacement::{discard_temporary, prune_legacy_log_copies};
use super::{AccountLogs, LogKind, create_log_temporary, install_log_candidate, read_log_descriptor};
use crate::storage::backup::{BackupStore, MaintenanceBackupKind, put_maintenance_backup};
use crate::storage::db::item_db::write_compacted_item_log;
use crate::storage::db::user::User;
use crate::storage::db::user_db::CURRENT_USER_LOG_VERSION;

/// A fully replayed candidate. The caller owns cleanup and must snapshot the active pair before installation.
#[must_use]
pub struct CompactionCandidate {
  pub path: PathBuf,
  pub original_bytes: u64,
  pub compacted_bytes: u64,
  pub saved_bytes: u64,
}

/// Call after this account's migrations succeed, sharing their retained-log set for this startup.
/// Preparation/archive errors leave the active pair unchanged; installation errors are handled per file.
pub async fn compact_account_logs(
  account: &AccountLogs,
  min_savings_bytes: u64,
  backup: Option<(&Arc<BackupStore>, &str)>,
  retained_logs: &mut HashSet<PathBuf>,
) -> InfuResult<()> {
  let started = Instant::now();
  let mut candidates = Vec::new();
  let result: InfuResult<()> = async {
    // Temporary replay supplies the current persisted roots without constructing or mutating live indexes.
    let users = KVStore::<User>::init(
      account.user_log.to_str().ok_or("User log path must be valid UTF-8.")?,
      CURRENT_USER_LOG_VERSION,
    )
    .await?;
    let user =
      users.get(&account.user_id).ok_or_else(|| format!("No user '{}' in its account log.", account.user_id))?;
    for (source, descriptor) in
      [(&account.user_log, account.user_descriptor), (&account.item_log, account.item_descriptor)]
    {
      if let Some(candidate) = prepare_log_compaction(source, user, min_savings_bytes).await? {
        candidates.push((source, descriptor, candidate));
      }
    }
    if candidates.is_empty() {
      debug!("Account '{}' has no qualifying compactions (minimum {} bytes); no archive created; elapsed {:?}.",
        account.user_id, min_savings_bytes, started.elapsed());
      return Ok(());
    }
    // Qualifying candidates are validated; snapshot the still-unchanged current pair once before installation.
    // A migration archive describes an earlier schema and cannot substitute for this recovery point.
    let archive = if let Some((store, encryption_key)) = backup {
      Some(put_maintenance_backup(
        store.clone(),
        MaintenanceBackupKind::Compaction,
        &account.user_id,
        &account.item_log,
        &account.user_log,
        encryption_key,
      )
      .await
      .map_err(|e| format!("Cannot archive account '{}' before compaction: {}", account.user_id, e))?)
    } else { None };
    for (original_source, descriptor, candidate) in &candidates {
      let source = (*original_source).clone();
      let path = candidate.path.clone();
      let descriptor = *descriptor;
      let expected_bytes = candidate.compacted_bytes;
      // A successful migration already retained the pre-startup original. Keep it through compaction.
      let save_source = !retained_logs.contains(*original_source);
      let installed = spawn_blocking(move || -> InfuResult<PathBuf> {
        let filename = source.file_name().and_then(|name| name.to_str()).ok_or("Log filename must be valid UTF-8.")?;
        let previous = source.with_file_name(format!("{}.previous", filename));
        install_log_candidate(&source, &path, &previous, save_source, |path| {
          let actual = read_log_descriptor(path)?;
          if actual.kind != descriptor.kind
            || actual.version != descriptor.kind.current_version()
            || std::fs::metadata(path)?.len() != expected_bytes
          {
            return Err("Compaction candidate has an unexpected schema or size.".into());
          }
          Ok(())
        }).map_err(|e| format!("Cannot install compacted log '{}' (retained-copy path '{}'): {}",
          source.display(), previous.display(), e))?;
        if let Err(e) = prune_legacy_log_copies(&source, descriptor.kind) {
          warn!("Compacted '{}', but could not finish pruning older local copies: {}", source.display(), e);
        }
        Ok(previous)
      })
      .await;
      match installed {
        Ok(Ok(previous)) => {
          retained_logs.insert((*original_source).clone());
          info!(
            "Compacted account '{}' log '{}' at v{} -> v{}: {} -> {} bytes, {} saved; archive '{}'; retained original '{}'; elapsed {:?}.",
            account.user_id,
            original_source.display(),
            descriptor.kind.current_version(), descriptor.kind.current_version(),
            candidate.original_bytes,
            candidate.compacted_bytes,
            candidate.saved_bytes,
            archive.as_deref().unwrap_or("S3 backup disabled"),
            previous.display(),
            started.elapsed()
          );
        }
        // Replacement may already have completed if directory sync failed. Keep complete installed logs and
        // let normal loading verify the final paths; rolling back a successful file is unnecessary.
        Ok(Err(e)) => warn!(
          "Could not finish compaction installation for account '{}' log '{}'; archive '{}'; elapsed {:?}; keeping its active log: {}",
          account.user_id,
          original_source.display(),
          archive.as_deref().unwrap_or("S3 backup disabled"), started.elapsed(),
          e
        ),
        Err(e) => warn!(
          "Compaction installation task failed for account '{}' log '{}'; archive '{}'; elapsed {:?}; keeping its active log: {}",
          account.user_id,
          original_source.display(),
          archive.as_deref().unwrap_or("S3 backup disabled"), started.elapsed(),
          e
        ),
      }
    }
    Ok(())
  }
  .await;
  for (_, _, candidate) in candidates {
    discard_temporary(&candidate.path);
  }
  result.map_err(|e| {
    format!(
      "Compaction preparation/archive failed for account '{}' (user '{}', items '{}') after {:?}: {}",
      account.user_id,
      account.user_log.display(),
      account.item_log.display(),
      started.elapsed(),
      e
    )
    .into()
  })
}

/// Measure actual savings without modifying active files or taking a permanent snapshot.
/// The account's current User supplies the persisted roots when compacting its item log.
pub async fn prepare_log_compaction(
  source: &Path,
  user: &User,
  min_savings_bytes: u64,
) -> InfuResult<Option<CompactionCandidate>> {
  if min_savings_bytes == 0 {
    return Err("Compaction minimum savings must be positive.".into());
  }
  let started = Instant::now();
  let original_bytes = fs::metadata(source).await?.len();
  if original_bytes <= min_savings_bytes {
    // A valid candidate contains at least a descriptor, so even equality cannot recover this many bytes.
    debug!(
      "Skipping compaction for account '{}' log '{}': {} bytes cannot save {} bytes; no candidate or archive needed; elapsed {:?}.",
      user.id,
      source.display(),
      original_bytes,
      min_savings_bytes,
      started.elapsed()
    );
    return Ok(None);
  }
  let descriptor = read_log_descriptor(source)?;
  if descriptor.version != descriptor.kind.current_version() {
    return Err(format!("Log '{}' must be migrated before compaction.", source.display()).into());
  }
  let candidate = create_log_temporary(source)?;
  let result: InfuResult<Option<CompactionCandidate>> = async {
    match descriptor.kind {
      LogKind::User => write_compacted_user_log(source, &candidate).await?,
      LogKind::Item => write_compacted_item_log(source, &candidate, user).await?,
    }
    let compacted_bytes = fs::metadata(&candidate).await?.len();
    let saved_bytes = original_bytes.checked_sub(compacted_bytes).unwrap_or(0);
    info!(
      "Measured compaction for account '{}' log '{}' at v{} -> v{}: {} -> {} bytes, {} saved (minimum {}), {}; elapsed {:?}.",
      user.id,
      source.display(),
      descriptor.version, descriptor.kind.current_version(),
      original_bytes,
      compacted_bytes,
      saved_bytes,
      min_savings_bytes,
      if saved_bytes >= min_savings_bytes { "qualifies" } else { "skipped: savings below minimum" },
      started.elapsed()
    );
    if saved_bytes < min_savings_bytes {
      return Ok(None);
    }
    Ok(Some(CompactionCandidate { path: candidate.clone(), original_bytes, compacted_bytes, saved_bytes }))
  }
  .await;
  if !matches!(&result, Ok(Some(_))) {
    discard_temporary(&candidate);
  }
  result.map_err(|e| format!("Cannot prepare compaction of '{}': {}", source.display(), e).into())
}

async fn write_compacted_user_log(source: &Path, candidate: &Path) -> InfuResult<()> {
  let store =
    KVStore::<User>::init(source.to_str().ok_or("User log path must be valid UTF-8.")?, CURRENT_USER_LOG_VERSION)
      .await?;
  let file = OpenOptions::new().write(true).truncate(true).open(candidate).await?;
  let mut writer = BufWriter::new(file);
  let descriptor = serde_json::json!({
    "__recordType": "descriptor", "version": CURRENT_USER_LOG_VERSION, "valueType": User::value_type_identifier(),
  });
  writer.write_all(serde_json::to_string(&descriptor)?.as_bytes()).await?;
  writer.write_all(b"\n").await?;
  let mut ids: Vec<_> = store.get_iter().map(|(id, _)| id).collect();
  ids.sort();
  for id in ids {
    let user = store.get(id).ok_or_else(|| format!("User '{}' disappeared during compaction.", id))?;
    writer.write_all(serde_json::to_string(&user.to_json()?)?.as_bytes()).await?;
    writer.write_all(b"\n").await?;
  }
  writer.flush().await?;
  writer.into_inner().sync_all().await?;

  let compacted = KVStore::<User>::init(
    candidate.to_str().ok_or("Compaction candidate path must be valid UTF-8.")?,
    CURRENT_USER_LOG_VERSION,
  )
  .await?;
  if compacted.get_iter().count() != store.get_iter().count() {
    return Err("Compaction changed the number of live users.".into());
  }
  for (id, original) in store.get_iter() {
    let actual = compacted.get(id).ok_or_else(|| format!("Compaction lost user '{}'.", id))?;
    if actual.to_json()? != original.to_json()? {
      return Err(format!("Compaction changed user '{}'.", id).into());
    }
  }
  Ok(())
}
