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

import { Component, Match, Switch } from "solid-js";
import { VisualElementProps } from "../VisualElement";
import { cloneBoundingBox } from "../../util/geometry";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const LinkDefault_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const boundsPx = () => props.visualElement.boundsPx;

  return (
    <div class={`absolute rounded-sm border border-slate-700`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;` +
                "background: repeating-linear-gradient(315deg, #fff, #fff 3px, #fdd 2px, #fdd 5px);" +
                `${VeFns.zIndexStyle(props.visualElement)} ${VeFns.opacityStyle(props.visualElement)}`} />
  );
}


export const LinkDefault_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const boundsPx = () => {
    let result = cloneBoundingBox(props.visualElement.boundsPx)!;
    result.y = result.y + 2;
    result.h = result.h - 4;
    result.x = result.x + 3;
    result.w = result.w - 6;
    return result;
  };

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
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
                  "background: repeating-linear-gradient(315deg, #fff, #fff 3px, #fdd 2px, #fdd 5px);"} />
    </>
  );
}
