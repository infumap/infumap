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

use std::process::Command as ProcessCommand;

use clap::{Arg, ArgAction, ArgMatches, Command};
use infusdk::util::infu::InfuResult;
use log::{error, info, warn};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::cli::restore::process_backup;
use crate::setup::get_config;
use crate::util::fs::{ensure_256_subdirs, expand_tilde, write_last_backup_filename};

pub fn make_clap_subcommand() -> Command {
  Command::new("emergency")
    .about("Automates pulling the latest backup file for a specific Infumap user and preparing a recovery directory with settings and data.")

    .arg(Arg::new("s3_backup_endpoint")
      .long("s3-backup-endpoint")
      .help("The s3 endpoint for the backup object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_backup_region")
      .long("s3-backup-region")
      .help("The s3 region for the backup object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_backup_bucket")
      .long("s3-backup-bucket")
      .help("The s3 bucket name of the backup object store.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("s3_backup_key")
      .long("s3-backup-key")
      .help("The s3 key for accessing the backup object store.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("s3_backup_secret")
      .long("s3-backup-secret")
      .help("The s3 secret for accessing the backup object store.")
      .num_args(1)
      .required(true))

    .arg(Arg::new("s3_endpoint")
      .long("s3-endpoint")
      .help("The s3 endpoint for the infumap data object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_region")
      .long("s3-region")
      .help("The s3 region for the infumap data object store (if required by your provider).")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_bucket")
      .long("s3-bucket")
      .help("The s3 bucket name of the infumap data object store.")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_key")
      .long("s3-key")
      .help("The s3 key for the infumap data object store.")
      .num_args(1)
      .required(false))
    .arg(Arg::new("s3_secret")
      .long("s3-secret")
      .help("The s3 secret for the infumap data object store.")
      .num_args(1)
      .required(false))

    .arg(Arg::new("user_id")
      .long("user-id")
      .help("The infumap user id.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("encryption_key")
      .long("encryption-key")
      .help("The 32 byte hex encoded encryption key (64 chars) that was used to encrypt the backup.")
      .num_args(1)
      .required(true))
    .arg(Arg::new("recovery_dir")
      .long("recovery-dir")
      .help("Directory where emergency settings.toml, data, and cache files will be created or updated.")
      .num_args(1)
      .required(true))

    .arg(Arg::new("enable_backup")
      .long("enable-backup")
      .help("Enable S3 backup writing in the generated settings.toml.")
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))
    .arg(Arg::new("backup_period_minutes")
      .long("backup-period-minutes")
      .help("Backup period in minutes to write into generated settings.toml (default: 1).")
      .num_args(1)
      .required(false))

    .arg(Arg::new("dev_feature_flag")
      .long("dev")
      .help("Enable experimental in-development features.")
      .num_args(0)
      .action(ArgAction::SetTrue)
      .required(false))

    .arg(Arg::new("port")
      .long("port")
      .help("Port to write into generated settings.toml (default: 8042).")
      .num_args(1)
      .required(false))
}

fn toml_string_literal(value: &str) -> String {
  let escaped =
    value.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t").replace('"', "\\\"");
  format!("\"{}\"", escaped)
}

fn build_emergency_settings_toml(
  data_dir: &str,
  cache_dir: &str,
  port: u16,
  s3_region: Option<&str>,
  s3_endpoint: Option<&str>,
  s3_bucket: Option<&str>,
  s3_key: Option<&str>,
  s3_secret: Option<&str>,
  enable_backup: bool,
  backup_period_minutes: u32,
  encryption_key: &str,
  s3_backup_region: Option<&str>,
  s3_backup_endpoint: Option<&str>,
  s3_backup_bucket: &str,
  s3_backup_key: &str,
  s3_backup_secret: &str,
) -> String {
  let mut lines = vec![
    "# Generated by `infumap emergency`.".to_owned(),
    "log_level = \"debug\"".to_owned(),
    format!("data_dir = {}", toml_string_literal(data_dir)),
    format!("cache_dir = {}", toml_string_literal(cache_dir)),
    format!("port = {}", port),
    "enable_local_object_storage = false".to_owned(),
    "bypass_totp_check = true".to_owned(),
  ];

  let enable_s3_1_object_storage =
    s3_region.is_some() || s3_endpoint.is_some() || s3_bucket.is_some() || s3_key.is_some() || s3_secret.is_some();
  lines.push(format!("enable_s3_1_object_storage = {}", enable_s3_1_object_storage));
  if let Some(v) = s3_region {
    lines.push(format!("s3_1_region = {}", toml_string_literal(v)));
  }
  if let Some(v) = s3_endpoint {
    lines.push(format!("s3_1_endpoint = {}", toml_string_literal(v)));
  }
  if let Some(v) = s3_bucket {
    lines.push(format!("s3_1_bucket = {}", toml_string_literal(v)));
  }
  if let Some(v) = s3_key {
    lines.push(format!("s3_1_key = {}", toml_string_literal(v)));
  }
  if let Some(v) = s3_secret {
    lines.push(format!("s3_1_secret = {}", toml_string_literal(v)));
  }

  lines.push(format!("enable_s3_backup = {}", enable_backup));
  if enable_backup {
    lines.push(format!("backup_period_minutes = {}", backup_period_minutes));
    lines.push("disable_backup_cleanup = true".to_owned());
    lines.push(format!("backup_encryption_key = {}", toml_string_literal(encryption_key)));
    lines.push(format!("s3_backup_bucket = {}", toml_string_literal(s3_backup_bucket)));
    lines.push(format!("s3_backup_key = {}", toml_string_literal(s3_backup_key)));
    lines.push(format!("s3_backup_secret = {}", toml_string_literal(s3_backup_secret)));
    if let Some(v) = s3_backup_region {
      lines.push(format!("s3_backup_region = {}", toml_string_literal(v)));
    }
    if let Some(v) = s3_backup_endpoint {
      lines.push(format!("s3_backup_endpoint = {}", toml_string_literal(v)));
    }
  }
  lines.join("\n") + "\n"
}

fn format_local_system_time(unix_ts: u64) -> String {
  let date_format = "+%Y-%m-%dT%H:%M:%S%z (%Z)";
  let unix_ts_s = unix_ts.to_string();

  // macOS / BSD `date`.
  if let Ok(output) = ProcessCommand::new("date").args(["-r", &unix_ts_s, date_format]).output() {
    if output.status.success() {
      if let Ok(s) = String::from_utf8(output.stdout) {
        let s = s.trim().to_owned();
        if !s.is_empty() {
          return s;
        }
      }
    }
  }

  // GNU `date`.
  let gnu_timestamp_arg = format!("@{}", unix_ts);
  if let Ok(output) = ProcessCommand::new("date").args(["-d", &gnu_timestamp_arg, date_format]).output() {
    if output.status.success() {
      if let Ok(s) = String::from_utf8(output.stdout) {
        let s = s.trim().to_owned();
        if !s.is_empty() {
          return s;
        }
      }
    }
  }

  // Last-resort fallback (UTC), while making it explicit local timezone could not be determined.
  let unix_ts_i64 = match i64::try_from(unix_ts) {
    Ok(v) => v,
    Err(_) => {
      return format!(
        "local system timezone unavailable for timestamp {} (UTC unavailable: unrepresentable timestamp)",
        unix_ts
      );
    }
  };

  let utc_dt = match OffsetDateTime::from_unix_timestamp(unix_ts_i64) {
    Ok(v) => v,
    Err(_) => {
      return format!(
        "local system timezone unavailable for timestamp {} (UTC unavailable: invalid timestamp)",
        unix_ts
      );
    }
  };

  match utc_dt.to_offset(UtcOffset::UTC).format(&Rfc3339) {
    Ok(v) => format!("local system timezone unavailable; UTC {}", v),
    Err(_) => format!("local system timezone unavailable for timestamp {} (UTC format error)", unix_ts),
  }
}

pub async fn execute<'a>(sub_matches: &ArgMatches) -> InfuResult<()> {
  let s3_backup_endpoint = sub_matches.get_one::<String>("s3_backup_endpoint");
  let s3_backup_region = sub_matches.get_one::<String>("s3_backup_region");
  let s3_backup_bucket = sub_matches.get_one::<String>("s3_backup_bucket").unwrap();
  let s3_backup_key = sub_matches.get_one::<String>("s3_backup_key").unwrap();
  let s3_backup_secret = sub_matches.get_one("s3_backup_secret").unwrap();

  let s3_endpoint = sub_matches.get_one::<String>("s3_endpoint");
  let s3_region = sub_matches.get_one::<String>("s3_region");
  let s3_bucket = sub_matches.get_one::<String>("s3_bucket");
  let s3_key = sub_matches.get_one::<String>("s3_key");
  let s3_secret = sub_matches.get_one::<String>("s3_secret");

  let user_id = sub_matches.get_one::<String>("user_id").unwrap();
  let encryption_key = sub_matches.get_one::<String>("encryption_key").unwrap();
  let recovery_dir = sub_matches.get_one::<String>("recovery_dir").unwrap();

  let enable_backup = sub_matches.get_flag("enable_backup");
  let backup_period_minutes =
    sub_matches.get_one::<String>("backup_period_minutes").map(|s| s.parse::<u32>().unwrap_or(1)).unwrap_or(1);

  let port = sub_matches.get_one::<String>("port").map(|s| s.parse::<u16>().unwrap_or(8042)).unwrap_or(8042);

  info!("fetching list of backup files.");
  let bs = crate::storage::backup::new(
    s3_backup_region,
    s3_backup_endpoint,
    s3_backup_bucket,
    s3_backup_key,
    s3_backup_secret,
  )?;
  let mut files = crate::storage::backup::list(bs.clone()).await?;
  info!(
    "found {} backup files for {} users.",
    files.iter().map(|kv| kv.1.len()).fold(0, |acc, x| acc + x),
    files.len()
  );
  let timestamps_for_user = match files.get_mut(user_id) {
    Some(r) => {
      if r.len() == 0 {
        error!("no backup files for user {}.", user_id);
        return Ok(());
      }
      r
    }
    None => {
      error!("no backup files for user {}.", user_id);
      return Ok(());
    }
  };
  timestamps_for_user.sort();
  let last_timestamp = *timestamps_for_user.last().unwrap();
  let backup_filename = crate::storage::backup::format_backup_filename(user_id, last_timestamp);
  let local_system_time = format_local_system_time(last_timestamp);
  info!(
    "retrieving latest backup file (timestamp {} / local system time on this computer: {}) for user {}.",
    last_timestamp, local_system_time, user_id
  );
  let backup_bytes = crate::storage::backup::get(bs.clone(), &user_id, last_timestamp).await?;
  info!("retrieved {} bytes.", backup_bytes.len());

  let infumap_dir = expand_tilde(recovery_dir).ok_or("Could not expand settings path.")?;
  if std::fs::metadata(&infumap_dir).is_ok() && !infumap_dir.is_dir() {
    return Err(format!("The --recovery-dir path {:?} exists but is not a directory.", infumap_dir).into());
  }
  std::fs::create_dir_all(&infumap_dir)?;

  let mut settings_toml_path = infumap_dir.clone();
  settings_toml_path.push("settings.toml");
  let mut infumap_cache_dir = infumap_dir.clone();
  infumap_cache_dir.push("cache");
  let mut infumap_data_dir = infumap_dir.clone();
  infumap_data_dir.push("data");
  let mut infumap_user_data_dir = infumap_data_dir.clone();
  infumap_user_data_dir.push(format!("user_{}", user_id));
  let mut items_json_path = infumap_user_data_dir.clone();
  items_json_path.push("items.json");
  let mut user_json_path = infumap_user_data_dir.clone();
  user_json_path.push("user.json");

  info!("using emergency directory: {:?}", infumap_dir);
  std::fs::create_dir_all(infumap_data_dir.clone())?;
  std::fs::create_dir_all(infumap_cache_dir.clone())?;
  if std::fs::metadata(&infumap_user_data_dir).is_ok() {
    warn!("existing user data directory found, replacing: {:?}", infumap_user_data_dir);
    std::fs::remove_dir_all(&infumap_user_data_dir)?;
  }
  std::fs::create_dir_all(infumap_user_data_dir.clone())?;

  let infumap_data_dir_str = infumap_data_dir.to_str().ok_or("can't interpret data dir pathbuf")?.to_owned();
  let infumap_cache_dir_str = infumap_cache_dir.to_str().ok_or("can't interpret cache dir pathbuf")?.to_owned();
  let settings_toml = build_emergency_settings_toml(
    &infumap_data_dir_str,
    &infumap_cache_dir_str,
    port,
    s3_region.map(|v| v.as_str()),
    s3_endpoint.map(|v| v.as_str()),
    s3_bucket.map(|v| v.as_str()),
    s3_key.map(|v| v.as_str()),
    s3_secret.map(|v| v.as_str()),
    enable_backup,
    backup_period_minutes,
    encryption_key,
    s3_backup_region.map(|v| v.as_str()),
    s3_backup_endpoint.map(|v| v.as_str()),
    s3_backup_bucket,
    s3_backup_key,
    s3_backup_secret,
  );
  std::fs::write(&settings_toml_path, settings_toml)?;
  info!("wrote settings file: {:?}", settings_toml_path);

  info!("unpacking items/user json files from backup file.");
  process_backup(
    &backup_bytes,
    &items_json_path.to_str().ok_or(format!("could not interpret items.json path as str: {:?}", items_json_path))?,
    &user_json_path.to_str().ok_or(format!("could not interpret user.json path as str: {:?}", user_json_path))?,
    &encryption_key,
    &user_id,
    &backup_filename,
  )
  .await?;

  write_last_backup_filename(&infumap_data_dir_str, &user_id, &backup_filename).await?;
  info!("wrote local backup tracking file for user {} as {}.", user_id, backup_filename);

  info!("creating cache: {:?}", infumap_cache_dir);
  let num_created = ensure_256_subdirs(&infumap_cache_dir).await?;
  info!("created {} cache subdirectories.", num_created);

  info!("validating generated settings.toml.");
  let settings_toml_path_str = settings_toml_path.to_str().ok_or("can't interpret settings.toml pathbuf")?.to_owned();
  get_config(Some(&settings_toml_path_str)).await?;

  info!("recovery directory is ready at {:?}.", infumap_dir);
  info!("next step: infumap web --settings {:?}", infumap_dir);
  Ok(())
}
