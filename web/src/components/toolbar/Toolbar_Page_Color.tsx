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
import { Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { InfuColorButton } from "../library/InfuColorButton";
import { server } from "../../server";


export const Toolbar_Page_Color: Component = () => {
  const desktopStore = useDesktopStore();

  const pageItem = () => asPageItem(itemState.get(desktopStore.getToolbarFocus()!.itemId)!);

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), colorBoxBoundsPx())) { return; }
    desktopStore.pageColorOverlayInfoMaybe.set(null);
    server.updateItem(pageItem());
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const colorBoxBoundsPx = () => ({
    x: desktopStore.pageColorOverlayInfoMaybe.get()!.topLeftPx.x,
    y: desktopStore.pageColorOverlayInfoMaybe.get()!.topLeftPx.y,
    w: 96, h: 56
  });

  const handleClick = (col: number) => {
    pageItem().backgroundColorIndex = col;
    desktopStore.pageColorOverlayInfoMaybe.set(desktopStore.pageColorOverlayInfoMaybe.get());
  }

  return (
    <div id="formatOverlay"
         class="fixed left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${colorBoxBoundsPx().x}px; top: ${colorBoxBoundsPx().y}px; width: ${colorBoxBoundsPx().w}px; height: ${colorBoxBoundsPx().h}px`}>
        <div class="pt-[6px] pl-[4px]">
          <div class="inline-block pl-[2px]"><InfuColorButton col={0} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={1} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={2} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={3} onClick={handleClick} /></div>
        </div>
        <div class="pt-0 pl-[4px]">
          <div class="inline-block pl-[2px]"><InfuColorButton col={4} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={5} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={6} onClick={handleClick} /></div>
          <div class="inline-block pl-[2px]"><InfuColorButton col={7} onClick={handleClick} /></div>
        </div>
      </div>
    </div>
  );
}
