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
import { VisualElement_Desktop } from "../VisualElement";
import { PageVisualElementProps } from "./Page";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Umbrella: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  return (
    <div class={`absolute`}
      style={`left: ${props.pageFns.boundsPx().x}px; top: ${props.pageFns.boundsPx().y}px; width: ${props.pageFns.boundsPx().w}px; height: ${props.pageFns.boundsPx().h}px; ` +
        `background-color: #ffffff;`}>
      <For each={VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))()}>{childVes =>

        <VisualElement_Desktop visualElement={childVes.get()} />
      }</For>
      <Show when={VesCache.getDockVes(VeFns.veToPath(props.visualElement))() != null && VesCache.getDockVes(VeFns.veToPath(props.visualElement))()!.get() != null}>
        <VisualElement_Desktop visualElement={VesCache.getDockVes(VeFns.veToPath(props.visualElement))()!.get()!} />
      </Show>
    </div>
  );
}
