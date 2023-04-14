// Copyright (C) 2022-2023 The Infumap Authors
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

use std::os::unix::prelude::FileExt;
use config::{Config, FileFormat};
use log::{info, warn};
use crate::{config::*, init_logger};
use crate::util::crypto::generate_key;
use crate::util::infu::InfuResult;
use crate::util::fs::{expand_tilde_path_exists, ensure_256_subdirs, expand_tilde, path_exists};


pub async fn _get_config(settings_path_maybe: Option<String>) -> InfuResult<Config> {
  let settings_path_maybe = match settings_path_maybe {
    Some(path) => {
      let path = expand_tilde(&path).ok_or("Could not expand settings path.")?;
      if !path_exists(&std::path::PathBuf::from(&path)).await {
        return Err(format!("The specified settings file path '{:?}' does not exist.", path).into());
      }
      Some(path.into_os_string().into_string().map_err(|_| "Unsupported settings.toml file path.")?)
    },

    None => {
      let env_only_config = match Config::builder()
        .add_source(config::Environment::with_prefix(ENV_CONFIG_PREFIX))
        .set_default(CONFIG_ENV_ONLY, false)?
        .build() {
          Ok(c) => c,
          Err(e) => {
            return Err(format!("An error occurred building env var-only configuration: '{e}'").into());
          }
        };

      if env_only_config.get_bool(CONFIG_ENV_ONLY)? {
        None

      } else {
        // The settings file in the default location is used if the path is not explicitly stated (unless "env_only" is set to true).
        // In some contexts, the default settings file and data dirs should be auto-created. In those cases,
        // use init_fs_maybe_and_get_config instead.

        let mut pb = match dirs::home_dir() {
          Some(dir) => dir,
          None => {
            return Err(format!("No settings path was specified, and the home dir could not be determined.").into());
          }
        };

        pb.push(".infumap");
        if !path_exists(&pb).await {
          return Err(format!("The default settings file directory '~/.infumap/' does not exist.").into());
        }

        pb.push("settings.toml");
        if !path_exists(&pb).await {
          return Err(format!("The default settings file '~/.infumap/settings.toml' does not exist.").into());
        }

        Some(pb.into_os_string().into_string().map_err(|_| "Unsupported settings.toml file path.")?)
      }
    }
  };

  build_config(settings_path_maybe)
}


pub async fn init_fs_maybe_and_get_config(settings_path_maybe: Option<String>) -> InfuResult<Config> {

  // logger has not been initialized yet. cache log messages.
  let mut info_messages = vec![];

  let settings_path_maybe = match settings_path_maybe {
    Some(path) => {
      let path = expand_tilde(&path).ok_or("Could not expand settings path.")?;
      if !path_exists(&std::path::PathBuf::from(&path)).await {
        return Err(format!("The specified settings file path '{:?}' does not exist.", path).into());
      }
      Some(path.into_os_string().into_string().map_err(|_| "Unsupported settings.toml file path.")?)
    },

    None => {
      let env_only_config = match Config::builder()
        .add_source(config::Environment::with_prefix(ENV_CONFIG_PREFIX))
        .set_default(CONFIG_ENV_ONLY, false)?
        .build() {
          Ok(c) => c,
          Err(e) => {
            return Err(format!("An error occurred building env var-only configuration: '{e}'").into());
          }
        };

      if env_only_config.get_bool(CONFIG_ENV_ONLY)? {
        None

      } else {
        // The settings file in the default location is used if the path is not explicitly stated (unless "env_only" is set to true).
        // If it doesn't exist, it must be successfully created and any data dirs not specified via env vars
        // will be created in this case, if they don't exist.

        let mut pb = match dirs::home_dir() {
          Some(dir) => dir,
          None => {
            return Err(format!("No settings path was specified, and the home dir could not be determined.").into());
          }
        };

        pb.push(".infumap");
        if !path_exists(&pb).await {
          match std::fs::create_dir(pb.as_path()) {
            Ok(_) => {
              info_messages.push("Settings file was not specified, creating .infumap in home directory.".to_owned());
            },
            Err(e) => {
              return Err(format!("Could not create .infumap in home directory: {e}").into());
            }
          }
        }

        if let Err(_) = env_only_config.get_string(CONFIG_CACHE_DIR) {
          pb.push("cache");
          if !path_exists(&pb).await {
            if let Err(e) = std::fs::create_dir(pb.as_path()) {
              return Err(format!("Could not create cache directory: '{e}'").into());
            } else {
              info_messages.push("Created cache directory: '~/.infumap/cache'".to_owned());
            }
          }
          let num_created = ensure_256_subdirs(&pb).await?;
          if num_created > 0 {
            info_messages.push(format!("Created {} sub cache directories", num_created));
          }
          pb.pop();
        }

        if let Err(_) = env_only_config.get_string(CONFIG_DATA_DIR) {
          pb.push("data");
          if !path_exists(&pb).await {
            if let Err(e) = std::fs::create_dir(pb.as_path()) {
              return Err(format!("Could not create data directory: '{e}'").into());
            } else {
              info_messages.push("Created data directory: '~/.infumap/data'".to_owned());
            }
          }
          pb.pop();
        }

        pb.push("settings.toml");
        if !path_exists(&pb).await {
          let f = match std::fs::File::create(pb.as_path()) {
            Ok(f) => f,
            Err(e) => {
              return Err(format!("Could not open default settings file for write {e}").into());
            }
          };
          let buf = include_bytes!("../default_settings.toml");
          let backup_encryption_key = generate_key();
          let default_settings = String::from_utf8(buf.to_vec()).unwrap();
          let default_settings = default_settings.replace("{{encryption_key}}", &backup_encryption_key);

          match f.write_all_at(default_settings.as_bytes(), 0) {
            Ok(_) => {
              info_messages.push("Created default settings file at ~/.infumap/settings.toml".to_owned());
            },
            Err(e) => {
              return Err(format!("Could not create default settings file at ~/.infumap/settings.toml: '{e}'").into());
            }
          };
        }

        Some(String::from(pb.as_os_str().to_str().unwrap()))
      }
    }
  };

  let config = build_config(settings_path_maybe)?;
  init_logger(Some(config.get_string(CONFIG_LOG_LEVEL)?.to_owned()))?;
  for message in info_messages {
    info!("{}", message);
  }

  if !expand_tilde_path_exists(config.get_string(CONFIG_DATA_DIR)?).await {
    return Err(format!("Data dir '{}' does not exist.", config.get_string(CONFIG_DATA_DIR)?).into());
  }

  if !expand_tilde_path_exists(config.get_string(CONFIG_CACHE_DIR)?).await {
    return Err(format!("Cache dir '{}' does not exist.", config.get_string(CONFIG_CACHE_DIR)?).into());
  }
  let num_created = ensure_256_subdirs(&expand_tilde(config.get_string(CONFIG_CACHE_DIR)?).unwrap()).await?;
  if num_created > 0 {
    warn!("Created {} cache subdirectories.", num_created);
  }

  if config.get_bool(CONFIG_ENABLE_S3_BACKUP)? {
    match config.get_string(CONFIG_BACKUP_ENCRYPTION_KEY) {
      Err(_) => {
        return Err("Backup encryption key must be set when backup is enabled.".into());
      },
      Ok(pw) => {
        if pw.len() != 64 {
          return Err("Invalid encryption key. You can use the infumap keygen cli command to create a valid one.".into());
        }
      }
    }
  }

  match config.get_string(CONFIG_S3_BACKUP_BUCKET) {
    Ok(backup_bucket) => {
      match config.get_string(CONFIG_S3_1_BUCKET) {
        Ok(s3_1_bucket) => {
          if backup_bucket == s3_1_bucket {
            return Err(format!("Backup bucket name '{}' must be different from s3_1 bucket name '{}'.", backup_bucket, s3_1_bucket).into());
          }
        },
        Err(_) => {}
      }
      match config.get_string(CONFIG_S3_2_BUCKET) {
        Ok(s3_2_bucket) => {
          if backup_bucket == s3_2_bucket {
            return Err(format!("Backup bucket name '{}' must be different from s3_2 bucket name '{}'.", backup_bucket, s3_2_bucket).into());
          }
        },
        Err(_) => {}
      }
    },
    Err(_) => {}
  }

  info!("Config:");
  info!(" {} = {}", CONFIG_LOG_LEVEL, config.get_string(CONFIG_LOG_LEVEL)?);
  info!(" {} = {}", CONFIG_ENV_ONLY, config.get_bool(CONFIG_ENV_ONLY)?);
  info!(" {} = '{}'", CONFIG_ADDRESS, config.get_string(CONFIG_ADDRESS)?);
  info!(" {} = '{}'", CONFIG_PORT, config.get_string(CONFIG_PORT)?);
  info!(" {} = {}", CONFIG_ENABLE_PROMETHEUS_METRICS, config.get_bool(CONFIG_ENABLE_PROMETHEUS_METRICS)?);
  if config.get_bool(CONFIG_ENABLE_PROMETHEUS_METRICS)? {
    info!("  {} = '{}'", CONFIG_PROMETHEUS_ADDRESS, config.get_string(CONFIG_PROMETHEUS_ADDRESS)?);
    info!("  {} = '{}'", CONFIG_PROMETHEUS_PORT, config.get_string(CONFIG_PROMETHEUS_PORT)?);
  }
  info!(" {} = '{}'", CONFIG_DATA_DIR, config.get_string(CONFIG_DATA_DIR)?);
  info!(" {} = '{}'", CONFIG_CACHE_DIR, config.get_string(CONFIG_CACHE_DIR)?);
  info!(" {} = {}", CONFIG_CACHE_MAX_MB, config.get_int(CONFIG_CACHE_MAX_MB)?);
  info!(" {} = {}", CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS, config.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS)?);
  info!(" {} = {}", CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT, config.get_int(CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT)?);
  info!(" {} = {}", CONFIG_MAX_SCALE_IMAGE_UP_PERCENT, config.get_int(CONFIG_MAX_SCALE_IMAGE_UP_PERCENT)?);
  info!(" {} = {}", CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, config.get_bool(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE)?);
  info!(" {} = {}", CONFIG_ENABLE_S3_1_OBJECT_STORAGE, config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE)?);
  if config.get_bool(CONFIG_ENABLE_S3_1_OBJECT_STORAGE)? {
    match config.get_string(CONFIG_S3_1_REGION) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_1_REGION, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_1_REGION, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_1_ENDPOINT) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_1_ENDPOINT, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_1_ENDPOINT, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_1_BUCKET) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_1_BUCKET, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_1_BUCKET, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_1_KEY) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_1_KEY, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_1_KEY, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_1_SECRET) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_1_SECRET, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_1_SECRET, "<not set>"); }
    }
  }
  info!(" {} = {}", CONFIG_ENABLE_S3_2_OBJECT_STORAGE, config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE)?);
  if config.get_bool(CONFIG_ENABLE_S3_2_OBJECT_STORAGE)? {
    match config.get_string(CONFIG_S3_2_REGION) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_2_REGION, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_2_REGION, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_2_ENDPOINT) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_2_ENDPOINT, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_2_ENDPOINT, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_2_BUCKET) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_2_BUCKET, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_2_BUCKET, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_2_KEY) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_2_KEY, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_2_KEY, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_2_SECRET) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_2_SECRET, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_2_SECRET, "<not set>"); }
    }
  }
  info!(" {} = {}", CONFIG_ENABLE_S3_BACKUP, config.get_bool(CONFIG_ENABLE_S3_BACKUP)?);
  if config.get_bool(CONFIG_ENABLE_S3_BACKUP)? {
    info!("  {} = {}", CONFIG_BACKUP_PERIOD_MINUTES, config.get_int(CONFIG_BACKUP_PERIOD_MINUTES)?);
    info!("  {} = {}", CONFIG_BACKUP_RETENTION_PERIOD_DAYS, config.get_int(CONFIG_BACKUP_RETENTION_PERIOD_DAYS)?);
    info!("  {} = {}", CONFIG_BACKUP_ENCRYPTION_KEY, "<redacted>");
    match config.get_string(CONFIG_S3_BACKUP_REGION) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_BACKUP_REGION, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_REGION, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_BACKUP_ENDPOINT) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_BACKUP_ENDPOINT, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_ENDPOINT, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_BACKUP_BUCKET) {
      Ok(v) => { info!("  {} = {}", CONFIG_S3_BACKUP_BUCKET, v); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_BUCKET, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_BACKUP_KEY) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_KEY, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_KEY, "<not set>"); }
    }
    match config.get_string(CONFIG_S3_BACKUP_SECRET) {
      Ok(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_SECRET, "<redacted>"); },
      Err(_) => { info!("  {} = {}", CONFIG_S3_BACKUP_SECRET, "<not set>"); }
    }
  }
  Ok(config)
}


fn build_config(settings_path_maybe: Option<String>) -> InfuResult<Config> {
  let config_builder =
  if let Some(path) = &settings_path_maybe {
    info!("Reading config from: {} + overriding with env vars where set.", path);
    Config::builder().add_source(
      config::File::new(path, FileFormat::Toml))
  } else {
    info!("Not using settings file - taking all settings from env vars.");
    Config::builder()
  }
    .add_source(config::Environment::with_prefix(ENV_CONFIG_PREFIX))
    .set_default(CONFIG_ENV_ONLY, CONFIG_ENV_ONLY_DEFAULT)?
    .set_default(CONFIG_LOG_LEVEL, CONFIG_LOG_LEVEL_DEFAULT)?
    .set_default(CONFIG_ADDRESS, CONFIG_ADDRESS_DEFAULT)?
    .set_default(CONFIG_PORT, CONFIG_PORT_DEFAULT)?
    .set_default(CONFIG_ENABLE_PROMETHEUS_METRICS, CONFIG_ENABLE_PROMETHEUS_METRICS_DEFAULT)?
    .set_default(CONFIG_PROMETHEUS_ADDRESS, CONFIG_PROMETHEUS_ADDRESS_DEFAULT)?
    .set_default(CONFIG_PROMETHEUS_PORT, CONFIG_PROMETHEUS_PORT_DEFAULT)?
    .set_default(CONFIG_DATA_DIR, CONFIG_DATA_DIR_DEFAULT)?
    .set_default(CONFIG_CACHE_DIR, CONFIG_CACHE_DIR_DEFAULT)?
    .set_default(CONFIG_CACHE_MAX_MB, CONFIG_CACHE_MAX_MB_DEFAULT)?
    .set_default(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS, CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS_DEFAULT)?
    .set_default(CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT, CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT_DEFAULT)?
    .set_default(CONFIG_MAX_SCALE_IMAGE_UP_PERCENT, CONFIG_MAX_SCALE_IMAGE_UP_PERCENT_DEFAULT)?
    .set_default(CONFIG_ENABLE_LOCAL_OBJECT_STORAGE, CONFIG_ENABLE_LOCAL_OBJECT_STORAGE_DEFAULT)?
    .set_default(CONFIG_ENABLE_S3_1_OBJECT_STORAGE, CONFIG_ENABLE_S3_1_OBJECT_STORAGE_DEFAULT)?
    .set_default(CONFIG_ENABLE_S3_2_OBJECT_STORAGE, CONFIG_ENABLE_S3_2_OBJECT_STORAGE_DEFAULT)?
    .set_default(CONFIG_ENABLE_S3_BACKUP, CONFIG_ENABLE_S3_BACKUP_DEFAULT)?
    .set_default(CONFIG_BACKUP_PERIOD_MINUTES, CONFIG_BACKUP_PERIOD_MINUTES_DEFAULT)?
    .set_default(CONFIG_BACKUP_RETENTION_PERIOD_DAYS, CONFIG_BACKUP_RETENTION_PERDIO_DAYS_DEFAULT)?;

  let result = match config_builder.build() {
    Ok(c) => c,
    Err(e) => {
      return Err(format!("An error occurred loading configuration: '{e}'").into());
    }
  };

  if result.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS)? < 0 {
    return Err(format!("{} must be greater than or equal to zero.", CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS).into());
  }

  return Ok(result)
}
