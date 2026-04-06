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

import { Component, onCleanup, onMount, Show } from "solid-js";
import {
  clearLocalContainerSyncVersions,
  GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS,
  ItemsAndTheirAttachments,
  remote,
  server,
  startContainerSyncLoop,
  stopContainerSyncLoop,
} from "../server";
import { useStore } from "../store/StoreProvider";
import { Desktop } from "./Desktop";
import { ItemType } from "../items/base/item";
import { clearLoadState, markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { itemState } from "../store/ItemState";
import { switchToNonPage, switchToPage } from "../layout/navigation";
import { panic } from "../util/lang";
import { VesCache } from "../layout/ves-cache";
import { Toolbar } from "./toolbar/Toolbar";
import { SearchOverlay } from "./overlay/SearchOverlay";
import { FindOverlay } from "./overlay/FindOverlay";
import { UploadOverlay } from "./overlay/UploadOverlay";
import { EmptyTrashOverlay } from "./overlay/EmptyTrashOverlay";
import { Toolbar_Popup } from "./toolbar/Toolbar_Popup";
import { mouseUpHandler } from "../input/mouse_up";
import { mouseMoveHandler, clearMouseOverState } from "../input/mouse_move";
import { CursorEventState } from "../input/state";
import { MOUSE_RIGHT, mouseDownHandler } from "../input/mouse_down";
import { cancelShiftNavigationGesture, keyDownHandler, keyUpHandler } from "../input/key";
import { requestArrange } from "../layout/arrange";
import { MouseEventActionFlags } from "../input/enums";
import { pasteHandler } from "../input/paste";
import { textEditSelectionChangeListener } from "../input/edit";
import { Toolbar_TransientMessage } from "./toolbar/Toolbar_TransientMessage";
import { Toolbar_NetworkStatus_Overlay } from "./toolbar/Toolbar_NetworkStatus";
import { asPageItem, isPage } from "../items/page-item";
import { isContainer } from "../items/base/container-item";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { SOLO_ITEM_HOLDER_PAGE_UID } from "../util/uid";
import { RemoteLoginOverlay } from "./overlay/RemoteLogin";


export let logout: (() => Promise<void>) | null = null;

export const Main: Component = () => {
  const store = useStore();

  let mainDiv: HTMLDivElement | undefined;

  onMount(async () => {
    if (!store.general.installationState()!.hasRootUser) {
      switchToNonPage(store, '/setup');
    }

    let id;
    let origin: string | null = null;
    let parts = store.currentUrlPath.get().split("/");
    if (parts.length == 1) {
      id = "root";
    } else if (parts.length == 2) {
      id = parts[1];
    } else if (parts.length == 3) {
      if (parts[1] == "remote") {
        panic("Main.onMount: remote URL missing item ID.");
      } else {
        id = `${parts[1]}/${parts[2]}`;
      }
    } else if (parts.length >= 4 && parts[1] == "remote") {
      origin = decodeURIComponent(parts[2]);
      id = parts[3];
    } else if (parts.length == 4) {
      panic("Main.onMount: unexpected params.");
    } else {
      panic("Main.onMount: unexpected params.");
    }
    // console.debug(`Main onMount id: '${id}', origin: '${origin}'`);

    try {
      let result: ItemsAndTheirAttachments
      try {
        if (origin != null) {
          result = await remote.fetchItems(origin, id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS, store.general.networkStatus);
        } else {
          result = await server.fetchItems(id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS, store.general.networkStatus);
        }
      } catch (e: any) {
        console.error(`Main.onMount fetchItems failed ${id}`, e);
        if (window.location.pathname == "/") {
          location.href = window.location.protocol + "//" + window.location.host + "/login";
        } else {
          location.href = window.location.protocol + "//" + window.location.host + "/login" + "?redirect=" + encodeURIComponent(window.location.pathname);
        }
        return;
      }

      const itemObject = result.item as any;
      const itemId = itemObject.id;

      if (itemObject.itemType != ItemType.Page) {
        itemState.addSoloItemHolderPage(itemObject.ownerId!);
      }

      try {
        itemState.setItemFromServerObject(itemObject, origin);
      } catch (e: any) {
        console.error(`Main.onMount setItemFromServerObject failed ${id}`, e);
        throw e;
      }

      if (itemObject.itemType != ItemType.Page) {
        asPageItem(itemState.get(SOLO_ITEM_HOLDER_PAGE_UID)!).computed_children = [itemId];
      }

      if (isAttachmentsItem(itemState.get(itemId)!)) {
        try {
          itemState.applyAttachmentItemsSnapshotFromServerObjects(itemId, result.attachments[itemId] ?? [], origin);
        } catch (e: any) {
          console.error(`Main.onMount applyAttachmentItemsSnapshotFromServerObjects (1) failed ${id}`, e);
          throw e;
        }
      }

      const item = itemState.get(itemId)!;
      if (isContainer(item)) {
        markChildrenLoadAsInitiatedOrComplete(itemId);
        try {
          itemState.applyContainerSnapshotFromServerObjects(itemId, result.children, result.attachments, origin);
        } catch (e: any) {
          console.error(`Main.onMount applyContainerSnapshotFromServerObjects failed ${id}`, e);
          throw e;
        }
      }

      try {
        switchToPage(store, isPage(item) ? { itemId, linkIdMaybe: null } : { itemId: SOLO_ITEM_HOLDER_PAGE_UID, linkIdMaybe: null }, false, false, false);
      } catch (e: any) {
        console.error(`Main.onMount switchToPage ${itemId} failed`, e);
        throw e;
      }

    } catch (e: any) {
      console.error(`An error occurred loading root page, clearing user session: ${e.message}.`, e);
      store.general.clearInstallationState();
      await store.general.retrieveInstallationState();
      switchToNonPage(store, '/login');
    }

    startContainerSyncLoop(store);

    mainDiv!.addEventListener('contextmenu', contextMenuListener);
    document.addEventListener('keydown', keyDownListener);
    document.addEventListener('keyup', keyUpListener);
    window.addEventListener('resize', windowResizeListener);
    document.addEventListener('selectionchange', selectionChangeListener);
  });

  onCleanup(() => {
    stopContainerSyncLoop();

    mainDiv!.removeEventListener('contextmenu', contextMenuListener);
    document.removeEventListener('keydown', keyDownListener);
    document.removeEventListener('keyup', keyUpListener);
    window.removeEventListener('resize', windowResizeListener);
    document.removeEventListener('selectionchange', selectionChangeListener)
  });

  const selectionChangeListener = () => {
    textEditSelectionChangeListener();
  }

  const shouldDebugCompositeArrows = (): boolean => {
    try {
      return window.localStorage.getItem("debug:composite-arrows") == "1";
    } catch (_e) {
      return false;
    }
  };

  const keyDownListener = (ev: KeyboardEvent) => {
    if (shouldDebugCompositeArrows() &&
      (ev.code == "ArrowUp" || ev.code == "ArrowDown") &&
      store.overlay.textEditInfo()) {
      console.log("[composite-arrow-main] keydown", {
        code: ev.code,
        activeElementId: (document.activeElement as HTMLElement | null)?.id ?? null,
        targetId: (ev.target as HTMLElement | null)?.id ?? null,
        itemPath: store.overlay.textEditInfo()!.itemPath,
      });
    }
    keyDownHandler(store, ev);
  };

  const keyUpListener = (ev: KeyboardEvent) => {
    if (shouldDebugCompositeArrows() &&
      (ev.code == "ArrowUp" || ev.code == "ArrowDown") &&
      store.overlay.textEditInfo()) {
      console.log("[composite-arrow-main] keyup", {
        code: ev.code,
        activeElementId: (document.activeElement as HTMLElement | null)?.id ?? null,
        targetId: (ev.target as HTMLElement | null)?.id ?? null,
        itemPath: store.overlay.textEditInfo()!.itemPath,
      });
    }
    void keyUpHandler(store, ev);
  };

  const windowResizeListener = () => {
    store.resetDesktopSizePx();
    requestArrange(store, "window-resize");
  };

  const contextMenuListener = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };

  logout = async () => {
    store.clear();
    itemState.clear();
    VesCache.clear();
    clearLoadState();
    clearLocalContainerSyncVersions();
    await store.user.logout();
    switchToNonPage(store, '/login');
  };

  const mouseDoubleClickListener = (ev: MouseEvent) => {
    // More trouble than value.
  };

  let ignoreMouseDown = false;
  const mouseDownListener = async (ev: MouseEvent) => {
    cancelShiftNavigationGesture();
    if (ignoreMouseDown) {
      ignoreMouseDown = false;
      return;
    }
    let flags = await mouseDownHandler(store, ev.button);
    if (flags & MouseEventActionFlags.PreventDefault) {
      ev.preventDefault();
    }
  };

  const touchListener = async (ev: TouchEvent) => {
    cancelShiftNavigationGesture();
    if (ev.touches.length > 1) {
      ignoreMouseDown = true;
      CursorEventState.setFromTouchEvent(ev);
      ev.preventDefault();
      await mouseDownHandler(store, MOUSE_RIGHT);
    }
  }

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    mouseMoveHandler(store);
  };

  const mouseLeaveListener = () => {
    clearMouseOverState(store);
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
      class="absolute top-0 left-0 right-0 bottom-0 select-none touch-pan-x touch-pan-y overflow-hidden"
      ontouchstart={touchListener}
      onmousedown={mouseDownListener}
      onmousemove={mouseMoveListener}
      onmouseleave={mouseLeaveListener}
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
      <Show when={store.overlay.toolbarTransientMessage.get() != null}>
        <Toolbar_TransientMessage />
      </Show>
      <Show when={store.overlay.searchOverlayVisible.get()}>
        <SearchOverlay />
      </Show>
      <Show when={store.overlay.findOverlayVisible.get()}>
        <FindOverlay />
      </Show>
      <Show when={store.overlay.networkOverlayVisible.get()}>
        <Toolbar_NetworkStatus_Overlay />
      </Show>
      <Show when={store.overlay.uploadOverlayInfo.get() != null}>
        <UploadOverlay />
      </Show>
      <Show when={store.overlay.remoteLoginInfo.get() != null}>
        <RemoteLoginOverlay />
      </Show>
      <EmptyTrashOverlay />

    </div>
  );
}
