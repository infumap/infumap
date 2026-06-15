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

import { CALENDAR_DAY_LABEL_LEFT_MARGIN_PX, CALENDAR_DAY_ROW_HEIGHT_BL, LINE_HEIGHT_PX } from "../constants";
import type { StoreContextModel } from "../store/StoreProvider";
import { VeFns, VisualElementFlags } from "../layout/visual-element";
import type { CalendarMiniDayLayout, CalendarMonthLayout, VisualElement } from "../layout/visual-element";
import { Vector } from "./geometry";
import { getMonthInfo } from "./time";
import { getPageCalendarDisplayMode, PageCalendarDisplayMode } from "../items/base/flags-item";

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
  HALF_YEAR_MAX_WIDTH_PX: 2400,
} as const;

export const CALENDAR_POPUP_LAYOUT_CONSTANTS = {
  TOP_PADDING: 5,
  TITLE_TO_MONTH_SPACING: 8,
  MONTH_TITLE_HEIGHT: 26,
  BOTTOM_MARGIN: 3,
} as const;

export const CALENDAR_MINI_LAYOUT_CONSTANTS = {
  TITLE_TO_DAYS_SPACING: 6,
  BOTTOM_MARGIN: 5,
  MIN_ROW_HEIGHT_SCALE: 0.9,
} as const;

export const CALENDAR_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type CalendarMonthsPerPage = 1 | 3 | 6 | 12;

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

export interface CalendarVerticalLayout {
  scale: number;
  dayAreaTopPx: number;
  dayRowHeight: number;
  availableHeightForDays: number;
  monthTitleTopPx: number;
  monthTitleHeightPx: number;
}

export interface CalendarDayMetrics {
  topPx: number;
  heightPx: number;
  rowHeightPx: number;
  rowCount: number;
  rowStart: number;
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
  monthsPerPage: CalendarMonthsPerPage;
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

export function getCalendarMonthsPerPage(pageWidthPx: number): CalendarMonthsPerPage {
  if (pageWidthPx < CALENDAR_LAYOUT_CONSTANTS.SINGLE_MONTH_MAX_WIDTH_PX) {
    return 1;
  }
  if (pageWidthPx < CALENDAR_LAYOUT_CONSTANTS.QUARTER_MAX_WIDTH_PX) {
    return 3;
  }
  if (pageWidthPx < CALENDAR_LAYOUT_CONSTANTS.HALF_YEAR_MAX_WIDTH_PX) {
    return 6;
  }
  return 12;
}

export function getCalendarMonthsPerPageForDisplayMode(
  pageWidthPx: number,
  displayMode: PageCalendarDisplayMode,
  smallScreenMode: boolean,
): CalendarMonthsPerPage {
  if (smallScreenMode || displayMode == PageCalendarDisplayMode.Month) { return 1; }
  if (displayMode == PageCalendarDisplayMode.Quarter) { return 3; }
  if (displayMode == PageCalendarDisplayMode.HalfYear) { return 6; }
  if (displayMode == PageCalendarDisplayMode.Year) { return 12; }
  return getCalendarMonthsPerPage(pageWidthPx);
}

export function alignCalendarWindowStartMonthIndex(monthIndex: number, monthsPerPage: CalendarMonthsPerPage): number {
  const { year, month } = decodeCalendarMonthIndex(monthIndex);
  if (monthsPerPage == 12) {
    return encodeCalendarMonthIndex(year, 1);
  }
  if (monthsPerPage == 6) {
    return encodeCalendarMonthIndex(year, Math.floor((month - 1) / 6) * 6 + 1);
  }
  if (monthsPerPage == 3) {
    return encodeCalendarMonthIndex(year, Math.floor((month - 1) / 3) * 3 + 1);
  }
  return monthIndex;
}

export function calculateCalendarWindow(
  pageWidthPx: number,
  monthIndex: number,
  monthsPerPageMaybe: CalendarMonthsPerPage | null = null,
  alignStart: boolean = true,
): CalendarWindow {
  const monthsPerPage = monthsPerPageMaybe ?? getCalendarMonthsPerPage(pageWidthPx);
  const startMonthIndex = alignStart
    ? alignCalendarWindowStartMonthIndex(monthIndex, monthsPerPage)
    : monthIndex;
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

export function calculateCalendarWindowForPage(
  store: StoreContextModel,
  vePath: string,
  pageWidthPx: number,
  page: { flags: number },
): CalendarWindow {
  const monthsPerPage = getCalendarMonthsPerPageForDisplayMode(
    pageWidthPx,
    getPageCalendarDisplayMode(page),
    store.smallScreenMode(),
  );
  const wasInitialized = store.perVe.hasCalendarMonthIndex(vePath);
  let monthIndex = store.perVe.getCalendarMonthIndex(vePath);
  if (!wasInitialized) {
    const alignedMonthIndex = calculateDefaultCalendarWindowStartMonthIndex(
      pageWidthPx,
      page,
      store.smallScreenMode(),
    );
    if (alignedMonthIndex != monthIndex) {
      store.perVe.setCalendarMonthIndex(vePath, alignedMonthIndex);
      monthIndex = alignedMonthIndex;
    }
  }
  return calculateCalendarWindow(pageWidthPx, monthIndex, monthsPerPage, false);
}

export function calculateDefaultCalendarWindowStartMonthIndex(
  pageWidthPx: number,
  page: { flags: number },
  smallScreenMode: boolean,
): number {
  const now = new Date();
  const currentMonthIndex = encodeCalendarMonthIndex(now.getFullYear(), now.getMonth() + 1);
  const monthsPerPage = getCalendarMonthsPerPageForDisplayMode(
    pageWidthPx,
    getPageCalendarDisplayMode(page),
    smallScreenMode,
  );
  return alignCalendarWindowStartMonthIndex(currentMonthIndex, monthsPerPage);
}

export function formatCalendarWindowTitle(calendarWindow: CalendarWindow): string {
  const firstMonth = calendarWindow.months[0];
  const lastMonth = calendarWindow.months[calendarWindow.months.length - 1];
  const rangeTitle = () => {
    if (firstMonth.year == lastMonth.year) {
      return `${firstMonth.year} ${CALENDAR_MONTH_NAMES[firstMonth.month - 1]} - ${CALENDAR_MONTH_NAMES[lastMonth.month - 1]}`;
    }
    return `${firstMonth.year} ${CALENDAR_MONTH_NAMES[firstMonth.month - 1]} - ${lastMonth.year} ${CALENDAR_MONTH_NAMES[lastMonth.month - 1]}`;
  };

  if (calendarWindow.monthsPerPage == 12) {
    if (firstMonth.month == 1 && lastMonth.month == 12 && firstMonth.year == lastMonth.year) {
      return `${firstMonth.year}`;
    }
    return rangeTitle();
  }
  if (calendarWindow.monthsPerPage == 6) {
    if ((firstMonth.month == 1 || firstMonth.month == 7) && firstMonth.year == lastMonth.year) {
      return `${firstMonth.year} ${firstMonth.month == 1 ? "H1" : "H2"}`;
    }
    return rangeTitle();
  }
  if (calendarWindow.monthsPerPage == 3) {
    if ((firstMonth.month == 1 || firstMonth.month == 4 || firstMonth.month == 7 || firstMonth.month == 10) &&
      firstMonth.year == lastMonth.year) {
      return `${firstMonth.year} Q${Math.floor((firstMonth.month - 1) / 3) + 1}`;
    }
    return rangeTitle();
  }
  return `${CALENDAR_MONTH_NAMES[firstMonth.month - 1]} ${firstMonth.year}`;
}

export function isCalendarMonthVisible(calendarWindow: CalendarWindow, year: number, month: number): boolean {
  return calendarWindow.months.some((visibleMonth) =>
    visibleMonth.year === year && visibleMonth.month === month);
}

export function calendarDateKey(year: number, month: number, day: number): string {
  return `${year}-${month}-${day}`;
}

function localCalendarDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

function addCalendarDays(date: Date, dayOffset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
}

export function calendarMiniScale(baseRowHeightPx: number): number {
  return Math.max(0.001, baseRowHeightPx / LINE_HEIGHT_PX);
}

export function calendarMiniTitleTopPx(baseRowHeightPx: number): number {
  return CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING * calendarMiniScale(baseRowHeightPx);
}

export function calendarMiniTitleHeightPx(baseRowHeightPx: number): number {
  return CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT * calendarMiniScale(baseRowHeightPx);
}

export function calendarMiniDayAreaTopPx(baseRowHeightPx: number): number {
  const scale = calendarMiniScale(baseRowHeightPx);
  return calendarMiniTitleTopPx(baseRowHeightPx) +
    calendarMiniTitleHeightPx(baseRowHeightPx) +
    CALENDAR_MINI_LAYOUT_CONSTANTS.TITLE_TO_DAYS_SPACING * scale;
}

export function calculateCalendarMiniDayLayouts(
  childAreaBoundsPx: { h: number },
  itemCountsByDate: ReadonlyMap<string, number>,
  baseRowHeightPx: number,
): Array<CalendarMiniDayLayout> {
  const today = getCurrentDayInfo();
  const startDate = localCalendarDate(today.year, today.month, today.day);
  const scale = calendarMiniScale(baseRowHeightPx);
  const dayAreaTopPx = calendarMiniDayAreaTopPx(baseRowHeightPx);
  const availableHeightForDays = Math.max(
    0,
    childAreaBoundsPx.h - dayAreaTopPx - CALENDAR_MINI_LAYOUT_CONSTANTS.BOTTOM_MARGIN * scale,
  );
  const minRowHeightPx = Math.max(1, baseRowHeightPx * CALENDAR_MINI_LAYOUT_CONSTANTS.MIN_ROW_HEIGHT_SCALE);
  const maxRowsAtMinHeight = Math.max(1, Math.floor(availableHeightForDays / minRowHeightPx));

  let totalRows = 0;
  const selectedDays: Array<{
    key: string,
    year: number,
    month: number,
    day: number,
    dayOfWeek: number,
    rowCount: number,
  }> = [];

  for (let dayOffset = 0; dayOffset < 370; ++dayOffset) {
    const date = addCalendarDays(startDate, dayOffset);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const key = calendarDateKey(year, month, day);
    const rowCount = Math.max(1, itemCountsByDate.get(key) ?? 0);
    if (selectedDays.length > 0 && totalRows + rowCount > maxRowsAtMinHeight) {
      break;
    }

    selectedDays.push({
      key,
      year,
      month,
      day,
      dayOfWeek: date.getDay(),
      rowCount,
    });
    totalRows += rowCount;

    if (totalRows >= maxRowsAtMinHeight) {
      break;
    }
  }

  const rowHeightPx = totalRows > 0
    ? Math.max(1, Math.min(baseRowHeightPx, availableHeightForDays / totalRows))
    : baseRowHeightPx;

  let rowStart = 0;
  return selectedDays.map(dayLayout => {
    const result = {
      key: dayLayout.key,
      year: dayLayout.year,
      month: dayLayout.month,
      day: dayLayout.day,
      dayOfWeek: dayLayout.dayOfWeek,
      rowStart,
      rowCount: dayLayout.rowCount,
      topPx: dayAreaTopPx + rowStart * rowHeightPx,
      heightPx: dayLayout.rowCount * rowHeightPx,
    };
    rowStart += dayLayout.rowCount;
    return result;
  });
}

export function getCalendarMiniRowHeightPx(dayLayouts: ReadonlyArray<CalendarMiniDayLayout>, fallbackPx: number): number {
  if (dayLayouts.length == 0 || dayLayouts[0].rowCount <= 0) {
    return fallbackPx;
  }
  return dayLayouts[0].heightPx / dayLayouts[0].rowCount;
}

export function formatCalendarMiniRangeTitle(dayLayouts: ReadonlyArray<CalendarMiniDayLayout>): string {
  if (dayLayouts.length == 0) {
    const today = getCurrentDayInfo();
    return `${CALENDAR_MONTH_NAMES[today.month - 1]} ${today.day}`;
  }

  const first = dayLayouts[0];
  const last = dayLayouts[dayLayouts.length - 1];
  const firstMonth = CALENDAR_MONTH_NAMES[first.month - 1];
  const lastMonth = CALENDAR_MONTH_NAMES[last.month - 1];
  if (first.year == last.year && first.month == last.month) {
    return first.day == last.day
      ? `${firstMonth} ${first.day}`
      : `${firstMonth} ${first.day}-${last.day}`;
  }
  if (first.year == last.year) {
    return `${firstMonth} ${first.day} - ${lastMonth} ${last.day}`;
  }
  return `${firstMonth} ${first.day}, ${first.year} - ${lastMonth} ${last.day}, ${last.year}`;
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

export function calculateCalendarVerticalLayout(
  childAreaBoundsPx: { h: number },
  isPopupRoot: boolean,
): CalendarVerticalLayout {
  if (!isPopupRoot) {
    return {
      scale: 1.0,
      dayAreaTopPx: CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT +
        CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING +
        CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT,
      dayRowHeight: (
        childAreaBoundsPx.h -
        CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING -
        CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT -
        CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING -
        CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT -
        CALENDAR_LAYOUT_CONSTANTS.BOTTOM_MARGIN
      ) / CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT,
      availableHeightForDays: (
        childAreaBoundsPx.h -
        CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING -
        CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT -
        CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING -
        CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT -
        CALENDAR_LAYOUT_CONSTANTS.BOTTOM_MARGIN
      ),
      monthTitleTopPx: CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT +
        CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING,
      monthTitleHeightPx: CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT,
    };
  }

  const baseDayRowPx = CALENDAR_DAY_ROW_HEIGHT_BL * LINE_HEIGHT_PX;
  const headerTotal =
    CALENDAR_POPUP_LAYOUT_CONSTANTS.TOP_PADDING +
    CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT +
    CALENDAR_POPUP_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING +
    CALENDAR_POPUP_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT +
    CALENDAR_POPUP_LAYOUT_CONSTANTS.BOTTOM_MARGIN;
  const naturalTotal = headerTotal + CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT * baseDayRowPx;
  const scale = naturalTotal > 0 ? childAreaBoundsPx.h / naturalTotal : 1.0;
  const monthTitleTopPx = (
    CALENDAR_POPUP_LAYOUT_CONSTANTS.TOP_PADDING +
    CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT +
    CALENDAR_POPUP_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING
  ) * scale;
  const monthTitleHeightPx = CALENDAR_POPUP_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT * scale;

  return {
    scale,
    dayAreaTopPx: monthTitleTopPx + monthTitleHeightPx,
    dayRowHeight: baseDayRowPx * scale,
    availableHeightForDays: baseDayRowPx * scale * CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT,
    monthTitleTopPx,
    monthTitleHeightPx,
  };
}

export function calculateCalendarMonthLayouts(
  calendarWindow: CalendarWindow,
  availableHeightForDays: number,
  dayAreaTopPx: number,
  itemCountsByDate: ReadonlyMap<string, number>,
): Array<CalendarMonthLayout> {
  return calendarWindow.months.map((visibleMonth) => {
    const monthInfo = getMonthInfo(visibleMonth.month, visibleMonth.year);
    const rowCounts: Array<number> = [];
    let totalRows = 0;
    for (let day = 1; day <= monthInfo.daysInMonth; ++day) {
      const rowCount = Math.max(1, itemCountsByDate.get(calendarDateKey(visibleMonth.year, visibleMonth.month, day)) ?? 0);
      rowCounts.push(rowCount);
      totalRows += rowCount;
    }

    const rowHeightPx = totalRows > 0 ? availableHeightForDays / totalRows : availableHeightForDays;
    const days = [];
    let rowStart = 0;
    for (let day = 1; day <= rowCounts.length; ++day) {
      const rowCount = rowCounts[day - 1];
      days.push({
        day,
        rowStart,
        rowCount,
        topPx: dayAreaTopPx + rowStart * rowHeightPx,
        heightPx: rowCount * rowHeightPx,
      });
      rowStart += rowCount;
    }

    return {
      key: `${visibleMonth.year}-${visibleMonth.month}`,
      year: visibleMonth.year,
      month: visibleMonth.month,
      totalRows,
      rowHeightPx,
      days,
    };
  });
}

export function getCalendarDayMetrics(
  dimensions: CalendarDimensions,
  calendarMonthLayouts: Array<CalendarMonthLayout> | null | undefined,
  month: number,
  day: number,
): CalendarDayMetrics {
  const monthLayout = calendarMonthLayouts?.find(layout => layout.month === month);
  const dayLayout = monthLayout?.days.find(layout => layout.day === day);
  if (monthLayout && dayLayout) {
    return {
      topPx: dayLayout.topPx,
      heightPx: dayLayout.heightPx,
      rowHeightPx: monthLayout.rowHeightPx,
      rowCount: dayLayout.rowCount,
      rowStart: dayLayout.rowStart,
    };
  }

  return {
    topPx: dimensions.dayAreaTopPx + (day - 1) * dimensions.dayRowHeight,
    heightPx: dimensions.dayRowHeight,
    rowHeightPx: dimensions.dayRowHeight,
    rowCount: 1,
    rowStart: day - 1,
  };
}

export function getCalendarDayForYOffset(
  dimensions: CalendarDimensions,
  calendarMonthLayouts: Array<CalendarMonthLayout> | null | undefined,
  month: number,
  yOffsetPx: number,
): number {
  const monthLayout = calendarMonthLayouts?.find(layout => layout.month === month);
  if (!monthLayout || monthLayout.days.length == 0) {
    return Math.floor((yOffsetPx - dimensions.dayAreaTopPx) / dimensions.dayRowHeight) + 1;
  }

  for (const dayLayout of monthLayout.days) {
    if (yOffsetPx < dayLayout.topPx + dayLayout.heightPx) {
      return dayLayout.day;
    }
  }

  return monthLayout.days[monthLayout.days.length - 1].day;
}

export function calculateCalendarDimensionsForVisualElement(
  pageVe: VisualElement,
  monthResizeMaybe: CalendarMonthResize | null = null,
  calendarWindowMaybe: CalendarWindow | null = null,
): CalendarDimensions {
  const childAreaBoundsPx = pageVe.childAreaBoundsPx!;
  const dimensions = calculateCalendarDimensions(childAreaBoundsPx, monthResizeMaybe, calendarWindowMaybe);
  if (!(pageVe.flags & VisualElementFlags.Popup)) {
    return dimensions;
  }

  const verticalLayout = calculateCalendarVerticalLayout(
    childAreaBoundsPx,
    true,
  );

  return {
    ...dimensions,
    dayAreaTopPx: verticalLayout.dayAreaTopPx,
    dayRowHeight: verticalLayout.dayRowHeight,
    availableHeightForDays: verticalLayout.availableHeightForDays,
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
  year?: number;
}

export function getCalendarMiniDayLayoutForPosition(
  dayLayouts: ReadonlyArray<CalendarMiniDayLayout>,
  position: CalendarPosition,
): CalendarMiniDayLayout | null {
  return dayLayouts.find(layout =>
    layout.month == position.month &&
    layout.day == position.day &&
    (position.year == null || layout.year == position.year)) ?? null;
}

export function getCalendarMiniPositionForYOffset(
  dayLayouts: ReadonlyArray<CalendarMiniDayLayout>,
  yOffsetPx: number,
): CalendarPosition {
  if (dayLayouts.length == 0) {
    const currentDay = getCurrentDayInfo();
    return currentDay;
  }

  for (const dayLayout of dayLayouts) {
    if (yOffsetPx < dayLayout.topPx + dayLayout.heightPx) {
      return {
        year: dayLayout.year,
        month: dayLayout.month,
        day: dayLayout.day,
      };
    }
  }

  const lastDayLayout = dayLayouts[dayLayouts.length - 1];
  return {
    year: lastDayLayout.year,
    month: lastDayLayout.month,
    day: lastDayLayout.day,
  };
}

export function calculateCalendarPosition(
  desktopPosPx: Vector,
  pageVe: VisualElement,
  store: StoreContextModel
): CalendarPosition {
  const childAreaBounds = pageVe.childAreaBoundsPx!;
  const viewportBounds = pageVe.viewportBoundsPx!;
  const veid = pageVe.flags & VisualElementFlags.Popup
    ? store.history.currentPopupSpec()?.actualVeid ?? VeFns.actualVeidFromVe(pageVe)
    : VeFns.actualVeidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(veid) * Math.max(0, childAreaBounds.h - viewportBounds.h);
  const scrollXPx = store.perItem.getPageScrollXProp(veid) * Math.max(0, childAreaBounds.w - viewportBounds.w);
  const viewportBoundsOnDesktop = pageVe.flags & VisualElementFlags.Fixed
    ? viewportBounds
    : VeFns.veViewportBoundsRelativeToDesktopPx(store, pageVe);

  const xOffsetPx = desktopPosPx.x - viewportBoundsOnDesktop.x + scrollXPx;
  const yOffsetPx = desktopPosPx.y - viewportBoundsOnDesktop.y + scrollYPx;

  if ((pageVe.calendarMiniDayLayouts ?? []).length > 0) {
    return getCalendarMiniPositionForYOffset(pageVe.calendarMiniDayLayouts, yOffsetPx);
  }

  const pagePath = VeFns.veToPath(pageVe);
  const calendarWindow = calculateCalendarWindowForPage(store, pagePath, childAreaBounds.w, pageVe.displayItem as any);
  const monthResizeMaybe = calendarWindow.monthsPerPage == 12
    ? store.perVe.getCalendarMonthResize(pagePath)
    : null;
  const dimensions = calculateCalendarDimensionsForVisualElement(pageVe, monthResizeMaybe, calendarWindow);

  const month = getCalendarMonthForXOffset(dimensions, xOffsetPx);
  const day = getCalendarDayForYOffset(dimensions, pageVe.calendarMonthLayouts, month, yOffsetPx);

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
  return calculateCalendarDateTimeForPosition(position, pageVe, store);
}

export function calculateCalendarDateTimeForPosition(
  position: CalendarPosition,
  pageVe: VisualElement,
  store: StoreContextModel,
  baseDateTimeSeconds: number | null = null,
  targetYearOverride: number | null = null,
): number {
  const currentTime = baseDateTimeSeconds == null
    ? new Date()
    : new Date(baseDateTimeSeconds * 1000);
  let targetYear = targetYearOverride ?? position.year ?? null;
  if (targetYear == null && (pageVe.calendarMiniDayLayouts ?? []).length > 0) {
    targetYear = getCalendarMiniDayLayoutForPosition(pageVe.calendarMiniDayLayouts, position)?.year ?? null;
  }
  if (targetYear == null) {
    const calendarWindow = calculateCalendarWindowForPage(
      store,
      VeFns.veToPath(pageVe),
      pageVe.childAreaBoundsPx!.w,
      pageVe.displayItem as any,
    );
    const visibleMonth = calendarWindow.months.find(month => month.month === position.month);
    targetYear = visibleMonth?.year ?? calendarWindow.year;
  }
  const targetDay = Math.max(1, Math.min(position.day, getMonthInfo(position.month, targetYear).daysInMonth));
  const targetDate = new Date(
    targetYear,
    position.month - 1, 
    targetDay, 
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
