/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { For } from "solid-js";
import { VisualElement } from "../../layout/visual-element";
import { MouseAction, MouseActionState } from "../../input/state";

interface CalendarRangeOverlaysProps {
  visualElement: VisualElement,
}

const RANGE_COLORS = [
  "#3b82f624",
  "#8b5cf624",
  "#06b6d424",
  "#10b98124",
  "#f59e0b24",
  "#ec489924",
] as const;

function rangeColors(itemId: string): typeof RANGE_COLORS[number] {
  let hash = 0;
  for (let i = 0; i < itemId.length; ++i) {
    hash = ((hash * 31) + itemId.charCodeAt(i)) | 0;
  }
  return RANGE_COLORS[Math.abs(hash) % RANGE_COLORS.length];
}

export function CalendarRangeOverlays(props: CalendarRangeOverlaysProps) {
  return (
    <For each={props.visualElement.calendarRangeLayouts}>{rangeLayout => {
      const colors = rangeColors(rangeLayout.itemId);
      const isActiveResize = MouseActionState.isAction(MouseAction.ResizingCalendarRange) &&
        MouseActionState.getCalendarRangeResize()?.occurrenceItemId == rangeLayout.itemId;
      return (
        <>
          <For each={rangeLayout.segments}>{segment =>
            <div
              class="absolute pointer-events-none"
              data-calendar-range-item-id={rangeLayout.itemId}
              style={`left: ${segment.boundsPx.x}px; top: ${segment.boundsPx.y}px; ` +
                `width: ${segment.boundsPx.w}px; height: ${segment.boundsPx.h}px; ` +
                `background-color: ${colors}; opacity: ${isActiveResize ? 1 : 0.78};`}
            />
          }</For>
        </>
      );
    }}</For>
  );
}
