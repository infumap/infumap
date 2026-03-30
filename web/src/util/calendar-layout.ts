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

import { CALENDAR_DAY_LABEL_LEFT_MARGIN_PX } from "../constants";
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
  columnWidths: Array<number>;
  columnLefts: Array<number>;
  totalColumnWidth: number;
  dayRowHeight: number;
  availableHeightForDays: number;
  dayAreaTopPx: number;
}

export interface CalendarMonthResize {
  month: number;
  widthPx: number;
}

function calculateCalendarMinimumColumnWidth(defaultColumnWidth: number): number {
  return Math.max(
    12,
    Math.min(
      Math.max(CALENDAR_DAY_LABEL_LEFT_MARGIN_PX + 4, defaultColumnWidth * 0.45),
      defaultColumnWidth,
    ),
  );
}

export function calculateCalendarDimensions(
  childAreaBoundsPx: { w: number; h: number },
  monthResizeMaybe: CalendarMonthResize | null = null,
): CalendarDimensions {
  const totalColumnWidth =
    childAreaBoundsPx.w -
    (CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT - 1) * CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING -
    2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
  const columnWidth = totalColumnWidth / CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT;

  const columnWidths = new Array<number>(CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT).fill(columnWidth);
  if (monthResizeMaybe && monthResizeMaybe.month >= 1 && monthResizeMaybe.month <= CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT) {
    const minColumnWidth = Math.min(columnWidth, calculateCalendarMinimumColumnWidth(columnWidth));
    const maxActiveWidth = totalColumnWidth - (CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT - 1) * minColumnWidth;

    if (maxActiveWidth > minColumnWidth) {
      const activeWidth = Math.max(minColumnWidth, Math.min(maxActiveWidth, monthResizeMaybe.widthPx));
      const otherWidth = (totalColumnWidth - activeWidth) / (CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT - 1);
      for (let month = 1; month <= CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT; ++month) {
        columnWidths[month - 1] = month === monthResizeMaybe.month ? activeWidth : otherWidth;
      }
    }
  }

  const columnLefts: Array<number> = [];
  let leftPx = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
  for (let i = 0; i < CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT; ++i) {
    columnLefts.push(leftPx);
    leftPx += columnWidths[i];
    if (i < CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT - 1) {
      leftPx += CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING;
    }
  }
  
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
    columnWidths,
    columnLefts,
    totalColumnWidth,
    dayRowHeight,
    availableHeightForDays,
    dayAreaTopPx,
  };
}

export function getCalendarMonthLeftPx(dimensions: CalendarDimensions, month: number): number {
  return dimensions.columnLefts[month - 1];
}

export function getCalendarMonthWidthPx(dimensions: CalendarDimensions, month: number): number {
  return dimensions.columnWidths[month - 1];
}

export function getCalendarDividerCenterPx(dimensions: CalendarDimensions, dividerAfterMonth: number): number {
  return getCalendarMonthLeftPx(dimensions, dividerAfterMonth) +
    getCalendarMonthWidthPx(dimensions, dividerAfterMonth) +
    CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING / 2;
}

export function getCalendarMonthForXOffset(dimensions: CalendarDimensions, xOffsetPx: number): number {
  for (let month = 1; month < CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT; ++month) {
    if (xOffsetPx < getCalendarDividerCenterPx(dimensions, month)) {
      return month;
    }
  }
  return CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT;
}

export function solveCalendarMonthWidthForDividerOffset(
  childAreaBoundsPx: { w: number; h: number },
  dividerAfterMonth: number,
  resizedMonth: number,
  dividerCenterX: number,
): number {
  const defaultDimensions = calculateCalendarDimensions(childAreaBoundsPx);
  const defaultWidth = defaultDimensions.columnWidth;
  const minColumnWidth = Math.min(defaultWidth, calculateCalendarMinimumColumnWidth(defaultWidth));
  const maxActiveWidth = defaultDimensions.totalColumnWidth -
    (CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT - 1) * minColumnWidth;

  if (maxActiveWidth <= minColumnWidth) {
    return defaultWidth;
  }

  let low = minColumnWidth;
  let high = maxActiveWidth;
  const lowDividerX = getCalendarDividerCenterPx(
    calculateCalendarDimensions(childAreaBoundsPx, { month: resizedMonth, widthPx: low }),
    dividerAfterMonth,
  );
  const highDividerX = getCalendarDividerCenterPx(
    calculateCalendarDimensions(childAreaBoundsPx, { month: resizedMonth, widthPx: high }),
    dividerAfterMonth,
  );
  const isIncreasing = highDividerX >= lowDividerX;
  const minDividerX = Math.min(lowDividerX, highDividerX);
  const maxDividerX = Math.max(lowDividerX, highDividerX);

  if (dividerCenterX <= minDividerX) {
    return isIncreasing ? low : high;
  }
  if (dividerCenterX >= maxDividerX) {
    return isIncreasing ? high : low;
  }

  for (let i = 0; i < 24; ++i) {
    const mid = (low + high) / 2;
    const midDividerX = getCalendarDividerCenterPx(
      calculateCalendarDimensions(childAreaBoundsPx, { month: resizedMonth, widthPx: mid }),
      dividerAfterMonth,
    );
    if (Math.abs(midDividerX - dividerCenterX) < 0.25) {
      return mid;
    }
    if ((midDividerX < dividerCenterX) === isIncreasing) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
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
  const monthResizeMaybe = store.perVe.getCalendarMonthResize(VeFns.veToPath(pageVe));
  const dimensions = calculateCalendarDimensions(childAreaBounds, monthResizeMaybe);

  const veid = VeFns.veidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid) * (childAreaBounds.h - viewportBounds.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid) * (childAreaBounds.w - viewportBounds.w);

  const xOffsetPx = desktopPosPx.x - viewportBounds.x + scrollXPx;
  const yOffsetPx = desktopPosPx.y - viewportBounds.y + scrollYPx;

  const month = getCalendarMonthForXOffset(dimensions, xOffsetPx);
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

  const selectedYear = store.perVe.getCalendarYear(VeFns.veToPath(pageVe));
  const currentTime = new Date();
  const targetDate = new Date(
    selectedYear,
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
