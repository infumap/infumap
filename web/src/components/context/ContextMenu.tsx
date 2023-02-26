/*
  Copyright (C) 2022 The Infumap Authors
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

import { Component, onCleanup, onMount, Show } from "solid-js";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { AddItem } from "./AddItem";


const ContextMenuInner: Component = () => {
  const generalStore = useGeneralStore();

  let contextMenuDiv: HTMLDivElement | undefined;

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => ev.stopPropagation();
  onMount(() => contextMenuDiv!.addEventListener('mousedown', mouseDownListener));
  onCleanup(() => contextMenuDiv!.removeEventListener('mousedown', mouseDownListener));

  const posPx = () => generalStore.contextMenuInfo()!.posPx;
  const item = () => generalStore.contextMenuInfo()!.item;
  return (
    <div ref={contextMenuDiv} class="absolute" style={`left: ${posPx().x}px; top: ${posPx().y}px`}>
      <AddItem desktopPosPx={posPx()} contextItem={item()} />
    </div>
  );
}


export const ContextMenu: Component = () => {
  const generalStore = useGeneralStore();
  return (
    <Show when={generalStore.contextMenuInfo() != null}>
      <ContextMenuInner />
    </Show>
  );
}
