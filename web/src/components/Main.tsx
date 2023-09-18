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
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { useUserStore } from "../store/UserStoreProvider";
import { Desktop } from "./Desktop";
import { ITEM_TYPE_NONE } from "../items/base/item";
import { childrenLoadInitiatedOrComplete } from "../layout/load";
import { itemState } from "../store/ItemState";
import { switchToPage } from "../layout/navigation";
import { panic } from "../util/lang";
import { Toolbar } from "./toolbar/Toolbar";


export let logout: (() => Promise<void>) | null = null;

export const Main: Component = () => {
  const params = useParams();
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();
  const navigate = useNavigate();

  onMount(async () => {
    if (!generalStore.installationState()!.hasRootUser) {
      navigate('/setup');
    }

    let id;
    if (!params.usernameOrItemId && !params.username && !params.itemLabel) { id = "root"; }
    else if (params.usernameOrItemId) { id = params.usernameOrItemId; }
    else if (params.username && params.itemLabel) { id = `${params.username}/${params.itemLabel}`; }
    else { panic(); }

    try {
      const result: ItemsAndTheirAttachments =
        await server.fetchItems(id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS);
      const pageObject = result.item as any;
      const pageId = pageObject.id;
      itemState.setItemFromServerObject(pageObject);
      if (result.attachments[pageId]) {
        itemState.setAttachmentItemsFromServerObjects(pageId, result.attachments[pageId]);
      }
      childrenLoadInitiatedOrComplete[pageId] = true;

      itemState.setChildItemsFromServerObjects(pageId, result.children);
      Object.keys(result.attachments).forEach(id => {
        itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
      });

      switchToPage(desktopStore, userStore, { itemId: pageId, linkIdMaybe: null }, false);
    } catch (e: any) {
      console.log(`An error occurred loading root page, clearing user session: ${e.message}.`, e);
      userStore.clear();
      generalStore.clearInstallationState();
      await generalStore.retrieveInstallationState();
      if (logout) {
        await logout();
      }
      navigate('/login');
    }
  });

  logout = async () => {
    desktopStore.setEditDialogInfo(null);
    desktopStore.setContextMenuInfo(null);
    desktopStore.clearBreadcrumbs();
    await userStore.logout();
    navigate('/login');
    for (let key in childrenLoadInitiatedOrComplete) {
      if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
        delete childrenLoadInitiatedOrComplete[key];
      }
    }
  };

  return (
    <div class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Show when={desktopStore.topLevelVisualElement().displayItem.itemType != ITEM_TYPE_NONE}>
        <Desktop visualElement={desktopStore.topLevelVisualElement()} />
      </Show>
      <Toolbar />
    </div>
  );
}
