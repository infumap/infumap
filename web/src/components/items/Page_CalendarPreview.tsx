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
import { NoteFlags } from "../../items/base/flags-item";
import { asPageItem } from "../../items/page-item";
import { getTextStyleForNote } from "../../layout/text";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { BoundingBox } from "../../util/geometry";
import {
  CALENDAR_LAYOUT_CONSTANTS,
  CALENDAR_MONTH_NAMES,
  calculateCalendarPreviewDimensions,
  calculateCalendarPreviewVerticalLayout,
  calculateCalendarWindowForPage,
  calendarPreviewTextScale,
  formatCalendarWindowTitle,
  getCalendarMonthLeftPx,
  getCalendarMonthWidthPx,
} from "../../util/calendar-layout";
import { VisualElementProps, VisualElement_LineItem } from "../VisualElement";
import { CalendarRangeOverlays } from "./CalendarRangeOverlays";
import { outlineTextWidthPx } from "./LineItemOutline";
import { desktopStackRootStyle } from "./helper";


// Font sizes of the title (text-2xl) and month names (text-base) of a full size calendar page.
const TITLE_FONT_SIZE_PX = 24;
const MONTH_TITLE_FONT_SIZE_PX = 16;

const OUTLINE_COLOR = "#ddd";
const DAY_LINE_COLOR = "#e5e5e5";

/**
 * A calendar page shown in a non-interactive page (e.g. the selected item of a translucent list page), as a miniature
 * of the full size page (see calculateCalendarPreviewVerticalLayout): the title of the period, the month columns with
 * their names and day lines, and the items (arranged by arrange_calendar_page). Header text is exaggerated in size, and
 * drawn as a bar if still too small to be legible.
 */
export const Page_CalendarPreview: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const childAreaBoundsPx = () => props.visualElement.childAreaBoundsPx!;
  // The page is a miniature of the full size page, whose block size is natural.
  const scale = () => (props.visualElement.blockSizePx?.w ?? NATURAL_BLOCK_SIZE_PX.w) / NATURAL_BLOCK_SIZE_PX.w;
  const textScale = () => calendarPreviewTextScale(scale());

  const calendarWindow = () => calculateCalendarWindowForPage(
    store, vePath(), childAreaBoundsPx().w / scale(), asPageItem(props.visualElement.displayItem));
  const dimensions = () => calculateCalendarPreviewDimensions(childAreaBoundsPx(), scale(), calendarWindow());
  const verticalLayout = () => calculateCalendarPreviewVerticalLayout(childAreaBoundsPx().h, scale());

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

  const titleAreaPx = (): BoundingBox => ({
    x: CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN * scale(),
    y: CALENDAR_LAYOUT_CONSTANTS.TOP_PADDING * textScale(),
    w: childAreaBoundsPx().w - 2 * CALENDAR_LAYOUT_CONSTANTS.LEFT_RIGHT_MARGIN * scale(),
    h: CALENDAR_LAYOUT_CONSTANTS.TITLE_HEIGHT * textScale(),
  });

  return (
    <div class="absolute pointer-events-none overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      {renderText(formatCalendarWindowTitle(calendarWindow()), titleAreaPx(), TITLE_FONT_SIZE_PX, "font-bold")}
      <For each={calendarWindow().months}>{visibleMonth => {
        const leftPx = () => getCalendarMonthLeftPx(dimensions(), visibleMonth.month);
        const widthPx = () => getCalendarMonthWidthPx(dimensions(), visibleMonth.month);
        // Days with more items than fit are taller, so the day lines are those of the arranged layout.
        const dayLayouts = () =>
          props.visualElement.calendarMonthLayouts?.find(layout => layout.month == visibleMonth.month)?.days ?? [];
        return (
          <>
            {renderText(
              CALENDAR_MONTH_NAMES[visibleMonth.month - 1],
              { x: leftPx(), y: verticalLayout().monthTitleTopPx, w: widthPx(), h: verticalLayout().monthTitleHeightPx },
              MONTH_TITLE_FONT_SIZE_PX, "font-semibold")}
            <For each={dayLayouts()}>{dayLayout =>
              <div class="absolute"
                style={`left: ${leftPx()}px; top: ${dayLayout.topPx + dayLayout.heightPx - 1}px; width: ${widthPx()}px; height: 1px; ` +
                  `background-color: ${DAY_LINE_COLOR};`} />
            }</For>
          </>
        );
      }}</For>
      <CalendarRangeOverlays visualElement={props.visualElement} />
      <For each={VesCache.render.getChildren(vePath())()}>{childVes =>
        <VisualElement_LineItem visualElement={childVes.get()} />
      }</For>
    </div>
  );
}
