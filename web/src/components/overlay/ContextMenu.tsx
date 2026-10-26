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
import { useStore } from "../../store/StoreProvider";
import { Vector } from "../../util/geometry";
import { HitInfo } from "../../input/hit";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { newItemInContext } from "../../input/create";
import { CREATE_KEYS, Key } from "../HelpContent";


type ContextMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};


// Image and File have no type argument: they are added by dropping files, so they are listed but disabled.
const MENU_ENTRIES: Array<{ type: string | null, label: string, icon: string }> = [
  { type: "note", label: "Note", icon: "fa fa-sticky-note" },
  { type: "page", label: "Page", icon: "fa fa-folder" },
  { type: "table", label: "Table", icon: "fa fa-table" },
  { type: "rating", label: "Rating", icon: "fa fa-star" },
  { type: "link", label: "Link", icon: "fa fa-link" },
  { type: "password", label: "Password", icon: "fa fa-eye-slash" },
  { type: "divider", label: "Divider", icon: "fa fa-arrows-h" },
  { type: null, label: "Image", icon: "fa fa-image" },
  { type: "text", label: "Text", icon: "far fa-file-lines" },
  { type: null, label: "File", icon: "fa fa-file" },
];

const createKeyFor = (type: string | null): string | null =>
  CREATE_KEYS.find(([_, name]) => name == type)?.[0] ?? null;


export const AddItem: Component<ContextMenuProps> = (props: ContextMenuProps) => {
  const store = useStore();

  return (
    <div class="border rounded w-[140px] bg-slate-50 mb-1 shadow-lg pt-[3px] pb-[3px]">
      <For each={MENU_ENTRIES}>{entry =>
        <div class={`flex items-center text-sm ml-[3px] mr-[5px] p-[3px] ${entry.type ? "hover:bg-slate-300" : "text-slate-500"}`}
             onClick={() => { if (entry.type) { newItemInContext(store, entry.type, props.hitInfo, props.desktopPosPx); } }}>
          <div class="inline-block text-center w-[18px] mr-[4px]"><i class={entry.icon} /></div>
          <span class="flex-1">{entry.label}</span>
          <Show when={createKeyFor(entry.type)}>{k => <Key>{k()}</Key>}</Show>
        </div>
      }</For>
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

  return (
    <div class="absolute"
         style={`left: ${posPx().x-10}px; top: ${posPx().y-30}px; ` +
                `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}
