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

import { batch } from "solid-js";
import { GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, remote, server } from "../server";
import { Uid } from "../util/uid";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { asContainerItem } from "../items/base/container-item";
import { asLinkItem } from "../items/link-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { itemState } from "../store/ItemState";
import { arrange } from "./arrange";


export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsMaybe = (desktopStore: DesktopStoreContextModel, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) { return; }
  childrenLoadInitiatedOrComplete[containerId] = true;

  server.fetchItems(`${containerId}`, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY)
    .then(result => {
      if (result != null) {
        batch(() => {
          itemState.setChildItemsFromServerObjects(containerId, result.children);
          Object.keys(result.attachments).forEach(id => {
            itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          asContainerItem(itemState.get(containerId)!).childrenLoaded = true;
          try {
            arrange(desktopStore);
          } catch (e: any) {
            throw new Error(`arrange failed ${e}`);
          };
        });
      } else {
        console.error(`No items were fetched for '${containerId}'.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred feching items for '${containerId}': ${e.message}.`);
    });
}


let itemLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItemMaybe = (desktopStore: DesktopStoreContextModel, id: string) => {
  if (itemLoadInitiatedOrComplete[id]) { return; }
  itemLoadInitiatedOrComplete[id] = true;

  server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY)
    .then(result => {
      if (result != null) {
        batch(() => {
          itemState.setItemFromServerObject(result.item);
          Object.keys(result.attachments).forEach(id => {
            itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          try {
            arrange(desktopStore);
          } catch (e: any) {
            throw new Error(`arrange failed ${e}`);
          };
        });
      } else {
        console.error(`Empty result fetching '${id}'.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred feching item '${id}': ${e.message}.`);
    });
}


let itemLoadFromRemoteInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItemFromRemoteMaybe = (desktopStore: DesktopStoreContextModel, itemId: string, baseUrl: string, resolveId: string) => {
  if (itemLoadFromRemoteInitiatedOrComplete[itemId]) { return; }
  itemLoadFromRemoteInitiatedOrComplete[itemId] = true;

  remote.fetchItems(baseUrl, itemId, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY)
    .then(result => {
      if (result != null) {
        batch(() => {
          itemState.setItemFromServerObject(result.item);
          asLinkItem(itemState.get(resolveId)!).linkToResolvedId = ItemFns.fromObject(result.item).id;
          Object.keys(result.attachments).forEach(id => {
            itemState.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          try {
            arrange(desktopStore);
          } catch (e: any) {
            throw new Error(`arrange failed ${e}`);
          };
        });
      } else {
        console.error(`Empty result fetching '${itemId}'.`);
      }
    })
    .catch((e: any) => {
      console.error(`Error occurred feching item '${itemId}': ${e.message}.`);
    });
}
