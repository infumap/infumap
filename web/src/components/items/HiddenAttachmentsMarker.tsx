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

import { Component, Show } from "solid-js";
import { LINE_HEIGHT_PX } from "../../constants";
import { VisualElement, VisualElementFlags } from "../../layout/visual-element";


const MARKER_WIDTH_PX = 4;
const MARKER_HEIGHT_PX = 8;
const MARKER_RIGHT_MARGIN_PX = 4;

/**
 * A small right pointing triangle at the right edge of a table row, indicating the row has attachments
 * beyond the visible columns.
 */
export const HiddenAttachmentsMarker: Component<{ rowVe: VisualElement, rowWidthPx: number }> = props => {
  const scale = () => props.rowVe.boundsPx.h / LINE_HEIGHT_PX;
  const wPx = () => MARKER_WIDTH_PX * scale();
  const hPx = () => MARKER_HEIGHT_PX * scale();

  return (
    <Show when={props.rowVe.flags & VisualElementFlags.HasHiddenAttachments}>
      <div class="absolute pointer-events-none"
        style={`left: ${props.rowWidthPx - wPx() - MARKER_RIGHT_MARGIN_PX * scale()}px; ` +
          `top: ${props.rowVe.boundsPx.y + (props.rowVe.boundsPx.h - hPx()) / 2}px; width: 0px; height: 0px; ` +
          `border-top: ${hPx() / 2}px solid transparent; border-bottom: ${hPx() / 2}px solid transparent; ` +
          `border-left: ${wPx()}px solid var(--color-item-border);`} />
    </Show>
  );
}
