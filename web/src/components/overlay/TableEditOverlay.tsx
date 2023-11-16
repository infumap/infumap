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

import { Component, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { CursorEventState } from "../../input/state";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { asTableItem } from "../../items/table-item";
import { isInside } from "../../util/geometry";
import { server } from "../../server";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { arrange } from "../../layout/arrange";


export const TableEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const tableVisualElement = () => VesCache.get(store.tableEditOverlayInfo.get()!.itemPath)!.get();
  const tableVeBoundsPx = () => VeFns.veBoundsRelativeToDestkopPx(store, tableVisualElement());
  const tableItem = () => asTableItem(tableVisualElement().displayItem);
  const tableItemOnInitialize = tableItem();
  const editBoxBoundsPx = () => {
    const blockSizePx = tableVisualElement().blockSizePx!;
    const result = tableVeBoundsPx();
    result.h = blockSizePx.h;
    const overlayInfo = store.tableEditOverlayInfo.get()!;
    if (overlayInfo.colNum == null) {
      return result;
    }
    result.x += overlayInfo.startBl! * blockSizePx.w;
    result.w = (overlayInfo.endBl! - overlayInfo.startBl!) * blockSizePx.w;
    result.y += tableVisualElement().blockSizePx!.h;
    return result;
  };

  onMount(() => {
    textElement!.focus();
  });

  const mouseDownListener = async (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    const desktopPx = CursorEventState.getLatestDesktopPx();
    if (isInside(desktopPx, editBoxBoundsPx())) { return; }
    if (store.userStore.getUserMaybe() != null && tableItem().ownerId == store.userStore.getUser().userId) {
      server.updateItem(tableItem());
    }
    store.tableEditOverlayInfo.set(null);
    arrange(store);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const keyDownListener = (ev: KeyboardEvent): void => {
  }

  const inputMouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.userStore.getUserMaybe() != null && tableItemOnInitialize.ownerId == store.userStore.getUser().userId) {
        server.updateItem(tableItem());
        store.noteEditOverlayInfo.set(null);
      }
    }
  }

  const editingValue = () => {
    const overlayInfo = store.tableEditOverlayInfo.get()!;
    if (overlayInfo.colNum == null) { return tableItem().title }
    return tableItem().tableColumns[overlayInfo.colNum!].name;
  }

  const inputOnInputHandler = () => {
    const overlayInfo = store.tableEditOverlayInfo.get()!;
    if (overlayInfo.colNum == null) {
      tableItem().title = textElement!.value;
    } else {
      return tableItem().tableColumns[overlayInfo.colNum!].name = textElement!.value;
    }
  }

  return (
    <div id="pageSettingsOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <input ref={textElement}
          class={`rounded overflow-hidden resize-none whitespace-pre-wrap`}
          style={`position: absolute; ` +
                 `left: ${editBoxBoundsPx().x}px; ` +
                 `top: ${editBoxBoundsPx().y}px; ` +
                 `width: ${editBoxBoundsPx().w}px; ` +
                 `height: ${editBoxBoundsPx().h}px;`}
          value={editingValue()}
          disabled={store.userStore.getUserMaybe() == null || store.userStore.getUser().userId != tableItem().ownerId}
          onMouseDown={inputMouseDownHandler}
          onInput={inputOnInputHandler} />
    </div>
  );
}