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
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";


export const Search_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  return (
    <div class="absolute rounded-xs border border-slate-300 bg-white text-slate-500 overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `pointer-events: none; ${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
      </Show>
      <div class="absolute flex items-center gap-2 px-3"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <i class="fa fa-search text-slate-400" />
        <span class="truncate italic">[search]</span>
      </div>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
