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
import { asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { CursorEventState } from "../../input/state";
import { isInside } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { arrange } from "../../layout/arrange";
import { server } from "../../server";


export const Toolbar_Page_Width: Component = () => {
  const desktopStore = useDesktopStore();

  let widthTextElement: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(itemState.get(desktopStore.getToolbarFocus()!.itemId)!);

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), entryBoxBoundsPx())) { return; }
    desktopStore.pageWidthOverlayInfoMaybe.set(null);
    arrange(desktopStore);
    server.updateItem(pageItem());
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const handleWidthChange = () => {
    pageItem().innerSpatialWidthGr = Math.round(parseFloat(widthTextElement!.value)) * GRID_SIZE;
    arrange(desktopStore);
  };

  const entryBoxBoundsPx = () => ({
    x: desktopStore.pageWidthOverlayInfoMaybe.get()!.topLeftPx.x,
    y: desktopStore.pageWidthOverlayInfoMaybe.get()!.topLeftPx.y,
    w: 300, h: 30
  });

  return (
    <div id="formatOverlay"
         class="fixed left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${entryBoxBoundsPx().x}px; top: ${entryBoxBoundsPx().y}px; width: ${entryBoxBoundsPx().w}px; height: ${entryBoxBoundsPx().h}px`}>
        <span class="text-sm ml-1 mr-2">Inner Block Width:</span>
        <input ref={widthTextElement}
               class="border border-slate-300 rounded w-[100px] pl-1"
               autocomplete="on"
               value={pageItem().innerSpatialWidthGr / GRID_SIZE}
               type="text"
               onChange={handleWidthChange} />
      </div>
    </div>
  );
}
