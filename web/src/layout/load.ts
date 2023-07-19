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
import { GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, server } from "../server";
import { Uid } from "../util/uid";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { asContainerItem } from "../items/base/container-item";
import { arrange } from "./arrange";


export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsIfNotLoaded = (desktopStore: DesktopStoreContextModel, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) {
    return;
  }
  childrenLoadInitiatedOrComplete[containerId] = true;
  server.fetchItems(containerId, GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY)
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setChildItemsFromServerObjects(containerId, result.items);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          asContainerItem(desktopStore.getItem(containerId)!).childrenLoaded = true;
          try {
            arrange(desktopStore);
          } catch (e: any) {
            throw new Error(`arrange failed ${e}`);
          };
        });
      } else {
        console.log(`No items were fetched for '${containerId}'.`);
      }
    })
    .catch((e: any) => {
      console.log(`Error occurred feching items for '${containerId}': ${e.message}.`);
    });
}


let itemLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadItem = (desktopStore: DesktopStoreContextModel, itemId: string) => {
  if (itemLoadInitiatedOrComplete[itemId]) {
    return;
  }
  itemLoadInitiatedOrComplete[itemId] = true;
  server.fetchItems(itemId, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY)
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setItemFromServerObject(result.item);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          try {
            arrange(desktopStore);
          } catch (e: any) {
            throw new Error(`arrange failed ${e}`);
          };
        });
      } else {
        console.log(`Empty result fetching '${itemId}'.`);
      }
    })
    .catch((e: any) => {
      console.log(`Error occurred feching item '${itemId}': ${e.message}.`);
    });
}
