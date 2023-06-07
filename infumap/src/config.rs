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


pub const ENV_CONFIG_PREFIX: &'static str = "INFUMAP";


pub const CONFIG_LOG_LEVEL: &'static str = "log_level";
pub const CONFIG_LOG_LEVEL_DEFAULT: &'static str = "info";

pub const CONFIG_ADDRESS: &'static str = "address";
pub const CONFIG_ADDRESS_DEFAULT: &'static str = "127.0.0.1";

pub const CONFIG_PORT: &'static str = "port";
pub const CONFIG_PORT_DEFAULT: &'static str = "8000";

pub const CONFIG_ENABLE_PROMETHEUS_METRICS: &'static str = "enable_prometheus_metrics";
pub const CONFIG_ENABLE_PROMETHEUS_METRICS_DEFAULT: bool = false;

pub const CONFIG_PROMETHEUS_ADDRESS: &'static str = "prometheus_address";
pub const CONFIG_PROMETHEUS_ADDRESS_DEFAULT: &'static str = "127.0.0.1";

pub const CONFIG_PROMETHEUS_PORT: &'static str = "prometheus_port";
pub const CONFIG_PROMETHEUS_PORT_DEFAULT: &'static str = "9090";

pub const CONFIG_DATA_DIR: &'static str = "data_dir";
pub const CONFIG_DATA_DIR_DEFAULT: &'static str = "~/.infumap/data";

pub const CONFIG_CACHE_DIR: &'static str = "cache_dir";
pub const CONFIG_CACHE_DIR_DEFAULT: &'static str = "~/.infumap/cache";

pub const CONFIG_CACHE_MAX_MB: &'static str = "cache_max_mb";
pub const CONFIG_CACHE_MAX_MB_DEFAULT: u64 = 500;

pub const CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS: &'static str = "browser_cache_max_age_seconds";
pub const CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS_DEFAULT: u64 = 31536000;

pub const CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT: &'static str = "max_scale_image_down_percent";
pub const CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT_DEFAULT: u64 = 30;

pub const CONFIG_MAX_SCALE_IMAGE_UP_PERCENT: &'static str = "max_scale_image_up_percent";
pub const CONFIG_MAX_SCALE_IMAGE_UP_PERCENT_DEFAULT: u64 = 5;

pub const CONFIG_ENV_ONLY: &'static str = "env_only";
pub const CONFIG_ENV_ONLY_DEFAULT: bool = false;

pub const CONFIG_ENABLE_LOCAL_OBJECT_STORAGE: &'static str = "enable_local_object_storage";
pub const CONFIG_ENABLE_LOCAL_OBJECT_STORAGE_DEFAULT: bool = true;

pub const CONFIG_ENABLE_S3_1_OBJECT_STORAGE: &'static str = "enable_s3_1_object_storage";
pub const CONFIG_ENABLE_S3_1_OBJECT_STORAGE_DEFAULT: bool = false;

pub const CONFIG_S3_1_REGION: &'static str = "s3_1_region";
pub const CONFIG_S3_1_ENDPOINT: &'static str = "s3_1_endpoint";
pub const CONFIG_S3_1_BUCKET: &'static str = "s3_1_bucket";
pub const CONFIG_S3_1_KEY: &'static str = "s3_1_key";
pub const CONFIG_S3_1_SECRET: &'static str = "s3_1_secret";

pub const CONFIG_ENABLE_S3_2_OBJECT_STORAGE: &'static str = "enable_s3_2_object_storage";
pub const CONFIG_ENABLE_S3_2_OBJECT_STORAGE_DEFAULT: bool = false;

pub const CONFIG_S3_2_REGION: &'static str = "s3_2_region";
pub const CONFIG_S3_2_ENDPOINT: &'static str = "s3_2_endpoint";
pub const CONFIG_S3_2_BUCKET: &'static str = "s3_2_bucket";
pub const CONFIG_S3_2_KEY: &'static str = "s3_2_key";
pub const CONFIG_S3_2_SECRET: &'static str = "s3_2_secret";

pub const CONFIG_ENABLE_S3_BACKUP: &'static str = "enable_s3_backup";
pub const CONFIG_ENABLE_S3_BACKUP_DEFAULT: bool = false;

pub const CONFIG_BACKUP_PERIOD_MINUTES: &'static str = "backup_period_minutes";
pub const CONFIG_BACKUP_PERIOD_MINUTES_DEFAULT: u32 = 60;

pub const CONFIG_BACKUP_RETENTION_PERIOD_DAYS: &'static str = "backup_retention_period_days";
pub const CONFIG_BACKUP_RETENTION_PERDIO_DAYS_DEFAULT: u32 = 30;

pub const CONFIG_BACKUP_ENCRYPTION_KEY: &'static str = "backup_encryption_key";

pub const CONFIG_S3_BACKUP_REGION: &'static str = "s3_backup_region";
pub const CONFIG_S3_BACKUP_ENDPOINT: &'static str = "s3_backup_endpoint";
pub const CONFIG_S3_BACKUP_BUCKET: &'static str = "s3_backup_bucket";
pub const CONFIG_S3_BACKUP_KEY: &'static str = "s3_backup_key";
pub const CONFIG_S3_BACKUP_SECRET: &'static str = "s3_backup_secret";
