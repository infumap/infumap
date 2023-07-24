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
import { GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS, ItemsAndTheirAttachments, server } from "../server";
import { switchToPage } from "../layout/arrange";
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { useGeneralStore } from "../store/GeneralStoreProvider";
import { useUserStore } from "../store/UserStoreProvider";
import { Desktop } from "./Desktop";
import { Toolbar } from "./Toolbar";
import { EMPTY_UID } from "../util/uid";
import { ITEM_TYPE_NONE } from "../items/base/item";
import { childrenLoadInitiatedOrComplete } from "../layout/load";
import { itemStore } from "../store/ItemStore";


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
    let user = userStore.getUserMaybe();
    if (user == null) {
      navigate('/login');
    }

    try {
      let result: ItemsAndTheirAttachments;
      let rootId: string;
      if (!params.id) {
        result = await server.fetchItems(null, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY);
        const rootPageObject = result.items.find((a: any) => a['parentId'] == EMPTY_UID) as any;
        rootId = rootPageObject.id;
        childrenLoadInitiatedOrComplete[rootId] = true;
      } else {
        result = await server.fetchItems(params.id, GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS);
        const rootPageObject = result.item as any;
        rootId = rootPageObject.id;
        itemStore.setItemFromServerObject(rootPageObject);
        if (result.attachments[rootId]) {
          itemStore.setAttachmentItemsFromServerObjects(rootId, result.attachments[rootId]);
        }
        childrenLoadInitiatedOrComplete[rootId] = true;
      }
      itemStore.setChildItemsFromServerObjects(rootId, result.items);
      Object.keys(result.attachments).forEach(id => {
        itemStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
      });
      switchToPage(desktopStore, rootId);
    } catch (e: any) {
      console.log(`An error occurred loading root page, clearing user session: ${e.message}.`, e);
      userStore.clear();
      generalStore.clearInstallationState();
      await generalStore.retrieveInstallationState();
    }
  });

  logout = async () => {
    await userStore.logout();
    desktopStore.setEditDialogInfo(null);
    desktopStore.setContextMenuInfo(null);
    desktopStore.clearBreadcrumbs();
    navigate('/login');
    for (let key in childrenLoadInitiatedOrComplete) {
      if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
        delete childrenLoadInitiatedOrComplete[key];
      }
    }
  };

  return (
    <div class="fixed top-0 left-0 right-0 bottom-0 select-none touch-none overflow-hidden">
      <Show when={desktopStore.topLevelVisualElement().item.itemType != ITEM_TYPE_NONE}>
        <Desktop visualElement={desktopStore.topLevelVisualElement()} />
      </Show>
      <Toolbar />
    </div>
  );
}
