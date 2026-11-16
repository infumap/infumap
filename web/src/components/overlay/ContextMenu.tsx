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

import { Component, For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Vector } from "../../util/geometry";
import { HitInfo } from "../../input/hit";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { newItemInContext } from "../../input/create";
import { CREATE_KEYS, Key } from "../HelpContent";
import { MENU_ITEM_DISABLED_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS, menuItemClass } from "../library/dialogStyle";


type ContextMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};


// Image and File have no type argument: they are added by dropping files, so they are listed but disabled.
// Text file is grouped with them, not with Note: a new user reading a plain "Text" next to Note took it as
// somewhere to write, but its content is pasted in and read-only.
const MENU_ENTRIES: Array<{ type: string | null, label: string, icon: string, separatorBefore?: boolean }> = [
  { type: "note", label: "Note", icon: "fa fa-sticky-note" },
  { type: "page", label: "Page", icon: "fa fa-folder" },
  { type: "table", label: "Table", icon: "fa fa-table" },
  { type: "rating", label: "Rating", icon: "fa fa-star" },
  { type: "link", label: "Link", icon: "fa fa-link" },
  { type: "password", label: "Password", icon: "fa fa-eye-slash" },
  { type: "divider", label: "Divider", icon: "fa fa-arrows-h" },
  { type: "text", label: "Text file", icon: "far fa-file-lines", separatorBefore: true },
  { type: null, label: "Image", icon: "fa fa-image" },
  { type: null, label: "File", icon: "fa fa-file" },
];

const EDGE_MARGIN_PX = 4;

const createKeyFor = (type: string | null): string | null =>
  CREATE_KEYS.find(([_, itemType]) => itemType == type)?.[0] ?? null;


export const AddItem: Component<ContextMenuProps> = (props: ContextMenuProps) => {
  const store = useStore();

  return (
    <div class={`w-[160px] ${MENU_SURFACE_CLASS}`}>
      <For each={MENU_ENTRIES}>{entry => <>
        <Show when={entry.separatorBefore}>
          <div class={MENU_SEPARATOR_CLASS} />
        </Show>
        <div class={`flex items-center ${entry.type ? menuItemClass() : MENU_ITEM_DISABLED_CLASS}`}
             title={entry.type ? undefined : "Drop a file onto the page to add it"}
             onClick={() => { if (entry.type) { newItemInContext(store, entry.type, props.hitInfo, props.desktopPosPx); } }}>
          <div class="inline-block text-center w-[18px] mr-[6px]"><i class={entry.icon} /></div>
          <span class="flex-1">{entry.label}</span>
          <Show when={createKeyFor(entry.type)}>{k => <Key>{k()}</Key>}</Show>
        </div>
      </>}</For>
    </div>
  );
}


export const ContextMenu: Component = () => {
  const store = useStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) {
      ev.stopPropagation();
    }
  }

  const posPx = () => store.overlay.contextMenuInfo.get()!.posPx;
  const hitInfo = () => store.overlay.contextMenuInfo.get()!.hitInfo;

  // Opened near the bottom or right edge, the menu would run off the desktop, so it is kept inside it. The size is
  // measured once mounted; until then the unclamped position is used.
  let menuDiv: HTMLDivElement | undefined;
  const [menuSizePx, setMenuSizePx] = createSignal<{ w: number, h: number } | null>(null);
  onMount(() => { if (menuDiv) { setMenuSizePx({ w: menuDiv.offsetWidth, h: menuDiv.offsetHeight }); } });
  const clampedPosPx = (): Vector => {
    let x = posPx().x - 10;
    let y = posPx().y - 30;
    const size = menuSizePx();
    if (size != null) {
      const desktopPx = store.desktopBoundsPx();
      x = Math.max(EDGE_MARGIN_PX, Math.min(x, desktopPx.w - size.w - EDGE_MARGIN_PX));
      y = Math.max(EDGE_MARGIN_PX, Math.min(y, desktopPx.h - size.h - EDGE_MARGIN_PX));
    }
    return { x, y };
  };

  // Close on navigation (e.g. browser back), since the menu's position and hit info belong to the page it was opened
  // over. Clicks and keys close it elsewhere; this catches the ways of navigating that don't go through those.
  const locationKey = () => {
    const veid = store.history.currentPageVeid();
    return `${veid?.itemId ?? ""}/${veid?.linkIdMaybe ?? ""}|${store.history.currentPopupSpec()?.vePath ?? ""}`;
  };
  createEffect(on(locationKey, (key, prevKey) => {
    if (prevKey !== undefined && key != prevKey) { store.overlay.contextMenuInfo.set(null); }
  }));

  return (
    <div ref={menuDiv}
         class="absolute"
         style={`left: ${clampedPosPx().x}px; top: ${clampedPosPx().y}px; ` +
                `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}
