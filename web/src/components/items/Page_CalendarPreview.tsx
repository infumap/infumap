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

import { Component, For, Show } from "solid-js";
import { MIN_DETAILED_CHILD_SCALE, NATURAL_BLOCK_SIZE_PX } from "../../constants";
import { NoteFlags, getPageCalendarDisplayMode } from "../../items/base/flags-item";
import { asPageItem } from "../../items/page-item";
import { getTextStyleForNote } from "../../layout/text";
import { useStore } from "../../store/StoreProvider";
import { BoundingBox } from "../../util/geometry";
import {
  CALENDAR_LAYOUT_CONSTANTS,
  CALENDAR_MONTH_NAMES,
  calcCalendarRootChildAreaHeightPx,
  calculateCalendarDimensions,
  calculateCalendarWindow,
  calculateDefaultCalendarWindowStartMonthIndex,
  formatCalendarWindowTitle,
  getCalendarMonthLeftPx,
  getCalendarMonthWidthPx,
  getCalendarMonthsPerPageForDisplayMode,
} from "../../util/calendar-layout";
import { getMonthInfo } from "../../util/time";
import { VisualElementProps } from "../VisualElement";
import { outlineTextWidthPx } from "./LineItemOutline";
import { desktopStackRootStyle } from "./helper";


// Font sizes of the title (text-2xl) and month names (text-base) of a full size calendar page.
const TITLE_FONT_SIZE_PX = 24;
const MONTH_TITLE_FONT_SIZE_PX = 16;

// Text is drawn larger than in proportion to the page, by up to this factor (but never larger than at full size), so
// it remains legible at smaller sizes.
const TEXT_EXAGGERATION = 2.0;

// Gaps between and either side of month columns are this much wider than in proportion, so the columns remain
// distinct when small.
const EXTRA_MONTH_GAP_PX = 2;

const OUTLINE_COLOR = "#ddd";
const DAY_LINE_COLOR = "#e5e5e5";

/**
 * A calendar page shown in a non-interactive page (e.g. the selected item of a translucent list page), as a miniature
 * of the full size page without its contents: the title of the current period (e.g. "2026 H2"), and the month columns
 * with their names and day lines. Text is exaggerated in size, and drawn as a bar if still too small to be legible.
 */
export const Page_CalendarPreview: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const boundsPx = () => props.visualElement.boundsPx;
  // The page is a miniature of the full size page, whose block size is natural.
  const scale = () => (props.visualElement.blockSizePx?.w ?? NATURAL_BLOCK_SIZE_PX.w) / NATURAL_BLOCK_SIZE_PX.w;
  const textScale = () => scale() * Math.min(TEXT_EXAGGERATION, 1.0 / scale());

  // The layout of the full size page.
  const fullSizePx = () => ({
    w: boundsPx().w / scale(),
    h: calcCalendarRootChildAreaHeightPx(boundsPx().h / scale()),
  });
  const calendarWindow = () => {
    const page = asPageItem(props.visualElement.displayItem);
    const monthsPerPage = getCalendarMonthsPerPageForDisplayMode(
      fullSizePx().w, getPageCalendarDisplayMode(page), store.smallScreenMode());
    const monthIndex = calculateDefaultCalendarWindowStartMonthIndex(fullSizePx().w, page, store.smallScreenMode());
    return calculateCalendarWindow(fullSizePx().w, monthIndex, monthsPerPage, false);
  };
  const dimensions = () => calculateCalendarDimensions(fullSizePx(), null, calendarWindow());

  /** Text centered in an area (in preview px), or a bar if too small to be legible. */
  const renderText = (text: string, areaPx: BoundingBox, fontSizePx: number, fontWeightClass: string) => {
    const isLegible = textScale() * fontSizePx / getTextStyleForNote(NoteFlags.None).fontSize >= MIN_DETAILED_CHILD_SCALE;
    const renderedFontSizePx = fontSizePx * textScale();
    const centerY = areaPx.y + areaPx.h / 2;
    const barWidthPx = Math.min(outlineTextWidthPx(text.length, renderedFontSizePx * 1.5), areaPx.w);
    const barHeightPx = renderedFontSizePx * 0.6;
    return (
      <Show when={isLegible}
        fallback={
          <div class="absolute"
            style={`left: ${areaPx.x + (areaPx.w - barWidthPx) / 2}px; top: ${centerY - barHeightPx / 2}px; ` +
              `width: ${barWidthPx}px; height: ${barHeightPx}px; background-color: ${OUTLINE_COLOR};`} />
        }>
        <div class={`absolute flex items-center justify-center whitespace-nowrap overflow-hidden ${fontWeightClass}`}
          style={`left: ${areaPx.x}px; top: ${centerY - renderedFontSizePx}px; width: ${areaPx.w}px; height: ${renderedFontSizePx * 2}px; ` +
            `font-size: ${renderedFontSizePx}px;`}>
          {text}
        </div>
      </Show>
    );
  };

  // The header (title and month names) is enlarged along with its text, and the day rows fill the remaining height.
  // Without exaggeration (textScale == scale), this is the full size layout.
  const titleAreaPx = (): BoundingBox => ({
    x: CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN * scale(),
    y: CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING * textScale(),
    w: (fullSizePx().w - 2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN) * scale(),
    h: CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT * textScale(),
  });
  const monthTitleTopPx = () =>
    (CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT + CALENDAR_LAYOUT_CONSTANTS.TITLE_TO_MONTH_SPACING) * textScale();
  const monthTitleHeightPx = () => CALENDAR_LAYOUT_CONSTANTS.MONTH_TITLE_HEIGHT * textScale();
  const dayAreaTopPx = () => monthTitleTopPx() + monthTitleHeightPx();
  const dayRowHeightPx = () => {
    const fullSizeDayAreaBottomPx = dimensions().dayAreaTopPx + dimensions().availableHeightForDays;
    return Math.max(0, fullSizeDayAreaBottomPx * scale() - dayAreaTopPx()) / CALENDAR_LAYOUT_CONSTANTS.DAYS_COUNT;
  };

  return (
    <div class="absolute pointer-events-none overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      <For each={calendarWindow().months}>{(visibleMonth, monthIdx) => {
        // In preview px. Columns are narrowed so the gaps between them, and the left and right margins, are
        // EXTRA_MONTH_GAP_PX wider.
        const extraWidthPx = () => EXTRA_MONTH_GAP_PX * (calendarWindow().months.length + 1) / calendarWindow().months.length;
        const leftPx = () => getCalendarMonthLeftPx(dimensions(), visibleMonth.month) * scale() +
          EXTRA_MONTH_GAP_PX + monthIdx() * (EXTRA_MONTH_GAP_PX - extraWidthPx());
        const widthPx = () => Math.max(0, getCalendarMonthWidthPx(dimensions(), visibleMonth.month) * scale() - extraWidthPx());
        const days = () => Array.from({ length: getMonthInfo(visibleMonth.month, visibleMonth.year).daysInMonth }, (_, i) => i + 1);
        return (
          <>
            {renderText(
              CALENDAR_MONTH_NAMES[visibleMonth.month - 1],
              { x: leftPx(), y: monthTitleTopPx(), w: widthPx(), h: monthTitleHeightPx() },
              MONTH_TITLE_FONT_SIZE_PX, "font-semibold")}
            <For each={days()}>{day => {
              const lineYPx = () => dayAreaTopPx() + day * dayRowHeightPx() - 1;
              return (
                <div class="absolute"
                  style={`left: ${leftPx()}px; top: ${lineYPx()}px; width: ${widthPx()}px; height: 1px; ` +
                    `background-color: ${DAY_LINE_COLOR};`} />
              );
            }}</For>
          </>
        );
      }}</For>
      {renderText(formatCalendarWindowTitle(calendarWindow()), titleAreaPx(), TITLE_FONT_SIZE_PX, "font-bold")}
    </div>
  );
}
