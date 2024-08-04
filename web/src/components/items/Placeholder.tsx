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

import { Component } from "solid-js";
import { VisualElementProps } from "../VisualElement";
import { VeFns } from "../../layout/visual-element";


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
