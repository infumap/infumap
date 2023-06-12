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
import { AddItem } from "./AddItem";
import { useDesktopStore } from "../../store/DesktopStoreProvider";


const ContextMenuInner: Component = () => {
  const desktopStore = useDesktopStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  }

  const posPx = () => desktopStore.contextMenuInfo()!.posPx;
  const hitInfo = () => desktopStore.contextMenuInfo()!.hitInfo;

  return (
    <div class="absolute"
         style={`left: ${posPx().x}px; top: ${posPx().y}px`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}


export const ContextMenu: Component = () => {
  const desktopStore = useDesktopStore();

  return (
    <Show when={desktopStore.contextMenuInfo() != null}>
      <ContextMenuInner />
    </Show>
  );
}
