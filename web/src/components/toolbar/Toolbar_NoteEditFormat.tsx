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
import { Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { CursorEventState } from "../../input/state";
import { asNoteItem } from "../../items/note-item";
import { itemState } from "../../store/ItemState";
import { VeFns } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { isInside } from "../../util/geometry";


export const Toolbar_NoteEditFormat: Component = () => {
  const desktopStore = useDesktopStore();

  let formatTextElement: HTMLInputElement | undefined;

  const noteItem = () => asNoteItem(itemState.get(VeFns.veidFromPath(desktopStore.textEditOverlayInfo.get()!.itemPath).itemId)!);

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), formatBoxBoundsPx())) { return; }
    desktopStore.noteFormatOverlayInfoMaybe.set(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const handleFormatChange = () => {
    noteItem().format = formatTextElement!.value;
    arrange(desktopStore);
  };

  const formatBoxBoundsPx = () => ({
    x: desktopStore.noteFormatOverlayInfoMaybe.get()!.topLeftPx.x,
    y: desktopStore.noteFormatOverlayInfoMaybe.get()!.topLeftPx.y,
    w: 500, h: 40
  });

  return (
    <div id="formatOverlay"
         class="fixed left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${formatBoxBoundsPx().x}px; top: ${formatBoxBoundsPx().y}px; width: ${formatBoxBoundsPx().w}px; height: ${formatBoxBoundsPx().h}px`}>
        <div class="p-[4px]">
          <span class="text-sm ml-1 mr-2">Format:</span>
          <input ref={formatTextElement}
                 class="border border-slate-300 rounded w-[305px] pl-1"
                 autocomplete="on"
                 value={noteItem().format}
                 type="text"
                 onChange={handleFormatChange} />
        </div>
      </div>
    </div>
  );
}
