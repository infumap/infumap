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
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { asTableItem } from "../../items/table-item";
import { serverOrRemote } from "../../server";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { arrange } from "../../layout/arrange";


export const TableEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const tableVisualElement = () => VesCache.get(store.overlay.tableEditOverlayInfo()!.itemPath)!.get();
  const tableVeBoundsPx = () => VeFns.veBoundsRelativeToDestkopPx(store, tableVisualElement());
  const tableItem = () => asTableItem(tableVisualElement().displayItem);
  const tableItemOnInitialize = tableItem();
  const editBoxBoundsPx = () => {
    const blockSizePx = tableVisualElement().blockSizePx!;
    const result = tableVeBoundsPx();
    result.h = blockSizePx.h;
    result.y += store.topToolbarHeight();
    const overlayInfo = store.overlay.tableEditOverlayInfo()!;
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

  const inputMouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.user.getUserMaybe() != null && tableItemOnInitialize.ownerId == store.user.getUser().userId) {
        serverOrRemote.updateItem(tableItem());
        store.overlay.setTableEditOverlayInfo(store.history, null);
      }
    }
  }

  const editingValue = () => {
    const overlayInfo = store.overlay.tableEditOverlayInfo()!;
    if (overlayInfo.colNum == null) { return tableItem().title }
    return tableItem().tableColumns[overlayInfo.colNum!].name;
  }

  const inputOnInputHandler = () => {
    const overlayInfo = store.overlay.tableEditOverlayInfo()!;
    if (overlayInfo.colNum == null) {
      tableItem().title = textElement!.value;
    } else {
      tableItem().tableColumns[overlayInfo.colNum!].name = textElement!.value;
    }
    arrange(store);
  }

  return (
    <input ref={textElement}
           class={`absolute rounded overflow-hidden resize-none whitespace-pre-wrap`}
           style={`position: absolute; ` +
                  `left: ${editBoxBoundsPx().x}px; ` +
                  `top: ${editBoxBoundsPx().y}px; ` +
                  `width: ${editBoxBoundsPx().w}px; ` +
                  `height: ${editBoxBoundsPx().h}px;` +
                  `z-index: ${Z_INDEX_TEXT_OVERLAY}; `}
           value={editingValue()}
           disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != tableItem().ownerId}
           onMouseDown={inputMouseDownHandler}
           onInput={inputOnInputHandler} />
  );
}
