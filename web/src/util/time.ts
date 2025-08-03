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

/**
 * Calculates month information for a given month and year.
 * @param month - Month (1-12, where 1 = January)
 * @param year - Full year (e.g., 2024)
 * @returns Object containing the number of days in the month and the day of the week (0-6) for the 1st
 */
export function getMonthInfo(month: number, year: number): { daysInMonth: number; firstDayOfWeek: number } {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Month must be between 1 and 12.`);
  }

  const firstOfMonth = new Date(year, month - 1, 1);

  // Get the day of the week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const firstDayOfWeek = firstOfMonth.getDay();

  // Calculate the number of days in the month
  // Create a Date for the 1st of the next month, then subtract 1 day
  const nextMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(nextMonth.getTime() - 1);
  const daysInMonth = lastDayOfMonth.getDate();

  return {
    daysInMonth,
    firstDayOfWeek
  };
}
