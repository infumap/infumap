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
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { asPageItem } from "../../items/page-item";
import { VeFns } from "../../layout/visual-element";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { rearrange } from "../../layout/arrange";
import { serverOrRemote } from "../../server";
import { MOUSE_RIGHT } from "../../input/mouse_down";


const pageVisualElement = (store: StoreContextModel) => VesCache.get(store.overlay.pageEditOverlayInfo()!.itemPath)!.get();
const pageItem = (store: StoreContextModel) => asPageItem(pageVisualElement(store).displayItem);

export const PageEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLTextAreaElement | undefined;

  const pageItemOnInitialize = pageItem(store);

  const pageVeBoundsPx = () => {
    const r = VeFns.veBoundsRelativeToDestkopPx(store, pageVisualElement(store));
    r.y += store.topToolbarHeight();
    return r;
  }

  onMount(() => {
    textElement!.focus();
  });

  const textAreaMouseDownHandler = async (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.user.getUserMaybe() != null && pageItemOnInitialize.ownerId == store.user.getUser().userId) {
        serverOrRemote.updateItem(pageItem(store));
        store.overlay.setPageEditOverlayInfo(store.history, null);
      }
    }
  };

  const textAreaOnInputHandler = (ev: InputEvent) => {
    pageItem(store).title = textElement!.value;
    rearrange(store, pageItem(store).id);
    ev.preventDefault();
  };

  return (
    <div class={`absolute rounded border`}
         style={`left: ${pageVeBoundsPx().x}px; top: ${pageVeBoundsPx().y}px; width: ${pageVeBoundsPx().w}px; height: ${pageVeBoundsPx().h}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY}`}>
      <textarea ref={textElement}
                class={`rounded overflow-hidden resize-none whitespace-pre-wrap`}
                style={`position: absolute; ` +
                       `overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;`}
                value={pageItem(store).title}
                disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != pageItem(store).ownerId}
                onMouseDown={textAreaMouseDownHandler}
                onInput={textAreaOnInputHandler} />
    </div>
  );
}


export const pageEditOverlay_keyDownListener = (store: StoreContextModel, ev: KeyboardEvent): void => {
  if (ev.code == "Enter") {
    keyDown_Enter(store, ev);
    return;
  }
};


const keyDown_Enter = async (store: StoreContextModel, ev: KeyboardEvent): Promise<void> => {
  if (store.user.getUserMaybe() == null || pageItem(store).ownerId != store.user.getUser().userId) { return; }
  ev.preventDefault();
  serverOrRemote.updateItem(pageItem(store));
  store.overlay.setPageEditOverlayInfo(store.history, null);
}
