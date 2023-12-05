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
import { childrenLoadInitiatedOrComplete } from "../layout/load";
import { itemState } from "../store/ItemState";
import { switchToPage } from "../layout/navigation";
import { panic } from "../util/lang";
import { PageFns } from "../items/page-item";
import { VesCache } from "../layout/ves-cache";
import { Toolbar } from "./toolbar/Toolbar";
import { SearchOverlay } from "./overlay/SearchOverlay";
import { Toolbar_Overlay } from "./toolbar/Toolbar_Overlay";


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
        console.error(`fetchItems failed ${id}`, e);
        throw e;
      }

      const pageObject = result.item as any;
      const pageId = pageObject.id;
      try {
        itemState.setItemFromServerObject(pageObject, null);
      } catch (e: any) {
        console.error(`setItemFromServerObject failed ${id}`, e);
        throw e;
      }

      try {
        if (result.attachments[pageId]) {
          itemState.setAttachmentItemsFromServerObjects(pageId, result.attachments[pageId], null);
        }
      } catch (e: any) {
        console.error(`setAttachmentItemsFromServerObjects (1) failed ${id}`, e);
        throw e;
      }

      childrenLoadInitiatedOrComplete[pageId] = true;

      try {
        itemState.setChildItemsFromServerObjects(pageId, result.children, null);
      } catch (e: any) {
        console.error(`setChildItemsFromServerObjects failed ${id}`, e);
        throw e;
      }

      try {
        PageFns.setDefaultListPageSelectedItemMaybe(store, { itemId: pageId, linkIdMaybe: null });
      } catch (e: any) {
        console.error(`setDefaultListPageSelectedItemMaybe failed ${pageId}`, e);
      }

      Object.keys(result.attachments).forEach(id => {
        try {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], null);
        } catch (e: any) {
          console.error(`setAttachmentItemsFromServerObjects (2) failed ${id}`, e);
          throw e;
        }
      });

      try {
        switchToPage(store, { itemId: pageId, linkIdMaybe: null }, false, false);
      } catch (e: any) {
        console.error(`switchToPage ${pageId} failed`, e);
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
  });

  onCleanup(() => {
    mainDiv!.removeEventListener('contextmenu', contextMenuListener);
  });

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
    for (let key in childrenLoadInitiatedOrComplete) {
      if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
        delete childrenLoadInitiatedOrComplete[key];
      }
    }
  };

  return (
    <div ref={mainDiv} class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Show when={store.topLevelVisualElement.get().displayItem.itemType != ItemType.None}>
        <Desktop visualElement={store.topLevelVisualElement.get()} />
      </Show>
      <Toolbar />

      {/* global overlays */}
      <Show when={store.overlay.toolbarOverlayInfoMaybe.get() != null}>
        <Toolbar_Overlay />
      </Show>
      <Show when={store.overlay.searchOverlayVisible.get()}>
        <SearchOverlay />
      </Show>

    </div>
  );
}
