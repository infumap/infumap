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

import { Component, Match, Show, Switch } from "solid-js";
import { VisualElementProps } from "../VisualElement";
import { cloneBoundingBox } from "../../util/geometry";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Placeholder_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const boundsPx = () => props.visualElement.boundsPx;

  return (
    <div class={`absolute rounded-sm border border-slate-200`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;` +
                `background: repeating-linear-gradient(315deg, #fff, #fff 3px, #eee 2px, #eee 5px); ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`} />
  );
}


export const Placeholder_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);

  const boundsPx = () => {
    let result = cloneBoundingBox(props.visualElement.boundsPx)!;
    result.y = result.y + 2;
    result.h = result.h - 4;
    result.x = result.x + 3;
    result.w = result.w - 6;
    return result;
  };

  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  return (
    <>
      {renderHighlightsMaybe()}
      <div class={`absolute rounded-sm border border-slate-200`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  "background: repeating-linear-gradient(315deg, #00000000, #00000000 3px, #eee 2px, #eee 5px);"} />
    </>
  );
}
