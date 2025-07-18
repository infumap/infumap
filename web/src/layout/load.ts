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

import { GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, remote, server } from "../server";
import { SOLO_ITEM_HOLDER_PAGE_UID, Uid } from "../util/uid";
import { StoreContextModel } from "../store/StoreProvider";
import { asContainerItem } from "../items/base/container-item";
import { asLinkItem } from "../items/link-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { itemState } from "../store/ItemState";
import { fullArrange } from "./arrange";
import { PageFns } from "../items/page-item";
import { Veid } from "./visual-element";
import { TabularFns } from "../items/base/tabular-item";


export function clearLoadState() {
  for (let key in childrenLoadInitiatedOrComplete) {
    if (childrenLoadInitiatedOrComplete.hasOwnProperty(key)) {
      delete childrenLoadInitiatedOrComplete[key];
    }
  }
  for (let key in itemLoadInitiatedOrComplete) {
    if (itemLoadInitiatedOrComplete.hasOwnProperty(key)) {
      delete itemLoadInitiatedOrComplete[key];
    }
  }
  for (let key in itemLoadFromRemoteInitiatedOrComplete) {
    if (itemLoadFromRemoteInitiatedOrComplete.hasOwnProperty(key)) {
      delete itemLoadFromRemoteInitiatedOrComplete[key];
    }
  }
}

export function markChildrenLoadAsInitiatedOrComplete(containerId: Uid) {
  childrenLoadInitiatedOrComplete[containerId] = true;
}


const childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsMaybe = (store: StoreContextModel, containerVeid: Veid) => {
  if (containerVeid.itemId == SOLO_ITEM_HOLDER_PAGE_UID) { return; }

  if (childrenLoadInitiatedOrComplete[containerVeid.itemId]) {
    PageFns.setDefaultListPageSelectedItemMaybe(store, containerVeid);
    return;
  }
  childrenLoadInitiatedOrComplete[containerVeid.itemId] = true;

  const container = itemState.get(containerVeid.itemId)!;
  const origin = container.origin;

  const fetchPromise = origin == null
    ? server.fetchItems(`${containerVeid.itemId}`, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, store.general.networkStatus)
    : remote.fetchItems(origin, `${containerVeid.itemId}`, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, store.general.networkStatus);

  fetchPromise
    .then(result => {
      if (!childrenLoadInitiatedOrComplete[containerVeid.itemId]) { return; };

      if (result != null) {
        try {
          itemState.setChildItemsFromServerObjects(containerVeid.itemId, result.children, origin);
        } catch (e: any) {
          throw new Error(`itemState.setChildItems failed: ${e}`);
        }
        PageFns.setDefaultListPageSelectedItemMaybe(store, containerVeid);
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], origin);
        });
        TabularFns.validateNumberOfVisibleColumnsMaybe(containerVeid.itemId);
        asContainerItem(itemState.get(containerVeid.itemId)!).childrenLoaded = true;
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange failed: ${e}`);
        };
      } else {
        console.error(`No items were fetched for '${containerVeid.itemId}'.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred fetching items for '${containerVeid.itemId}': ${e.message}.`);
    });
}


export enum InitiateLoadResult {
  InitiatedOrComplete,
  Failed,
  Success,
};

const itemLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItemMaybe = (store: StoreContextModel, id: string): Promise<InitiateLoadResult> => {
  if (itemLoadInitiatedOrComplete[id]) { return Promise.resolve(InitiateLoadResult.InitiatedOrComplete); }
  if (itemState.get(id) != null) { return Promise.resolve(InitiateLoadResult.InitiatedOrComplete); }
  itemLoadInitiatedOrComplete[id] = true;

  return server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus)
    .then(result => {
      if (!itemLoadInitiatedOrComplete[id]) { return InitiateLoadResult.Failed; };

      if (result != null) {
        itemState.setItemFromServerObject(result.item, null);
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], null);
        });
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange failed after load item: ${e}`);
        };
      } else {
        console.error(`Empty result fetching '${id}'.`);
      }
      return InitiateLoadResult.Success;
    })
    .catch((e: any) => {
      console.error(`Error occurred fetching item '${id}': ${e.message}.`);
      return InitiateLoadResult.Failed;
    });
}


let itemLoadFromRemoteInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItemFromRemoteMaybe = (store: StoreContextModel, itemId: string, baseUrl: string, resolveId: string) => {
  if (itemLoadFromRemoteInitiatedOrComplete[itemId]) { return; }
  itemLoadFromRemoteInitiatedOrComplete[itemId] = true;

  remote.fetchItems(baseUrl, itemId, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus)
    .then(result => {
      if (!itemLoadFromRemoteInitiatedOrComplete[itemId]) { return; };

      if (result != null) {
        itemState.setItemFromServerObject(result.item, baseUrl);
        asLinkItem(itemState.get(resolveId)!).linkToResolvedId = ItemFns.fromObject(result.item, baseUrl).id;
        Object.keys(result.attachments).forEach(id => {
          itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id], baseUrl);
        });
        try {
          fullArrange(store);
        } catch (e: any) {
          throw new Error(`Arrange after remote fetch failed: ${e}`);
        };
      } else {
        console.error(`Empty result fetching '${itemId}' from ${baseUrl}.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred fetching item '${itemId}' from '${baseUrl}': ${e.message}.`);
    });
}
