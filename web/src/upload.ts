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
import { PageItem, ArrangeAlgorithm } from "./items/page-item";
import { StoreContextModel } from "./store/StoreProvider";
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { Vector } from "./util/geometry";
import { newUid } from "./util/uid";
import { ItemType } from "./items/base/item";
import { ItemFns } from "./items/base/item-polymorphism";
import { itemState } from "./store/ItemState";
import { fullArrange } from "./layout/arrange";
import { HitInfoFns } from "./input/hit";


export async function handleUpload(
    store: StoreContextModel,
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
        console.debug("TODO: upload clippings", txt, desktopPx);
      });
    }
  }

  let posPx = { x: 0.0, y: 0.0 };
  if (parent.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
    const hitInfo = HitInfoFns.hit(store, desktopPx, [], false);

    if (hitInfo.overPositionGr != null) {
      posPx = hitInfo.overPositionGr;
    } else {
      const propX = (desktopPx.x - HitInfoFns.getHitVe(hitInfo).boundsPx.x) / HitInfoFns.getHitVe(hitInfo).boundsPx.w;
      const propY = (desktopPx.y - HitInfoFns.getHitVe(hitInfo).boundsPx.y) / HitInfoFns.getHitVe(hitInfo).boundsPx.h;
      posPx = {
        x: Math.floor(parent.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
        y: Math.floor(parent.innerSpatialWidthGr / GRID_SIZE / parent.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
      };
    }
  }

  // handle files.
  const files = dataTransfer.files;

  if (files.length > 0) {
    store.overlay.uploadOverlayInfo.set({
      currentFile: 0,
      totalFiles: files.length,
      currentFileName: files[0].name
    });
  }

  for (let i=0; i<files.length; ++i) {
    const file = files[i];

    store.overlay.uploadOverlayInfo.set({
      currentFile: i + 1,
      totalFiles: files.length,
      currentFileName: file.name
    });

    const base64Data = base64ArrayBuffer(await file.arrayBuffer());

    if (file.type == "image/jpeg" || file.type == "image/png") {
      let spatialWidthGr = 4.0 * GRID_SIZE;

      if (parent.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
        let maxWidthBl = Math.floor((parent.innerSpatialWidthGr - posPx.x - GRID_SIZE / 2.0) / GRID_SIZE);
        if (maxWidthBl < 2) { maxWidthBl = 2; }
        if (maxWidthBl * GRID_SIZE < spatialWidthGr) {
          spatialWidthGr = maxWidthBl * GRID_SIZE;
        }
      }

      let imageItem: object = {
        itemType: ItemType.Image,
        parentId: parent.id,
        title: file.name,
        spatialPositionGr: posPx,
        spatialWidthGr: spatialWidthGr,
        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,
      };

      const returnedItem = await server.addItemFromPartialObject(imageItem, base64Data, store.general.networkStatus);
      // TODO (MEDIUM): immediately put an item in the UI, have image update later.
      itemState.add(ItemFns.fromObject(returnedItem, null));
      fullArrange(store);

    } else {
      let spatialWidthGr = 8.0 * GRID_SIZE;

      if (parent.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
        let maxWidthBl = Math.floor((parent.innerSpatialWidthGr - posPx.x - GRID_SIZE / 2.0) / GRID_SIZE);
        if (maxWidthBl < 2) { maxWidthBl = 2; }
        if (maxWidthBl * GRID_SIZE < spatialWidthGr) {
          spatialWidthGr = maxWidthBl * GRID_SIZE;
        }
      }

      let fileItem: object = {
        itemType: ItemType.File,
        id: newUid(),
        parentId: parent.id,
        title: file.name,
        spatialPositionGr: posPx,
        spatialWidthGr: spatialWidthGr,
        originalCreationDate: Math.round(file.lastModified/1000.0),
        mimeType: file.type,
        fileSizeBytes: file.size,
      };

      const returnedItem = await server.addItemFromPartialObject(fileItem, base64Data, store.general.networkStatus);
      // TODO (MEDIUM): immediately put an item in the UI.
      itemState.add(ItemFns.fromObject(returnedItem, null));
      fullArrange(store);
    }
  }

  setTimeout(() => {
    store.overlay.uploadOverlayInfo.set(null);
  }, 1000);
}
