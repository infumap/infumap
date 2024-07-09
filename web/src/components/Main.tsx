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

import { useNavigate, useParams } from "@solidjs/router";
import { Component, onCleanup, onMount, Show } from "solid-js";
import { GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS, ItemsAndTheirAttachments, server } from "../server";
import { useStore } from "../store/StoreProvider";
import { Desktop } from "./Desktop";
import { ItemType } from "../items/base/item";
import { clearLoadState, markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { itemState } from "../store/ItemState";
import { switchToPage } from "../layout/navigation";
import { panic } from "../util/lang";
import { VesCache } from "../layout/ves-cache";
import { Toolbar } from "./toolbar/Toolbar";
import { SearchOverlay } from "./overlay/SearchOverlay";
import { Toolbar_Popup } from "./toolbar/Toolbar_Popup";
import { mouseUpHandler } from "../input/mouse_up";
import { mouseMoveHandler } from "../input/mouse_move";
import { CursorEventState } from "../input/state";
import { MOUSE_RIGHT, mouseDownHandler } from "../input/mouse_down";
import { keyDownHandler } from "../input/key";
import { fArrange } from "../layout/arrange";
import { MouseEventActionFlags } from "../input/enums";
import { pasteHandler } from "../input/paste";
import { composite_selectionChangeListener } from "../input/edit";


export let logout: (() => Promise<void>) | null = null;

export const Main: Component = () => {
  const params = useParams();
  const store = useStore();
  const navigate = useNavigate();

  let mainDiv: HTMLDivElement | undefined;

  onMount(async () => {
    if (!store.general.installationState()!.hasRootUser) {
      navigate('/setup');
    }

    let id;
    if (!params.usernameOrItemId && !params.username && !params.itemLabel) { id = "root"; }
    else if (params.usernameOrItemId) { id = params.usernameOrItemId; }
    else if (params.username && params.itemLabel) { id = `${params.username}/${params.itemLabel}`; }
    else { panic("Main.onMount: unexpected params."); }

    try {
      let result: ItemsAndTheirAttachments
      try {
        result = await server.fetchItems(id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS);
      } catch (e: any) {
        console.error(`Main.onMount fetchItems failed ${id}`, e);
        // TODO (HIGH): something better.
        return;
      }

      const pageObject = result.item as any;
      const pageId = pageObject.id;
      try {
        itemState.setItemFromServerObject(pageObject, null);
      } catch (e: any) {
        console.error(`Main.onMount setItemFromServerObject failed ${id}`, e);
        throw e;
      }

      try {
        if (result.attachments[pageId]) {
          itemState.setAttachmentItemsFromServerObjects(pageId, result.attachments[pageId], null);
        }
      } catch (e: any) {
        console.error(`Main.onMount setAttachmentItemsFromServerObjects (1) failed ${id}`, e);
        throw e;
      }

      markChildrenLoadAsInitiatedOrComplete(pageId);

      try {
        itemState.setChildItemsFromServerObjects(pageId, result.children, null);
      } catch (e: any) {
        console.error(`Main.onMount setChildItemsFromServerObjects failed ${id}`, e);
        throw e;
      }

      Object.keys(result.attachments).forEach(id => {
        try {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], null);
        } catch (e: any) {
          console.error(`Main.onMount setAttachmentItemsFromServerObjects (2) failed ${id}`, e);
          throw e;
        }
      });

      try {
        switchToPage(store, { itemId: pageId, linkIdMaybe: null }, false, false, false);
      } catch (e: any) {
        console.error(`Main.onMount switchToPage ${pageId} failed`, e);
        throw e;
      }
    } catch (e: any) {
      console.error(`An error occurred loading root page, clearing user session: ${e.message}.`, e);
      store.user.clear();
      store.general.clearInstallationState();
      await store.general.retrieveInstallationState();
      if (logout) {
        await logout();
      }
      navigate('/login');
    }

    mainDiv!.addEventListener('contextmenu', contextMenuListener);
    document.addEventListener('keydown', keyDownListener);
    window.addEventListener('resize', windowResizeListener);
    window.addEventListener('popstate', windowPopStateListener);
    document.addEventListener('selectionchange', selectionChangeListener);
  });

  onCleanup(() => {
    mainDiv!.removeEventListener('contextmenu', contextMenuListener);
    document.removeEventListener('keydown', keyDownListener);
    window.removeEventListener('resize', windowResizeListener);
    window.removeEventListener('popstate', windowPopStateListener);
    document.removeEventListener('selectionchange', selectionChangeListener)
  });

  const selectionChangeListener = () => {
    composite_selectionChangeListener();
  }

  const keyDownListener = (ev: KeyboardEvent) => {
    keyDownHandler(store, ev);
  };

  const windowResizeListener = () => {
    store.resetDesktopSizePx();
    fArrange(store);
  };

  const windowPopStateListener = () => {
    store.overlay.contextMenuInfo.set(null);
    store.overlay.tableColumnContextMenuInfo.set(null);
    store.overlay.editUserSettingsInfo.set(null);
    store.history.popPage();
    fArrange(store);
  };

  const contextMenuListener = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };

  logout = async () => {
    store.clear();
    itemState.clear();
    VesCache.clear();
    await store.user.logout();
    navigate('/login');
    clearLoadState();
  };

  const mouseDoubleClickListener = (ev: MouseEvent) => {
    // More trouble than value.
  };

  const mouseDownListener = async (ev: MouseEvent) => {
    let flags = await mouseDownHandler(store, ev.button);
    if (flags & MouseEventActionFlags.PreventDefault) {
      ev.preventDefault();
    }
  };

  const touchListener = async (ev: TouchEvent) => {
    if (ev.touches.length > 1) {
      CursorEventState.setFromTouchEvent(ev);
      ev.preventDefault();
      await mouseDownHandler(store, MOUSE_RIGHT);
    }
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    mouseMoveHandler(store);
  };

  const mouseUpListener = (ev: MouseEvent) => {
    let flags = mouseUpHandler(store);
    if (flags & MouseEventActionFlags.PreventDefault) {
      ev.preventDefault();
    }
  };

  const pasteListener = (ev: ClipboardEvent) => {
    pasteHandler(store, ev);
  };

  return (
    <div ref={mainDiv}
         class="absolute top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden"
         ontouchstart={touchListener}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onpaste={pasteListener}
         ondblclick={mouseDoubleClickListener}
         onmouseup={mouseUpListener}>

      <Show when={store.umbrellaVisualElement.get().displayItem.itemType != ItemType.Empty}>
        <Desktop visualElement={store.umbrellaVisualElement.get()} />
      </Show>

      <Toolbar />

      {/* global overlays */}
      <Show when={store.overlay.toolbarPopupInfoMaybe.get() != null}>
        <Toolbar_Popup />
      </Show>
      <Show when={store.overlay.searchOverlayVisible.get()}>
        <SearchOverlay />
      </Show>

    </div>
  );
}
