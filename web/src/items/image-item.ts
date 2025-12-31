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

import { ANCHOR_BOX_SIZE_PX, ANCHOR_OFFSET_PX, ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, PAGE_POPUP_TITLE_HEIGHT_BL, RESIZE_BOX_SIZE_PX } from "../constants";
import { HitboxFlags, HitboxFns } from "../layout/hitbox";
import { BoundingBox, Dimensions, Vector, zeroBoundingBoxTopLeft, cloneBoundingBox } from "../util/geometry";
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

  // Popup position/size overrides for spatial stretch parent pages
  popupPositionGr: Vector | null;
  popupWidthGr: number | null;
  pendingPopupPositionGr: Vector | null;
  pendingPopupWidthGr: number | null;

  // Popup position/size overrides for cell-based parent pages (grid, justified, calendar)
  cellPopupPositionNorm: Vector | null;
  cellPopupWidthNorm: number | null;
  pendingCellPopupPositionNorm: Vector | null;
  pendingCellPopupWidthNorm: number | null;
}

export interface ImageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin {
  imageSizePx: Dimensions,
}


export const ImageFns = {
  fromObject: (o: any, origin: string | null): ImageItem => {
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
      dateTime: o.dateTime,
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

      // Popup positioning fields (spatial stretch)
      popupPositionGr: o.popupPositionGr ?? null,
      popupWidthGr: o.popupWidthGr ?? null,
      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,

      // Popup positioning fields (cell-based)
      cellPopupPositionNorm: o.cellPopupPositionNorm ?? null,
      cellPopupWidthNorm: o.cellPopupWidthNorm ?? null,
      pendingCellPopupPositionNorm: null,
      pendingCellPopupWidthNorm: null,

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
      dateTime: i.dateTime,
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

      // Popup positioning fields (spatial stretch) - omit if null, round to integers for backend
      popupPositionGr: i.popupPositionGr ? { x: Math.round(i.popupPositionGr.x), y: Math.round(i.popupPositionGr.y) } : undefined,
      popupWidthGr: i.popupWidthGr != null ? Math.round(i.popupWidthGr) : undefined,

      // Popup positioning fields (cell-based) - omit if null
      cellPopupPositionNorm: i.cellPopupPositionNorm ?? undefined,
      cellPopupWidthNorm: i.cellPopupWidthNorm ?? undefined,
    });
  },

  asImageMeasurable: (item: ItemTypeMixin): ImageMeasurable => {
    if (item.itemType == ItemType.Image) { return item as ImageMeasurable; }
    panic("not image measurable.");
  },

  calcSpatialDimensionsBl: (image: ImageMeasurable): Dimensions => {
    // half block quantization.
    let heightBl = ((image.spatialWidthGr / GRID_SIZE) * image.imageSizePx.h / image.imageSizePx.w);
    return { w: image.spatialWidthGr / GRID_SIZE, h: heightBl };
  },

  calcGeometry_Spatial: (image: ImageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean = false, hasChildChanges: boolean = false, hasDefaultChanges: boolean = false): ItemGeometry => {
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

    const hitboxes = !emitHitboxes ? [] : [
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Attach, { x: 0, y: -blockSizePx.h / 2, w: innerBoundsPx.w, h: blockSizePx.h }),
      HitboxFns.create(HitboxFlags.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
    ];

    if (isPopup && emitHitboxes) {
      // Add anchor hitboxes for popup positioning - use 1x1 block size
      const iconSize = LINE_HEIGHT_PX;
      const iconOffset = 4; // small gap from edge
      let rightOffset = iconOffset;
      if (hasChildChanges) {
        const anchorChildBoundsPx = {
          x: innerBoundsPx.w - iconSize - rightOffset,
          y: iconOffset,
          w: iconSize,
          h: iconSize
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorChild, anchorChildBoundsPx));
        rightOffset += iconSize + iconOffset;
      }
      if (hasDefaultChanges) {
        const anchorDefaultBoundsPx = {
          x: innerBoundsPx.w - iconSize - rightOffset,
          y: iconOffset,
          w: iconSize,
          h: iconSize
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorDefault, anchorDefaultBoundsPx));
      }
    }

    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes,
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
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
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

  calcGeometry_InCell: (image: ImageMeasurable, cellBoundsPx: BoundingBox, isPopup: boolean = false, hasChildChanges: boolean = false, hasDefaultChanges: boolean = false, maximize: boolean = false): ItemGeometry => {
    const sizeBl = ImageFns.calcSpatialDimensionsBl(image); // TODO (MEDIUM): inappropriate quantization.
    const boundsPx = maximize ? cloneBoundingBox(cellBoundsPx)! : calcBoundsInCell(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };

    const hitboxes = [
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
    ];

    if (isPopup) {
      // Add resize hitbox for popups
      hitboxes.push(HitboxFns.create(HitboxFlags.Resize, {
        x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX,
        y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX,
        w: RESIZE_BOX_SIZE_PX,
        h: RESIZE_BOX_SIZE_PX
      }));

      // Add anchor hitboxes for popup positioning - use 1x1 block size
      const iconSize = LINE_HEIGHT_PX;
      const iconOffset = 4; // small gap from edge
      let rightOffset = iconOffset;
      if (hasChildChanges) {
        const anchorChildBoundsPx = {
          x: innerBoundsPx.w - iconSize - rightOffset,
          y: iconOffset,
          w: iconSize,
          h: iconSize
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorChild, anchorChildBoundsPx));
        rightOffset += iconSize + iconOffset;
      }
      if (hasDefaultChanges) {
        const anchorDefaultBoundsPx = {
          x: innerBoundsPx.w - iconSize - rightOffset,
          y: iconOffset,
          w: iconSize,
          h: iconSize
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorDefault, anchorDefaultBoundsPx));
      }
    }

    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes
    });
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (visualElement.flags & VisualElementFlags.Popup) {
      window.open('/files/' + visualElement.displayItem.id, '_blank');
    } else if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    } else if (store.history.currentPopupSpec() != null) {
      // Inside a popup hierarchy (e.g., image inside a page displayed from a popup list)
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

  handleOpenPopupClick: (visualElement: VisualElement, store: StoreContextModel, _isFromAttachment?: boolean): void => {
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
    const freshEl = document.getElementById(editingDomId)!;
    if (freshEl) {
      freshEl.focus();
      setCaretPosition(freshEl, closestIdx);
    }
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
  },

  // Popup positioning helpers for spatial stretch pages
  // For images, the default is computed (centered, 5% margin) rather than using page defaults
  getPopupPositionGrForParent: (parentPage: { innerSpatialWidthGr: number; naturalAspect: number }, imageItem: ImageItem, desktopBoundsPx?: { w: number; h: number }): Vector => {
    if (imageItem.pendingPopupPositionGr != null) {
      return imageItem.pendingPopupPositionGr;
    }
    if (imageItem.popupPositionGr != null) {
      return imageItem.popupPositionGr;
    }
    // Compute centered position based on parent page dimensions
    const innerWidthBl = parentPage.innerSpatialWidthGr / GRID_SIZE;
    const innerHeightBl = Math.floor(innerWidthBl / parentPage.naturalAspect);
    return {
      x: (innerWidthBl / 2) * GRID_SIZE,
      y: (innerHeightBl / 2) * GRID_SIZE
    };
  },

  getPopupWidthGrForParent: (parentPage: { innerSpatialWidthGr: number; naturalAspect: number }, imageItem: ImageItem, desktopBoundsPx?: { w: number; h: number }): number => {
    if (imageItem.pendingPopupWidthGr != null) {
      return imageItem.pendingPopupWidthGr;
    }
    if (imageItem.popupWidthGr != null) {
      return imageItem.popupWidthGr;
    }
    // Calculate default width with 5% margin on constraining dimension
    const imageAspect = imageItem.imageSizePx.w / imageItem.imageSizePx.h;
    const innerWidthBl = parentPage.innerSpatialWidthGr / GRID_SIZE;
    const innerHeightBl = Math.floor(innerWidthBl / parentPage.naturalAspect);
    const pageAspect = parentPage.naturalAspect;

    // Determine constraining dimension and calculate width with 5% margin
    const marginFraction = 0.05;
    let widthBl: number;
    // We use the effective aspect ratio from the floored height for comparison
    const effectivePageAspect = innerWidthBl / innerHeightBl;

    if (imageAspect > effectivePageAspect) {
      // Image is wider than page - width is constraining
      widthBl = innerWidthBl * (1 - 2 * marginFraction);
    } else {
      // Image is taller than page - height is constraining
      const availableHeightBl = innerHeightBl * (1 - 2 * marginFraction);
      widthBl = availableHeightBl * imageAspect;
    }
    return Math.round(widthBl * 2) / 2 * GRID_SIZE; // Half-block quantization
  },

  childPopupPositioningHasChanged: (parentPage: { defaultPopupPositionGr: Vector; defaultPopupWidthGr: number } | null, imageItem?: ImageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (imageItem == null) { return false; }
    if (imageItem.pendingPopupPositionGr != null) {
      const anchorPos = imageItem.popupPositionGr ?? parentPage.defaultPopupPositionGr;
      if (imageItem.pendingPopupPositionGr!.x != anchorPos.x ||
        imageItem.pendingPopupPositionGr!.y != anchorPos.y) {
        return true;
      }
    }
    if (imageItem.pendingPopupWidthGr != null) {
      const anchorWidth = imageItem.popupWidthGr ?? parentPage.defaultPopupWidthGr;
      if (imageItem.pendingPopupWidthGr != anchorWidth) {
        return true;
      }
    }
    return false;
  },

  // For images: home button shows when there's ANY stored position (to allow clearing it)
  // This is different from pages where home button sets page defaults
  hasStoredPopupPositioning: (imageItem?: ImageItem | null): boolean => {
    if (imageItem == null) { return false; }
    // Show home button if there's any stored or pending position/size
    return imageItem.pendingPopupPositionGr != null ||
      imageItem.pendingPopupWidthGr != null ||
      imageItem.popupPositionGr != null ||
      imageItem.popupWidthGr != null;
  },

  // Popup positioning helpers for cell-based pages (grid, justified, calendar)
  // For images, the default is computed (centered, 5% margin) rather than using page defaults
  getCellPopupPositionNormForParent: (imageItem: ImageItem): Vector => {
    if (imageItem.pendingCellPopupPositionNorm != null) {
      return imageItem.pendingCellPopupPositionNorm;
    }
    if (imageItem.cellPopupPositionNorm != null) {
      return imageItem.cellPopupPositionNorm;
    }
    // Default: centered
    return { x: 0.5, y: 0.5 };
  },

  getCellPopupWidthNormForParent: (imageItem: ImageItem, desktopBoundsPx?: { w: number; h: number }): number => {
    if (imageItem.pendingCellPopupWidthNorm != null) {
      return imageItem.pendingCellPopupWidthNorm;
    }
    if (imageItem.cellPopupWidthNorm != null) {
      return imageItem.cellPopupWidthNorm;
    }
    // Calculate default width with 5% margin on constraining dimension
    const imageAspect = imageItem.imageSizePx.w / imageItem.imageSizePx.h;
    const marginFraction = 0.05;

    if (desktopBoundsPx) {
      const desktopAspect = desktopBoundsPx.w / desktopBoundsPx.h;
      if (imageAspect > desktopAspect) {
        // Image is wider than desktop - width is constraining
        return 1 - 2 * marginFraction; // 0.9
      } else {
        // Image is taller than desktop - height is constraining
        const availableHeightNorm = 1 - 2 * marginFraction;
        const widthNorm = availableHeightNorm * imageAspect / desktopAspect;
        return Math.min(widthNorm, 1 - 2 * marginFraction);
      }
    }
    // Fallback if no desktop bounds provided
    return 0.9;
  },

  childCellPopupPositioningHasChanged: (parentPage: { defaultCellPopupPositionNorm: Vector; defaultCellPopupWidthNorm: number } | null, imageItem?: ImageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (imageItem == null) { return false; }
    if (imageItem.pendingCellPopupPositionNorm != null) {
      const anchorPos = imageItem.cellPopupPositionNorm ?? parentPage.defaultCellPopupPositionNorm;
      if (imageItem.pendingCellPopupPositionNorm!.x != anchorPos.x ||
        imageItem.pendingCellPopupPositionNorm!.y != anchorPos.y) {
        return true;
      }
    }
    if (imageItem.pendingCellPopupWidthNorm != null) {
      const anchorWidth = imageItem.cellPopupWidthNorm ?? parentPage.defaultCellPopupWidthNorm;
      if (imageItem.pendingCellPopupWidthNorm != anchorWidth) {
        return true;
      }
    }
    return false;
  },

  // For images: home button shows when there's ANY stored cell position (to allow clearing it)
  hasStoredCellPopupPositioning: (imageItem?: ImageItem | null): boolean => {
    if (imageItem == null) { return false; }
    // Show home button if there's any stored or pending position/size
    return imageItem.pendingCellPopupPositionNorm != null ||
      imageItem.pendingCellPopupWidthNorm != null ||
      imageItem.cellPopupPositionNorm != null ||
      imageItem.cellPopupWidthNorm != null;
  },

  handleAnchorChildClick: (imageItem: ImageItem, parentPage: { arrangeAlgorithm: string }, store: StoreContextModel): void => {
    const isCellPopup = parentPage.arrangeAlgorithm != "spatial-stretch";

    if (isCellPopup) {
      if (imageItem.pendingCellPopupPositionNorm != null) {
        imageItem.cellPopupPositionNorm = imageItem.pendingCellPopupPositionNorm!;
        imageItem.pendingCellPopupPositionNorm = null;
      }
      if (imageItem.pendingCellPopupWidthNorm != null) {
        imageItem.cellPopupWidthNorm = imageItem.pendingCellPopupWidthNorm;
        imageItem.pendingCellPopupWidthNorm = null;
      }
    } else {
      if (imageItem.pendingPopupPositionGr != null) {
        imageItem.popupPositionGr = imageItem.pendingPopupPositionGr!;
        imageItem.pendingPopupPositionGr = null;
      }
      if (imageItem.pendingPopupWidthGr != null) {
        imageItem.popupWidthGr = imageItem.pendingPopupWidthGr;
        imageItem.pendingPopupWidthGr = null;
      }
    }
    // Note: serverOrRemote.updateItem is called by the caller
    fullArrange(store);
  },

  // For images: home button clears stored position (resets to computed default)
  // This is different from pages where home button sets page-level defaults
  handleHomeClick: (imageItem: ImageItem, parentPage: any, store: StoreContextModel, serverOrRemote: any): void => {
    const isCellPopup = parentPage.arrangeAlgorithm != "spatial-stretch";
    let needsUpdate = false;

    if (isCellPopup) {
      // Clear all stored/pending cell popup positioning
      imageItem.pendingCellPopupPositionNorm = null;
      imageItem.pendingCellPopupWidthNorm = null;

      if (imageItem.cellPopupPositionNorm != null || imageItem.cellPopupWidthNorm != null) {
        imageItem.cellPopupPositionNorm = null;
        imageItem.cellPopupWidthNorm = null;
        needsUpdate = true;
      }
    } else {
      // Clear all stored/pending spatial popup positioning
      imageItem.pendingPopupPositionGr = null;
      imageItem.pendingPopupWidthGr = null;

      if (imageItem.popupPositionGr != null || imageItem.popupWidthGr != null) {
        imageItem.popupPositionGr = null;
        imageItem.popupWidthGr = null;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      serverOrRemote.updateItem(imageItem, store.general.networkStatus);
    }
    fullArrange(store);
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
