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

import { GRID_SIZE } from "./constants";
import { server } from "./server";
import { calcBlockPositionGr, PageItem } from "./items/page-item";
import { DesktopStoreContextModel } from "./store/DesktopStoreProvider";
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { Vector } from "./util/geometry";
import { newUid } from "./util/uid";
import { ITEM_TYPE_FILE, ITEM_TYPE_IMAGE } from "./items/base/item";
import { itemFromObject } from "./items/base/item-polymorphism";
import { arrange, ARRANGE_ALGO_GRID, ARRANGE_ALGO_SPATIAL_STRETCH } from "./layout/arrange";
import { itemState } from "./store/ItemState";


export async function handleUpload(
    desktopStore: DesktopStoreContextModel,
    dataTransfer: DataTransfer,
    desktopPx: Vector,
    parent: PageItem) {

  // handle string type data.
  for (let item of dataTransfer.items) {
    if (item.kind != 'string') {
      continue;
    }
    if (item.type == 'text/html') {
      item.getAsString((txt) => {
        console.log("TODO: upload clipings", txt, desktopPx);
      });
    }
  }

  const posPx = parent.arrangeAlgorithm != ARRANGE_ALGO_SPATIAL_STRETCH
    ? {x: 0.0, y: 0.0}
    : calcBlockPositionGr(desktopStore, parent, desktopPx);

  // handle files.
  const files = dataTransfer.files;
  for (let i=0; i<files.length; ++i) {
    console.log(`uploading ${i}/${files.length}...`);
    const file = files[i];
    const base64Data = base64ArrayBuffer(await file.arrayBuffer());

    if (file.type.startsWith("image")) {
      let imageItem: object = {
        itemType: ITEM_TYPE_IMAGE,
        parentId: parent.id,
        title: file.name,
        spatialPositionGr: posPx,
        spatialWidthGr: 4.0 * GRID_SIZE,
        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,
      };

      const returnedItem = await server.addItemFromPartialObject(imageItem, base64Data);
      // TODO (MEDIUM): immediately put an item in the UI, have image update later.
      itemState.addItem(itemFromObject(returnedItem));
      arrange(desktopStore);

    } else {
      let fileItem: object = {
        itemType: ITEM_TYPE_FILE,
        id: newUid(),
        parentId: parent.id,
        title: file.name,
        spatialPositionGr: posPx,
        spatialWidthGr: 8.0 * GRID_SIZE,
        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,
      };

      const returnedItem = await server.addItemFromPartialObject(fileItem, base64Data);
      // TODO (MEDIUM): immediately put an item in the UI.
      itemState.addItem(itemFromObject(returnedItem));
      arrange(desktopStore);
    }
  }
}
