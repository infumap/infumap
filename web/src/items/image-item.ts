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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { BoundingBox, Dimensions, zeroBoundingBoxTopLeft } from "../util/geometry";
import { panic } from "../util/lang";
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from "./base/attachments-item";
import { DataItem } from "./base/data-item";
import { ItemType, ItemTypeMixin } from "./base/item";
import { TitledItem } from "./base/titled-item";
import { XSizableItem, XSizableMixin } from "./base/x-sizeable-item";
import { ItemGeometry } from "../layout/item-geometry";
import { PositionalMixin } from "./base/positional-item";
import { VisualElement, VisualElementFlags, VeFns } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { VesCache } from "../layout/ves-cache";
import { calcBoundsInCell, handleListPageLineItemClickMaybe } from "./base/item-common-fns";
import { fullArrange } from "../layout/arrange";
import { ItemFns } from "./base/item-polymorphism";
import { FlagsMixin } from "./base/flags-item";
import { closestCaretPositionToClientPx, setCaretPosition } from "../util/caret";
import { CursorEventState } from "../input/state";


export interface ImageItem extends ImageMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem {
  thumbnail: string,
}

export interface ImageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin {
  imageSizePx: Dimensions,
}


export const ImageFns = {
  fromObject:(o: any, origin: string | null): ImageItem => {
    // TODO (LOW): dynamic type check of o.
    return ({
      origin,
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId,
      relationshipToParent: o.relationshipToParent,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,

      flags: o.flags,

      originalCreationDate: o.originalCreationDate,
      mimeType: o.mimeType,
      fileSizeBytes: o.fileSizeBytes,

      thumbnail: o.thumbnail,
      imageSizePx: o.imageSizePx,

      computed_attachments: [],
    });
  },

  toObject: (i: ImageItem): object => {
    return ({
      itemType: i.itemType,
      ownerId: i.ownerId,
      id: i.id,
      parentId: i.parentId,
      relationshipToParent: i.relationshipToParent,
      creationDate: i.creationDate,
      lastModifiedDate: i.lastModifiedDate,
      ordering: Array.from(i.ordering),
      title: i.title,
      spatialPositionGr: i.spatialPositionGr,

      spatialWidthGr: i.spatialWidthGr,

      flags: i.flags,

      originalCreationDate: i.originalCreationDate,
      mimeType: i.mimeType,
      fileSizeBytes: i.fileSizeBytes,

      thumbnail: i.thumbnail,
      imageSizePx: i.imageSizePx,
    });
  },

  asImageMeasurable: (item: ItemTypeMixin): ImageMeasurable => {
    if (item.itemType == ItemType.Image) { return item as ImageMeasurable; }
    panic("not image measurable.");
  },

  calcSpatialDimensionsBl: (image: ImageMeasurable): Dimensions => {
    // half block quantization.
    let heightBl = Math.round(((image.spatialWidthGr / GRID_SIZE) * image.imageSizePx.h / image.imageSizePx.w) * 2.0) / 2.0;
    return { w: image.spatialWidthGr / GRID_SIZE, h: heightBl };
  },

  calcGeometry_Spatial: (image: ImageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (image.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
      y: (image.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
      w: ImageFns.calcSpatialDimensionsBl(image).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: ImageFns.calcSpatialDimensionsBl(image).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: boundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ],
    }
  },

  calcGeometry_InComposite: (measurable: ImageMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = ImageFns.asImageMeasurable(ItemFns.cloneMeasurableFields(measurable));
    if (cloned.spatialWidthGr > compositeWidthBl * GRID_SIZE) {
      cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    }
    const sizeBl = ImageFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w + CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: topPx,
      w: cloned.spatialWidthGr / GRID_SIZE * blockSizePx.w - (CONTAINER_IN_COMPOSITE_PADDING_PX * 2) - 2,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ]
    };
  },

  calcGeometry_Attachment: (image: ImageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(image, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_image: ImageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean, inTable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const clickAreaBoundsPx = {
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    const result = {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, inTable ? innerBoundsPx : clickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.ShowPointer, inTable ? innerBoundsPx : clickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
    };
    if (!inTable) {
      result.hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx));
    }
    return result;
  },

  calcGeometry_InCell: (image: ImageMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const sizeBl = ImageFns.calcSpatialDimensionsBl(image); // TODO (MEDIUM): inappropriate quantization.
    const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      ]
    });
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (visualElement.flags & VisualElementFlags.Popup) {
      window.open('/files/' + visualElement.displayItem.id, '_blank');
    } else if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    } else {
      if (visualElement.flags & VisualElementFlags.LineItem) {
        if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
        store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
        fullArrange(store);
      } else {
        store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
        fullArrange(store);
      }
    }
  },

  handleOpenPopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    fullArrange(store);
  },

  handleEditClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const itemPath = VeFns.veToPath(visualElement);
    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Image });
    const editingDomId = itemPath + ":title";
    const el = document.getElementById(editingDomId)!;
    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    fullArrange(store);
    setCaretPosition(el, closestIdx);
  },

  handleLinkClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    fullArrange(store);
  },

  cloneMeasurableFields: (image: ImageMeasurable): ImageMeasurable => {
    return ({
      itemType: image.itemType,
      flags: image.flags,
      spatialPositionGr: image.spatialPositionGr,
      spatialWidthGr: image.spatialWidthGr,
      imageSizePx: image.imageSizePx
    });
  },

  debugSummary: (imageItem: ImageItem) => {
    return "[image] " + imageItem.title;
  },

  getFingerprint: (imageItem: ImageItem): string => {
    return imageItem.title + "-~-" + imageItem.flags;
  }  
};


export function isImage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Image;
}

export function asImageItem(item: ItemTypeMixin): ImageItem {
  if (item.itemType == ItemType.Image) { return item as ImageItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not an image.`);
}
