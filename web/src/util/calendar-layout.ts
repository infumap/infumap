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
import type { StoreContextModel } from "../store/StoreProvider";
import { VeFns } from "../layout/visual-element";
import type { VisualElement } from "../layout/visual-element";
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
  SINGLE_MONTH_MAX_WIDTH_PX: 560,
  QUARTER_MAX_WIDTH_PX: 1200,
} as const;

export const CALENDAR_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface CalendarDimensions {
  columnWidth: number;
  columnWidths: Array<number>;
  columnLefts: Array<number>;
  totalColumnWidth: number;
  dayRowHeight: number;
  availableHeightForDays: number;
  dayAreaTopPx: number;
  visibleMonths: Array<number>;
}

export interface CalendarMonthResize {
  month: number;
  widthPx: number;
}

export interface CalendarVisibleMonth {
  monthIndex: number;
  month: number;
  year: number;
}

export interface CalendarWindow {
  anchorMonthIndex: number;
  startMonthIndex: number;
  monthsPerPage: 1 | 3 | 12;
  year: number;
  startMonth: number;
  endMonth: number;
  months: Array<CalendarVisibleMonth>;
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

export function encodeCalendarMonthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

export function decodeCalendarMonthIndex(monthIndex: number): { year: number; month: number } {
  const zeroBasedMonth = ((monthIndex % 12) + 12) % 12;
  const year = (monthIndex - zeroBasedMonth) / 12;
  return {
    year,
    month: zeroBasedMonth + 1,
  };
}

export function getCalendarMonthsPerPage(pageWidthPx: number): 1 | 3 | 12 {
  if (pageWidthPx < CALENDAR_LAYOUT_CONSTANTS.SINGLE_MONTH_MAX_WIDTH_PX) {
    return 1;
  }
  if (pageWidthPx < CALENDAR_LAYOUT_CONSTANTS.QUARTER_MAX_WIDTH_PX) {
    return 3;
  }
  return 12;
}

export function alignCalendarWindowStartMonthIndex(monthIndex: number, monthsPerPage: 1 | 3 | 12): number {
  const { year, month } = decodeCalendarMonthIndex(monthIndex);
  if (monthsPerPage == 12) {
    return encodeCalendarMonthIndex(year, 1);
  }
  if (monthsPerPage == 3) {
    return encodeCalendarMonthIndex(year, Math.floor((month - 1) / 3) * 3 + 1);
  }
  return monthIndex;
}

export function calculateCalendarWindow(pageWidthPx: number, monthIndex: number): CalendarWindow {
  const monthsPerPage = getCalendarMonthsPerPage(pageWidthPx);
  const startMonthIndex = alignCalendarWindowStartMonthIndex(monthIndex, monthsPerPage);
  const start = decodeCalendarMonthIndex(startMonthIndex);
  const months: Array<CalendarVisibleMonth> = [];
  for (let i = 0; i < monthsPerPage; ++i) {
    const currentMonthIndex = startMonthIndex + i;
    const current = decodeCalendarMonthIndex(currentMonthIndex);
    months.push({
      monthIndex: currentMonthIndex,
      month: current.month,
      year: current.year,
    });
  }

  return {
    anchorMonthIndex: monthIndex,
    startMonthIndex,
    monthsPerPage,
    year: start.year,
    startMonth: start.month,
    endMonth: months[months.length - 1].month,
    months,
  };
}

export function formatCalendarWindowTitle(calendarWindow: CalendarWindow): string {
  if (calendarWindow.monthsPerPage == 12) {
    return `${calendarWindow.year}`;
  }
  if (calendarWindow.monthsPerPage == 3) {
    return `${CALENDAR_MONTH_NAMES[calendarWindow.startMonth - 1]} - ${CALENDAR_MONTH_NAMES[calendarWindow.endMonth - 1]} ${calendarWindow.year}`;
  }
  return `${CALENDAR_MONTH_NAMES[calendarWindow.startMonth - 1]} ${calendarWindow.year}`;
}

export function isCalendarMonthVisible(calendarWindow: CalendarWindow, year: number, month: number): boolean {
  return calendarWindow.year === year && calendarWindow.months.some((visibleMonth) => visibleMonth.month === month);
}

export function calculateCalendarDimensions(
  childAreaBoundsPx: { w: number; h: number },
  monthResizeMaybe: CalendarMonthResize | null = null,
  calendarWindowMaybe: CalendarWindow | null = null,
): CalendarDimensions {
  const visibleMonths = calendarWindowMaybe?.months.map((month) => month.month) ??
    Array.from({ length: CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT }, (_, i) => i + 1);
  const visibleColumnCount = visibleMonths.length;
  const totalColumnWidth =
    childAreaBoundsPx.w -
    (visibleColumnCount - 1) * CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING -
    2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
  const columnWidth = totalColumnWidth / visibleColumnCount;

  const columnWidths = new Array<number>(visibleColumnCount).fill(columnWidth);
  if (visibleColumnCount == CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT &&
    monthResizeMaybe &&
    monthResizeMaybe.month >= 1 &&
    monthResizeMaybe.month <= CALENDAR_LAYOUT_CONSTANTS.COLUMNS_COUNT) {
    const minColumnWidth = Math.min(columnWidth, calculateCalendarMinimumColumnWidth(columnWidth));
    const maxActiveWidth = totalColumnWidth - (visibleColumnCount - 1) * minColumnWidth;

    if (maxActiveWidth > minColumnWidth) {
      const activeWidth = Math.max(minColumnWidth, Math.min(maxActiveWidth, monthResizeMaybe.widthPx));
      const otherWidth = (totalColumnWidth - activeWidth) / (visibleColumnCount - 1);
      for (let index = 0; index < visibleColumnCount; ++index) {
        columnWidths[index] = visibleMonths[index] === monthResizeMaybe.month ? activeWidth : otherWidth;
      }
    }
  }

  const columnLefts: Array<number> = [];
  let leftPx = CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
  for (let i = 0; i < visibleColumnCount; ++i) {
    columnLefts.push(leftPx);
    leftPx += columnWidths[i];
    if (i < visibleColumnCount - 1) {
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
    visibleMonths,
  };
}

export function getCalendarMonthLeftPx(dimensions: CalendarDimensions, month: number): number {
  const index = dimensions.visibleMonths.indexOf(month);
  return index >= 0 ? dimensions.columnLefts[index] : CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN;
}

export function getCalendarMonthWidthPx(dimensions: CalendarDimensions, month: number): number {
  const index = dimensions.visibleMonths.indexOf(month);
  return index >= 0 ? dimensions.columnWidths[index] : 0;
}

export function getCalendarDividerCenterPx(dimensions: CalendarDimensions, dividerAfterMonth: number): number {
  return getCalendarMonthLeftPx(dimensions, dividerAfterMonth) +
    getCalendarMonthWidthPx(dimensions, dividerAfterMonth) +
    CALENDAR_LAYOUT_CONSTANTS.MONTH_SPACING / 2;
}

export function getCalendarMonthForXOffset(dimensions: CalendarDimensions, xOffsetPx: number): number {
  for (let i = 0; i < dimensions.visibleMonths.length - 1; ++i) {
    const month = dimensions.visibleMonths[i];
    if (xOffsetPx < getCalendarDividerCenterPx(dimensions, month)) {
      return month;
    }
  }
  return dimensions.visibleMonths[dimensions.visibleMonths.length - 1] ?? 1;
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
  const pagePath = VeFns.veToPath(pageVe);
  const calendarWindow = calculateCalendarWindow(childAreaBounds.w, store.perVe.getCalendarMonthIndex(pagePath));
  const monthResizeMaybe = calendarWindow.monthsPerPage == 12
    ? store.perVe.getCalendarMonthResize(pagePath)
    : null;
  const dimensions = calculateCalendarDimensions(childAreaBounds, monthResizeMaybe, calendarWindow);

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
  const calendarWindow = calculateCalendarWindow(pageVe.childAreaBoundsPx!.w, store.perVe.getCalendarMonthIndex(VeFns.veToPath(pageVe)));
  const currentTime = new Date();
  const targetDate = new Date(
    calendarWindow.year,
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
