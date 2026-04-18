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

import { PopupActionStripLayout } from "../../util/popupHeaderActions";


interface PopupActionStripProps<T extends string = string> {
  background: string;
  borderColor: string;
  fixed: boolean;
  layout: PopupActionStripLayout<T>;
  shadow?: string;
  textColor: string;
  zIndexStyle: string;
}

export const PopupActionStrip: Component<PopupActionStripProps> = (props: PopupActionStripProps) => (
  <Show when={props.layout.actions.length > 0}>
    <div class={`${props.fixed ? "fixed" : "absolute"} pointer-events-none`}
      style={`left: ${props.layout.boundsPx.x}px; top: ${props.layout.boundsPx.y}px; ` +
        `width: ${props.layout.boundsPx.w}px; height: ${props.layout.boundsPx.h}px; ` +
        `${props.zIndexStyle}`}>
      <For each={props.layout.actions}>{action =>
        <div class="absolute flex items-center justify-center font-semibold pointer-events-none"
          style={`left: ${action.boundsPx.x - props.layout.boundsPx.x}px; top: 0px; ` +
            `width: ${action.widthPx}px; height: ${props.layout.heightPx}px; ` +
            `font-size: ${props.layout.fontSizePx}px; ` +
            `letter-spacing: 0.01em; ` +
            `color: ${props.textColor}; ` +
            `background: ${props.background}; ` +
            `border: 1px solid ${props.borderColor}; ` +
            `border-radius: 5px; ` +
            (props.shadow != null ? `box-shadow: ${props.shadow}; ` : "")}>
            {action.label}
        </div>
      }</For>
    </div>
  </Show>
);
