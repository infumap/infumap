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
import { Component, onMount, Show } from "solid-js";
import { GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS, ItemsAndTheirAttachments, server } from "../server";
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { Desktop } from "./Desktop";
import { ItemType } from "../items/base/item";
import { childrenLoadInitiatedOrComplete } from "../layout/load";
import { itemState } from "../store/ItemState";
import { switchToPage } from "../layout/navigation";
import { panic } from "../util/lang";
import { PageFns } from "../items/page-item";
import { VesCache } from "../layout/ves-cache";
import { Toolbar } from "./toolbar/Toolbar";
import { Toolbar_Note_Url } from "./toolbar/Toolbar_Note_Url";
import { Toolbar_Note_Format } from "./toolbar/Toolbar_Note_Format";
import { Toolbar_Page_Color } from "./toolbar/Toolbar_Page_Color";
import { Toolbar_Page_Aspect } from "./toolbar/Toolbar_Page_Aspect";
import { Toolbar_Page_Width } from "./toolbar/Toolbar_Page_Width";
import { Toolbar_Page_NumCols } from "./toolbar/Toolbar_Page_NumCols";


export let logout: (() => Promise<void>) | null = null;

export const Main: Component = () => {
  const params = useParams();
  const desktopStore = useDesktopStore();
  const navigate = useNavigate();

  onMount(async () => {
    if (!desktopStore.generalStore.installationState()!.hasRootUser) {
      navigate('/setup');
    }

    let id;
    if (!params.usernameOrItemId && !params.username && !params.itemLabel) { id = "root"; }
    else if (params.usernameOrItemId) { id = params.usernameOrItemId; }
    else if (params.username && params.itemLabel) { id = `${params.username}/${params.itemLabel}`; }
    else { panic("Main.onMount: unexpected params."); }

    try {
      const result: ItemsAndTheirAttachments =
        await server.fetchItems(id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS);
      const pageObject = result.item as any;
      const pageId = pageObject.id;
      itemState.setItemFromServerObject(pageObject, null);
      if (result.attachments[pageId]) {
        itemState.setAttachmentItemsFromServerObjects(pageId, result.attachments[pageId], null);
      }
      childrenLoadInitiatedOrComplete[pageId] = true;
      itemState.setChildItemsFromServerObjects(pageId, result.children, null);
      PageFns.setDefaultListPageSelectedItemMaybe(desktopStore, { itemId: pageId, linkIdMaybe: null });
      Object.keys(result.attachments).forEach(id => {
        itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], null);
      });

      switchToPage(desktopStore, { itemId: pageId, linkIdMaybe: null }, false, false);
    } catch (e: any) {
      console.log(`An error occurred loading root page, clearing user session: ${e.message}.`, e);
      desktopStore.userStore.clear();
      desktopStore.generalStore.clearInstallationState();
      await desktopStore.generalStore.retrieveInstallationState();
      if (logout) {
        await logout();
      }
      navigate('/login');
    }
  });

  logout = async () => {
    desktopStore.clear();
    itemState.clear();
    VesCache.clear();
    await desktopStore.userStore.logout();
    navigate('/login');
    for (let key in childrenLoadInitiatedOrComplete) {
      if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
        delete childrenLoadInitiatedOrComplete[key];
      }
    }
  };

  return (
    <div class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Show when={desktopStore.topLevelVisualElement.get().displayItem.itemType != ItemType.None}>
        <Desktop visualElement={desktopStore.topLevelVisualElement.get()} />
      </Show>
      <Toolbar />

      {/* global overlays */}
      <Show when={desktopStore.noteUrlOverlayInfoMaybe.get() != null}>
        <Toolbar_Note_Url />
      </Show>
      <Show when={desktopStore.noteFormatOverlayInfoMaybe.get() != null}>
        <Toolbar_Note_Format />
      </Show>
      <Show when={desktopStore.pageColorOverlayInfoMaybe.get() != null}>
        <Toolbar_Page_Color />
      </Show>
      <Show when={desktopStore.pageAspectOverlayInfoMaybe.get() != null}>
        <Toolbar_Page_Aspect />
      </Show>
      <Show when={desktopStore.pageWidthOverlayInfoMaybe.get() != null}>
        <Toolbar_Page_Width />
      </Show>
      <Show when={desktopStore.pageNumColsOverlayInfoMaybe.get() != null}>
        <Toolbar_Page_NumCols />
      </Show>

    </div>
  );
}
