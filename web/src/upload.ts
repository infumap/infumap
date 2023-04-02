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

import { GRID_SIZE } from "./constants";
import { Child } from "./store/desktop/relationship-to-parent";
import { server } from "./server";
import { FileItem } from "./store/desktop/items/file-item";
import { ImageItem } from "./store/desktop/items/image-item";
import { calcBlockPositionGr, PageItem } from "./store/desktop/items/page-item";
import { DesktopStoreContextModel } from "./store/desktop/DesktopStoreProvider";
import { UserStoreContextModel } from "./store/UserStoreProvider";
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { Vector } from "./util/geometry";
import { currentUnixTimeSeconds } from "./util/lang";
import { newUid } from "./util/uid";
import { ITEM_TYPE_FILE, ITEM_TYPE_IMAGE } from "./store/desktop/items/base/item";
import { createBooleanSignal, createUidArraySignal, createVectorSignal } from "./util/signals";
import { itemFromObject } from "./store/desktop/items/base/item-polymorphism";


export async function handleUpload(
    desktopStore: DesktopStoreContextModel,
    userStore: UserStoreContextModel,
    dataTransfer: DataTransfer,
    desktopPx: Vector,
    parent: PageItem) {

  // handle string type data.
  for (let i=0; i<dataTransfer.items.length; ++i) {
    let itm = dataTransfer.items[i];
    if (itm.kind != 'string') {
      continue;
    }
    if (itm.type == 'text/html') {
      itm.getAsString((txt) => {
        console.log("TODO: upload clipings", txt, desktopPx);
      });
    }
  }

  // handle files.
  const files = dataTransfer.files;
  for (let i=0; i<dataTransfer.files.length; ++i) {
    let file = dataTransfer.files[i];
    let base64Data = base64ArrayBuffer(await file.arrayBuffer());

    if (file.type.startsWith("image")) {
      let imageItem: ImageItem = {
        itemType: ITEM_TYPE_IMAGE,
        ownerId: userStore.getUser().userId,
        id: newUid(),
        parentId: parent.id,
        relationshipToParent: Child,
        creationDate: currentUnixTimeSeconds(),
        lastModifiedDate: currentUnixTimeSeconds(),
        ordering: desktopStore.newOrderingAtEndOfChildren(parent.id),
        title: file.name,
        spatialPositionGr: createVectorSignal(calcBlockPositionGr(parent, desktopPx)),

        spatialWidthGr: 4.0 * GRID_SIZE,

        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,

        imageSizePx: { w: -1, h: -1 }, // calculate on server.
        thumbnail: "", // calculate on server.

        computed_attachments: createUidArraySignal([]),
        computed_mouseIsOver: createBooleanSignal(false),
      };

      let returnedItem = await server.addItem(imageItem, base64Data);
      // TODO (MEDIUM): immediately put an item in the UI, have image update later.
      desktopStore.addItem(itemFromObject(returnedItem));

    } else {
      let fileItem: FileItem = {
        itemType: ITEM_TYPE_FILE,
        ownerId: userStore.getUser().userId,
        id: newUid(),
        parentId: parent.id,
        relationshipToParent: Child,
        creationDate: currentUnixTimeSeconds(),
        lastModifiedDate: currentUnixTimeSeconds(),
        ordering: desktopStore.newOrderingAtEndOfChildren(parent.id),
        title: file.name,
        spatialPositionGr: createVectorSignal(calcBlockPositionGr(parent, desktopPx)),

        spatialWidthGr: 8.0 * GRID_SIZE,

        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,

        computed_attachments: createUidArraySignal([]),
        computed_mouseIsOver: createBooleanSignal(false),
      };

      await server.addItem(fileItem, base64Data);
      desktopStore.addItem(fileItem);
    }
  }
}
