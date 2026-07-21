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

import { For, Show } from "solid-js";
import { VisualElement } from "../../layout/visual-element";

interface CalendarRangeOverlaysProps {
  visualElement: VisualElement,
}

const RANGE_COLORS = [
  { fill: "#3b82f624", edge: "#2563eb99" },
  { fill: "#8b5cf624", edge: "#7c3aed99" },
  { fill: "#06b6d424", edge: "#0891b299" },
  { fill: "#10b98124", edge: "#05966999" },
  { fill: "#f59e0b24", edge: "#d9770699" },
  { fill: "#ec489924", edge: "#db277799" },
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
      return (
        <>
          <For each={rangeLayout.segments}>{segment =>
            <div
              class="absolute pointer-events-none"
              data-calendar-range-item-id={rangeLayout.itemId}
              style={`left: ${segment.boundsPx.x}px; top: ${segment.boundsPx.y}px; ` +
                `width: ${segment.boundsPx.w}px; height: ${segment.boundsPx.h}px; ` +
                `box-sizing: border-box; background-color: ${colors.fill}; ` +
                `border-left: 2px solid ${colors.edge}; border-right: 2px solid ${colors.edge}; ` +
                `${segment.startsAtRangeStart ? `border-top: 1px solid ${colors.edge}; ` : ""}` +
                `${segment.endsAtRangeEnd ? `border-bottom: 2px solid ${colors.edge}; ` : ""}`}
            />
          }</For>
          <Show when={rangeLayout.endDateTime != null && rangeLayout.endpointResizeBoundsPx != null}>
            <div
              class="absolute pointer-events-none"
              data-calendar-range-end-item-id={rangeLayout.itemId}
              style={`left: ${rangeLayout.endpointResizeBoundsPx!.x}px; ` +
                `top: ${rangeLayout.endpointResizeBoundsPx!.y + rangeLayout.endpointResizeBoundsPx!.h / 2 - 1}px; ` +
                `width: ${rangeLayout.endpointResizeBoundsPx!.w}px; height: 2px; ` +
                `background-color: ${colors.edge};`}
            />
          </Show>
        </>
      );
    }}</For>
  );
}
