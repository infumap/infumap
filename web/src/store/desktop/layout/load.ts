/*
  Copyright (C) 2023 The Infumap Authors
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
import { server } from "../../../server";
import { Uid } from "../../../util/uid";
import { DesktopStoreContextModel } from "../DesktopStoreProvider";
import { asContainerItem } from "../items/base/container-item";
import { rearrangeVisualElementsWithId } from "./rearrange";


export let childrenLoadInitiatedOrComplete: { [id: Uid]: boolean } = {};

export const initiateLoadChildItemsIfNotLoaded = (desktopStore: DesktopStoreContextModel, containerId: string) => {
  if (childrenLoadInitiatedOrComplete[containerId]) {
    return;
  }
  childrenLoadInitiatedOrComplete[containerId] = true;
  server.fetchChildrenWithTheirAttachments(containerId)
    .then(result => {
      if (result != null) {
        batch(() => {
          desktopStore.setChildItemsFromServerObjects(containerId, result.items);
          Object.keys(result.attachments).forEach(id => {
            desktopStore.setAttachmentItemsFromServerObjects(id, result.attachments[id]);
          });
          asContainerItem(desktopStore.getItem(containerId)!).childrenLoaded.set(true);
          try {
            rearrangeVisualElementsWithId(desktopStore, containerId, true);
          } catch (e: any) {
            throw new Error(`rearrangeVisualElementsWithId failed ${e}`);
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
