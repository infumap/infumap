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

use std::time::SystemTime;
use log::warn;

use super::infu::InfuResult;

// Unix timestamp for Jan 1, 2200 (approximately 230 years after epoch)
const MAX_REASONABLE_UNIX_TIMESTAMP: i64 = 7_258_248_000;

// Minimum reasonable timestamp (Unix epoch start)
const MIN_REASONABLE_UNIX_TIMESTAMP: i64 = 0;

pub fn unix_now_secs_i64() -> InfuResult<i64> {
  Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs() as i64)
}

pub fn unix_now_secs_u64() -> InfuResult<u64> {
  Ok(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs())
}

/// Validates and sanitizes originalCreationDate values.
/// If the value is outside the reasonable range (< 0 or after year 2200),
/// returns 0 and logs a warning.
pub fn sanitize_original_creation_date(value: i64, context: &str) -> i64 {
  if value < MIN_REASONABLE_UNIX_TIMESTAMP || value > MAX_REASONABLE_UNIX_TIMESTAMP {
    // warn!(
    //   "originalCreationDate value {} is outside reasonable range (0 to {}), setting to 0. Context: {}",
    //   value, MAX_REASONABLE_UNIX_TIMESTAMP, context
    // );
    0
  } else {
    value
  }
}
