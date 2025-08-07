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

import { StoreContextModel } from "../store/StoreProvider";
import { VeFns, VisualElement } from "../layout/visual-element";
import { Vector } from "./geometry";

export const CALENDAR_LAYOUT_CONSTANTS = {
  COLUMNS_COUNT: 12,
  DAYS_COUNT: 31,
  TITLE_HEIGHT: 40,
  MONTH_TITLE_HEIGHT: 30,
  TOP_PADDING: 7,
  BOTTOM_MARGIN: 5,
  MONTH_SPACING: 5,
  LEFT_RIGHT_MARGIN: 5,
  TITLE_TO_MONTH_SPACING: 14,
} as const;

export interface CalendarDimensions {
  columnWidth: number;
  dayRowHeight: number;
  availableHeightForDays: number;
  dayAreaTopPx: number;
}

export function calculateCalendarDimensions(childAreaBoundsPx: { w: number; h: number }): CalendarDimensions {
  const columnWidth = (childAreaBoundsPx.w - 11 * CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING - 2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN) / CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT;
  
  const availableHeightForDays = childAreaBoundsPx.h - 
    CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING - 
    CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT - 
    CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING - 
    CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT - 
    CALENDAR_LAYOUT_CONSTANTS.BOTTOM_MARGIN;
  
  const dayRowHeight = availableHeightForDays / CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT;
  
  const dayAreaTopPx = CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + 
    CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING + 
    CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT;

  return {
    columnWidth,
    dayRowHeight,
    availableHeightForDays,
    dayAreaTopPx,
  };
}

export interface CalendarPosition {
  month: number;
  day: number;
}

export function calculateCalendarPosition(
  desktopPosPx: Vector,
  pageVe: VisualElement,
  store: StoreContextModel
): CalendarPosition {
  const childAreaBounds = pageVe.childAreaBoundsPx!;
  const viewportBounds = pageVe.viewportBoundsPx!;
  const dimensions = calculateCalendarDimensions(childAreaBounds);

  const veid = VeFns.veidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid) * (childAreaBounds.h - viewportBounds.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid) * (childAreaBounds.w - viewportBounds.w);

  const xOffsetPx = desktopPosPx.x - viewportBounds.x + scrollXPx;
  const yOffsetPx = desktopPosPx.y - viewportBounds.y + scrollYPx;

  const month = Math.floor((xOffsetPx - CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN) / (dimensions.columnWidth + CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING)) + 1;
  const day = Math.floor((yOffsetPx - dimensions.dayAreaTopPx) / dimensions.dayRowHeight) + 1;

  const clampedMonth = Math.max(1, Math.min(12, month));
  const clampedDay = Math.max(1, Math.min(31, day));

  return {
    month: clampedMonth,
    day: clampedDay,
  };
}

export function calculateCalendarDateTime(
  desktopPosPx: Vector,
  pageVe: VisualElement,
  store: StoreContextModel
): number {
  const position = calculateCalendarPosition(desktopPosPx, pageVe, store);
  
  const currentYear = new Date().getFullYear();
  const currentTime = new Date();
  const targetDate = new Date(
    currentYear, 
    position.month - 1, 
    position.day, 
    currentTime.getHours(), 
    currentTime.getMinutes(), 
    currentTime.getSeconds()
  );

  return Math.floor(targetDate.getTime() / 1000);
}

export function encodeCalendarCombinedIndex(month: number, day: number): number {
  return month * 100 + day;
}

export function decodeCalendarCombinedIndex(combinedIndex: number): CalendarPosition {
  const month = Math.floor(combinedIndex / 100);
  const day = combinedIndex % 100;
  return { month, day };
}

export function getCurrentDayInfo(): { month: number; day: number; year: number } {
  const now = new Date();
  return {
    month: now.getMonth() + 1,
    day: now.getDate(),
    year: now.getFullYear()
  };
}

export function isCurrentDay(month: number, day: number, year: number): boolean {
  const currentDay = getCurrentDayInfo();
  return currentDay.month === month && currentDay.day === day && currentDay.year === year;
} 