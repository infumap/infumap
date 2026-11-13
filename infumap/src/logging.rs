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

use infusdk::util::infu::InfuResult;
use std::env;
use std::str::FromStr;

pub fn init_logger(level: Option<String>) -> InfuResult<()> {
  // pretty_env_logger::init();
  let level = if let Some(level) = level {
    log::LevelFilter::from_str(&level).map_err(|e| format!("Could not parse log level: {}", e))?
  } else {
    let key = "INFUMAP_LOG_LEVEL";
    let log_level_str = match env::var(key) {
      Err(_) => "info".to_owned(),
      Ok(v) => v,
    };
    log::LevelFilter::from_str(&log_level_str).map_err(|e| format!("Could not parse log level: {}", e))?
  };
  pretty_env_logger::formatted_timed_builder()
    .format_timestamp_secs()
    .filter_module("infumap", level)
    .filter_module("infusdk", level)
    .init();
  Ok(())
}
