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
import { VeFns } from "../../layout/visual-element";
import { CursorEventState } from "../../input/state";
import { isInside } from "../../util/geometry";
import { arrange } from "../../layout/arrange";
import { Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";


export const Toolbar_Page_Color: Component = () => {
  const desktopStore = useDesktopStore();

  // let formatTextElement: HTMLInputElement | undefined;

  // const pageItem = () => asPageItem(itemState.get(VeFns.veidFromPath(desktopStore.textEditOverlayInfo.get()!.itemPath).itemId)!);

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), colorBoxBoundsPx())) { return; }
    desktopStore.noteFormatOverlayInfoMaybe.set(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  // const handleFormatChange = () => {
  //   // pageItem().color = formatTextElement!.value;
  //   arrange(desktopStore);
  // };

  const colorBoxBoundsPx = () => ({
    x: desktopStore.noteFormatOverlayInfoMaybe.get()!.topLeftPx.x,
    y: desktopStore.noteFormatOverlayInfoMaybe.get()!.topLeftPx.y,
    w: 100, h: 100
  });

  return (
    <div id="formatOverlay"
         class="fixed left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${colorBoxBoundsPx().x}px; top: ${colorBoxBoundsPx().y}px; width: ${colorBoxBoundsPx().w}px; height: ${colorBoxBoundsPx().h}px`}>
        
      </div>
    </div>
  );
}
