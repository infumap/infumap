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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { CursorEventState } from "../../input/state";
import { arrange } from "../../layout/arrange";
import { VeFns } from "../../layout/visual-element";
import { itemState } from "../../store/ItemState";
import { asNoteItem } from "../../items/note-item";
import { isInside } from "../../util/geometry";


export const Toolbar_NoteEditUrl: Component = () => {
  const desktopStore = useDesktopStore();

  let urlTextElement: HTMLInputElement | undefined;

  const noteItem = () => asNoteItem(itemState.get(VeFns.veidFromPath(desktopStore.textEditOverlayInfo.get()!.itemPath).itemId)!);

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), urlBoxBoundsPx())) { return; }
    desktopStore.noteUrlOverlayInfoMaybe.set(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const handleUrlChange = () => {
    noteItem().url = urlTextElement!.value;
    arrange(desktopStore);
  };

  const urlBoxBoundsPx = () => ({
    x: desktopStore.noteUrlOverlayInfoMaybe.get()!.topLeftPx.x,
    y: desktopStore.noteUrlOverlayInfoMaybe.get()!.topLeftPx.y,
    w: 500, h: 40
  });

  return (
    <div id="urlOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${urlBoxBoundsPx().x}px; top: ${urlBoxBoundsPx().y}px; width: ${urlBoxBoundsPx().w}px; height: ${urlBoxBoundsPx().h}px`}>
        <div class="p-[4px]">
          <span class="text-sm ml-1 mr-2">Link URL:</span>
          <input ref={urlTextElement}
                 class="border border-slate-300 rounded w-[305px] pl-1"
                 autocomplete="on"
                 value={noteItem().url}
                 type="text"
                 onChange={handleUrlChange} />
        </div>
      </div>
    </div>
  );
}
