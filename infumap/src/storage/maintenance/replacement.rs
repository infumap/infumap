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

use super::{LogKind, read_log_descriptor};

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
/// Set save_source to false only when an earlier operation this startup already retained its original.
/// A directory-sync failure after the final rename reports an error but does not undo the replacement.
pub fn install_log_candidate(
  source: &Path,
  candidate: &Path,
  previous: &Path,
  save_source: bool,
  validate: impl FnOnce(&Path) -> InfuResult<()>,
) -> InfuResult<()> {
  debug!(
    "Preparing replacement of '{}' from '{}'; retained-copy path '{}'; retain source: {}.",
    source.display(),
    candidate.display(),
    previous.display(),
    save_source
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

  if save_source {
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
  } else if !fs::metadata(previous)?.is_file() {
    return Err(format!("Retained original '{}' is not a file.", previous.display()).into());
  } else {
    debug!("Reusing original '{}' retained earlier this startup for '{}'.", previous.display(), source.display());
  }

  // Moving the source aside first leaves its path missing on interruption; replace it only after retention.
  fs::rename(candidate, source)?;
  sync_directory(directory).map_err(|e| format!(
    "Installed '{}', but failed to sync its directory; the new active log is already present and its retained original is '{}': {}",
    source.display(), previous.display(), e))?;
  debug!("Installed '{}' after the directory-sync step; retained original '{}'.", source.display(), previous.display());
  Ok(())
}

/// Startup-only pruning, after successful installation. Manual migrate still keeps its one-step .vN copies.
pub(super) fn prune_legacy_log_copies(source: &Path, kind: LogKind) -> InfuResult<()> {
  // Limit this policy to the exact startup log names, and require both complete active and retained files.
  let stem = match (source.file_name().and_then(|name| name.to_str()), kind) {
    (Some("items.json"), LogKind::Item) => "items",
    (Some("user.json"), LogKind::User) => "user",
    (Some("pending_users.json"), LogKind::User) => "pending_users",
    _ => return Err("Legacy-copy pruning requires a recognized startup log path.".into()),
  };
  let previous = source.with_file_name(format!("{}.json.previous", stem));
  if !fs::symlink_metadata(source)?.is_file() || !fs::symlink_metadata(&previous)?.is_file() {
    return Err("Cannot prune recovery copies without regular active and previous files.".into());
  }
  let active = read_log_descriptor(source)?;
  if active.kind != kind || active.version != kind.current_version() {
    return Err("Cannot prune recovery copies before the active log is at its current schema.".into());
  }

  // The CLI used with_extension("vN"), not an appended ".json.vN". Do not broaden this to .bk.*, .new,
  // .compacted, or lookalike names: those may be deliberately retained operator copies or uninstalled output.
  let prefix = format!("{}.v", stem);
  let directory = parent_directory(source);
  let mut removed = 0;
  for entry in fs::read_dir(directory)? {
    let entry = entry?;
    let name = entry.file_name();
    let recognized = name.to_str().and_then(|name| name.strip_prefix(&prefix)).is_some_and(|suffix| {
      suffix
        .parse::<i64>()
        .ok()
        .is_some_and(|version| version > 0 && version < kind.current_version() && suffix == version.to_string())
    });
    if recognized && entry.file_type()?.is_file() {
      match fs::remove_file(entry.path()) {
        Ok(()) => {
          info!(
            "Removed superseded local migration copy '{}'; retained '{}'.",
            entry.path().display(),
            previous.display()
          );
          removed += 1;
        }
        Err(e) => warn!("Could not prune local migration copy '{}': {}", entry.path().display(), e),
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
