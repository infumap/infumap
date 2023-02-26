// Copyright (C) 2023 The Infumap Authors
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

use config::Config;


pub const ENV_CONFIG_PREFIX: &'static str = "INFUMAP";

pub const CONFIG_DATA_DIR: &'static str = "data_dir";
pub const CONFIG_DATA_DIR_DEFAULT: &'static str = "~/.infumap/data";

pub const CONFIG_CACHE_DIR: &'static str = "cache_dir";
pub const CONFIG_CACHE_DIR_DEFAULT: &'static str = "~/.infumap/cache";

pub const CONFIG_CACHE_MAX_MB: &'static str = "cache_max_mb";
pub const CONFIG_CACHE_MAX_MB_DEFAULT: u64 = 500;

pub const CONFIG_MAX_IMAGE_SIZE_DEVIATION_SMALLER_PERCENT: &'static str = "max_image_size_deviation_smaller_percent";
pub const CONFIG_MAX_IMAGE_SIZE_DEVIATION_SMALLER_PERCENT_DEFAULT: u64 = 30;

pub const CONFIG_MAX_IMAGE_SIZE_DEVIATION_LARGER_PERCENT: &'static str = "max_image_size_deviation_larger_percent";
pub const CONFIG_MAX_IMAGE_SIZE_DEVIATION_LARGER_PERCENT_DEFAULT: u64 = 5;

pub const CONFIG_ENV_ONLY: &'static str = "env_only";
pub const CONFIG_ENV_ONLY_DEFAULT: bool = false;

pub const CONFIG_ENABLE_PROMETHEUS_METRICS: &'static str = "enable_prometheus_metrics";
pub const CONFIG_ENABLE_PROMETHEUS_METRICS_DEFAULT: bool = false;

// TODO (LOW): This struct should be deprecated - settings_path_maybe is no longer needed.
pub struct ConfigAndPath {
  pub settings_path_maybe: Option<String>,
  pub config: Config
}
