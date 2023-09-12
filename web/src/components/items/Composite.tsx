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
import { VisualElementProps, VisualElement_Desktop } from "../VisualElement";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { ATTACH_AREA_SIZE_PX } from "../../constants";
import { BoundingBox } from "../../util/geometry";


export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const _desktopStore = useDesktopStore();

  const boundsPx = () => props.visualElement.boundsPx;

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };

  return (
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg bg-white`}
         style={`left: ${boundsPx().x-1}px; top: ${boundsPx().y-1}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <For each={props.visualElement.children}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={props.visualElement.movingItemIsOverAttachComposite.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                      `background-color: #ff0000;`}>
          </div>
        </Show>
    </div>
  );
};

export const Composite_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const _desktopStore = useDesktopStore();

  return (
    <div>** Composite Line Item (TODO) **</div>
  )
}
