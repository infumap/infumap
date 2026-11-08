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

use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::{is_uid, new_uid};
use log::{debug, info, warn};

use super::{LogDescriptor, LogKind, read_log_descriptor};

fn parent_directory(path: &Path) -> &Path {
  path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."))
}

fn temporary_prefix(source: &Path) -> InfuResult<String> {
  let name = source.file_name().and_then(|name| name.to_str()).ok_or("Log filename must be valid UTF-8.")?;
  Ok(format!(".infumap-maintenance-{}-", name))
}

/// Reserve an owned sibling file. Callers must finish and flush its writer before installation.
pub fn create_log_temporary(source: &Path) -> InfuResult<PathBuf> {
  let path = parent_directory(source).join(format!("{}{}.tmp", temporary_prefix(source)?, new_uid()));
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  options.open(&path)?;
  debug!("Reserved maintenance temporary '{}' for '{}'.", path.display(), source.display());
  Ok(path)
}

/// Install a validated sibling candidate, keeping the active path present throughout.
/// Always retain this operation's immediate source, independently of other maintenance snapshots.
/// A directory-sync failure after the final rename reports an error but does not undo the replacement.
pub fn install_log_candidate(
  source: &Path,
  candidate: &Path,
  previous: &Path,
  validate: impl FnOnce(&Path) -> InfuResult<()>,
) -> InfuResult<()> {
  debug!(
    "Preparing replacement of '{}' from '{}'; retained-copy path '{}'.",
    source.display(),
    candidate.display(),
    previous.display()
  );
  let directory = parent_directory(source);
  let canonical_directory = directory.canonicalize()?;
  for path in [candidate, previous] {
    if parent_directory(path).canonicalize()? != canonical_directory || path.file_name() == source.file_name() {
      return Err("Candidate and previous copy must be distinct siblings of the active log.".into());
    }
  }
  if candidate.file_name() == previous.file_name() {
    return Err("Candidate and previous copy must be different files.".into());
  }
  if !fs::metadata(source)?.is_file() || !fs::symlink_metadata(candidate)?.is_file() {
    return Err("Active log and candidate must be files; the candidate cannot be a symlink.".into());
  }

  let file = OpenOptions::new().write(true).open(candidate)?;
  file.set_permissions(fs::metadata(source)?.permissions())?;
  file.sync_all()?;
  drop(file);
  validate(candidate)?;
  debug!("Synced and validated candidate '{}' before replacing '{}'.", candidate.display(), source.display());

  {
    let previous_temporary = create_log_temporary(source)?;
    let retain_result = (|| -> InfuResult<()> {
      let mut original = File::open(source)?;
      let mut retained = OpenOptions::new().write(true).open(&previous_temporary)?;
      let copied_bytes = std::io::copy(&mut original, &mut retained)?;
      retained.set_permissions(original.metadata()?.permissions())?;
      retained.sync_all()?;
      drop(retained);
      fs::rename(&previous_temporary, previous)?;
      sync_directory(directory)?;
      debug!(
        "Retained {} source bytes from '{}' in '{}' before installation.",
        copied_bytes,
        source.display(),
        previous.display()
      );
      Ok(())
    })();
    discard_temporary(&previous_temporary);
    retain_result?;
  }

  // Moving the source aside first leaves its path missing on interruption; replace it only after retention.
  fs::rename(candidate, source)?;
  sync_directory(directory).map_err(|e| format!(
    "Installed '{}', but failed to sync its directory; the new active log is already present and its retained original is '{}': {}",
    source.display(), previous.display(), e))?;
  debug!("Installed '{}' after the directory-sync step; retained original '{}'.", source.display(), previous.display());
  Ok(())
}

#[derive(Clone, Copy, Debug)]
pub(super) enum SnapshotPurpose {
  Migration,
  Compaction,
}

impl SnapshotPurpose {
  fn suffix(self) -> &'static str {
    match self {
      Self::Migration => ".before-migration",
      Self::Compaction => ".before-compaction",
    }
  }
}

fn startup_log_stem(source: &Path, kind: LogKind) -> InfuResult<&'static str> {
  match (source.file_name().and_then(|name| name.to_str()), kind) {
    (Some("items.json"), LogKind::Item) => Ok("items"),
    (Some("user.json"), LogKind::User) => Ok("user"),
    (Some("pending_users.json"), LogKind::User) => Ok("pending_users"),
    _ => Err("Local snapshots require a recognized startup log path.".into()),
  }
}

/// Version describes the retained input schema, never the candidate's target schema.
pub(super) fn snapshot_path(source: &Path, descriptor: LogDescriptor, purpose: SnapshotPurpose) -> InfuResult<PathBuf> {
  let stem = startup_log_stem(source, descriptor.kind)?;
  if descriptor.version < 1 || descriptor.version > descriptor.kind.current_version() {
    return Err("Snapshot source has an unsupported schema version.".into());
  }
  Ok(source.with_file_name(format!("{}.v{}{}", stem, descriptor.version, purpose.suffix())))
}

/// Call only after successful installation. The other purpose's latest recovery point must survive.
pub(super) fn prune_snapshot_copies(source: &Path, retained: &Path, purpose: SnapshotPurpose) -> InfuResult<()> {
  if !fs::symlink_metadata(source)?.is_file() || !fs::symlink_metadata(retained)?.is_file() {
    return Err("Cannot prune snapshots without regular active and retained files.".into());
  }
  let active = read_log_descriptor(source)?;
  let original = read_log_descriptor(retained)?;
  if active.kind != original.kind
    || active.version != active.kind.current_version()
    || snapshot_path(source, original, purpose)? != retained
  {
    return Err("Cannot prune snapshots without a current active log and matching retained input.".into());
  }
  let prefix = format!("{}.v", startup_log_stem(source, active.kind)?);
  let directory = parent_directory(source);
  let mut removed = 0;
  for entry in fs::read_dir(directory)? {
    let entry = entry?;
    let name = entry.file_name();
    // Exact purpose and canonical version matching avoid the other recovery point, manual outputs,
    // lookalike names, and files from a future binary. The retained path itself is never removed.
    // Preserve legacy .previous and bare .vN copies: their names do not identify the two recovery purposes.
    let recognized = name
      .to_str()
      .and_then(|name| name.strip_prefix(&prefix))
      .and_then(|name| name.strip_suffix(purpose.suffix()))
      .is_some_and(|suffix| {
        suffix.parse::<i64>().ok().is_some_and(|version| {
          version > 0 && version <= active.kind.current_version() && suffix == version.to_string()
        })
      });
    if recognized && entry.path() != retained && entry.file_type()?.is_file() {
      match fs::remove_file(entry.path()) {
        Ok(()) => {
          info!(
            "Removed superseded {:?} snapshot '{}'; retained '{}'.",
            purpose,
            entry.path().display(),
            retained.display()
          );
          removed += 1;
        }
        Err(e) => warn!("Could not prune local snapshot '{}': {}", entry.path().display(), e),
      }
    }
  }
  if removed > 0 {
    sync_directory(directory)?;
  }
  Ok(())
}

/// Discard only this log's maintenance-owned scratch files, never a manual .new/.compacted or retained copy.
pub fn discard_log_temporaries(source: &Path) -> InfuResult<usize> {
  match fs::metadata(source) {
    Ok(metadata) if metadata.is_file() => {}
    Ok(_) => return Err(format!("Active log '{}' is not a file.", source.display()).into()),
    // Keep leftovers available for inspection if the active log is missing; never promote them automatically.
    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(0),
    Err(e) => return Err(e.into()),
  }
  let prefix = temporary_prefix(source)?;
  let directory = parent_directory(source);
  let mut removed = 0;
  for entry in fs::read_dir(directory)? {
    let entry = entry?;
    let name = entry.file_name();
    let owned = name
      .to_str()
      .and_then(|name| name.strip_prefix(&prefix))
      .and_then(|name| name.strip_suffix(".tmp"))
      .is_some_and(is_uid);
    if owned && entry.file_type()?.is_file() {
      fs::remove_file(entry.path())?;
      removed += 1;
    }
  }
  if removed > 0 {
    sync_directory(directory)?;
  }
  Ok(removed)
}

pub(super) fn discard_temporary(path: &Path) {
  match fs::remove_file(path) {
    Ok(()) => debug!("Removed maintenance temporary '{}'.", path.display()),
    Err(e) if e.kind() == ErrorKind::NotFound => {}
    Err(e) => warn!("Could not remove maintenance temporary '{}': {}", path.display(), e),
  }
}

fn sync_directory(directory: &Path) -> InfuResult<()> {
  #[cfg(unix)]
  match File::open(directory)?.sync_all() {
    Ok(()) => {}
    Err(e) if matches!(e.kind(), ErrorKind::Unsupported | ErrorKind::InvalidInput) => {
      debug!("Directory sync is unsupported for '{}': {}", directory.display(), e);
    }
    Err(e) => return Err(e.into()),
  }
  #[cfg(not(unix))]
  debug!("Directory sync is unavailable on this platform for '{}'.", directory.display());
  Ok(())
}
