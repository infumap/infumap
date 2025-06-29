/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Unix timestamp for Jan 1, 2200 (approximately 230 years after epoch)
const MAX_REASONABLE_UNIX_TIMESTAMP = 7_258_248_000;

// Minimum reasonable timestamp (Unix epoch start)
const MIN_REASONABLE_UNIX_TIMESTAMP = 0;

/**
 * Validates and sanitizes originalCreationDate values.
 * If the value is outside the reasonable range (< 0 or after year 2200),
 * returns 0 and logs a warning.
 */
export function sanitizeOriginalCreationDate(value: number, context: string): number {
  if (value < MIN_REASONABLE_UNIX_TIMESTAMP || value > MAX_REASONABLE_UNIX_TIMESTAMP) {
    console.warn(
      `originalCreationDate value ${value} is outside reasonable range (0 to ${MAX_REASONABLE_UNIX_TIMESTAMP}), setting to 0. Context: ${context}`
    );
    return 0;
  }
  return value;
} 