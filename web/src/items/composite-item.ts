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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_ITEM_GAP_BL, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { Hitbox, HitboxFlags, HitboxFns } from '../layout/hitbox';
import { compositeMoveOutHitboxBoundsPx } from '../layout/composite-move-out';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, AttachmentsMixin, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { itemCanEdit, normalizeItemCapabilities } from './base/capabilities-item';
import { ContainerItem } from './base/container-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { TitledItem, TitledMixin } from './base/titled-item';
import { XSizableItem, XSizableMixin, asXSizableItem, isXSizableItem } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { itemState } from '../store/ItemState';
import { ItemFns } from './base/item-polymorphism';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe, isInsidePopupHierarchy } from './base/item-common-fns';
import { CompositeFlags, FlagsMixin, PageFlags } from './base/flags-item';
import { VeFns, VisualElement } from '../layout/visual-element';
import { StoreContextModel } from '../store/StoreProvider';
import { arrangeNow, requestArrange } from '../layout/arrange';
import { PageFns, asPageItem, isPage } from './page-item';
import { asImageItem, isImage } from './image-item';
import { markChildrenLoadAsInitiatedOrComplete } from '../layout/load';
import { isNote, NoteFns } from './note-item';
import { closestCaretPositionToClientPx, setCaretPosition } from '../util/caret';
import { CursorEventState } from '../input/state';


export interface CompositeItem extends CompositeMeasurable, XSizableItem, ContainerItem, AttachmentsItem, TitledItem { }

export interface CompositeMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin, AttachmentsMixin, TitledMixin {
  id: Uid;

  childrenLoaded: boolean;
  computed_children: Array<Uid>;
}


export const CompositeFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): CompositeItem => {
    let id = newUid();
    markChildrenLoadAsInitiatedOrComplete(id);
    return ({
      origin: null,
      itemType: ItemType.Composite,
      ownerId,
      id,
      parentId,
      relationshipToParent,
      groupId: null,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      endDateTime: null,
      ordering,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 4.0 * GRID_SIZE,
      title: "",

      flags: CompositeFlags.None,

      orderChildrenBy: "",

      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,
    });
  },

  fromObject: (o: any, origin: string | null): CompositeItem => {
    // TODO: dynamic type check of o.
    return ({
      origin,
      capabilities: normalizeItemCapabilities(o.capabilities),
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId ? o.parentId : null,
      relationshipToParent: o.relationshipToParent,
      groupId: o.groupId ?? null,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      dateTime: o.dateTime,
      endDateTime: o.endDateTime ?? null,
      ordering: new Uint8Array(o.ordering),
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,
      title: o.title ?? "",

      flags: o.flags,

      orderChildrenBy: o.orderChildrenBy,

      computed_children: [],
      computed_attachments: [],

      childrenLoaded: false,
    });
  },

  toObject: (p: CompositeItem): object => {
    return ({
      itemType: p.itemType,
      ownerId: p.ownerId,
      id: p.id,
      parentId: p.parentId == EMPTY_UID ? null : p.parentId,
      relationshipToParent: p.relationshipToParent,
      groupId: p.groupId,
      creationDate: p.creationDate,
      lastModifiedDate: p.lastModifiedDate,
      dateTime: p.dateTime,
      endDateTime: p.endDateTime,
      ordering: Array.from(p.ordering),
      spatialPositionGr: p.spatialPositionGr,

      spatialWidthGr: p.spatialWidthGr,
      title: p.title,

      flags: p.flags,

      orderChildrenBy: p.orderChildrenBy,
    });
  },

  calcCollapsedSpatialDimensionsBl: (composite: CompositeMeasurable): Dimensions => {
    return {
      w: composite.spatialWidthGr / GRID_SIZE,
      h: 1.0,
    };
  },

  calcSpatialDimensionsBl: (composite: CompositeMeasurable, collapsed: boolean = false): Dimensions => {
    if (collapsed) {
      return CompositeFns.calcCollapsedSpatialDimensionsBl(composite);
    }

    let bh = CompositeFns.showTitle(composite) ? 1.0 + COMPOSITE_ITEM_GAP_BL : 0.0;
    for (let childId of composite.computed_children) {
      let item = itemState.get(childId)!;
      if (!item) { continue; }
      let cloned = ItemFns.cloneMeasurableFields(item);
      if (isPage(cloned)) {
        if (asPageItem(cloned).spatialWidthGr > composite.spatialWidthGr) {
          asPageItem(cloned).spatialWidthGr = composite.spatialWidthGr;
        }
      } else if (isImage(cloned)) {
        if (asImageItem(cloned).spatialWidthGr > composite.spatialWidthGr) {
          asImageItem(cloned).spatialWidthGr = composite.spatialWidthGr;
        }
      } else if (isXSizableItem(cloned)) {
        asXSizableItem(cloned).spatialWidthGr = composite.spatialWidthGr;
      }
      const sizeBl = isNote(cloned)
        ? NoteFns.calcSpatialDimensionsBl(NoteFns.asNoteMeasurable(cloned), true)
        : ItemFns.calcSpatialDimensionsBl(cloned);
      if (isPage(cloned) && (asPageItem(cloned).flags & PageFlags.EmbeddedInteractive)) {
        sizeBl.h += PageFns.embeddedInteractiveTitleHeightBl(asPageItem(cloned));
      }
      bh += sizeBl.h + COMPOSITE_ITEM_GAP_BL;
    }
    bh -= COMPOSITE_ITEM_GAP_BL;
    bh = Math.ceil(bh * 2) / 2;
    return { w: composite.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
  },

  showTitle: (composite: CompositeMeasurable): boolean => {
    return !!(composite.flags & CompositeFlags.ShowTitle);
  },

  hasOwnTitle: (composite: CompositeMeasurable): boolean => {
    return CompositeFns.showTitle(composite) || composite.title.trim() != "";
  },

  collapseToggleHitboxMaybe: (composite: CompositeMeasurable, blockSizePx: Dimensions): Array<Hitbox> => {
    if (composite.computed_children.length == 0) {
      return [];
    }
    return [
      HitboxFns.create(HitboxFlags.Expand | HitboxFlags.ShowPointer, {
        x: -blockSizePx.w,
        y: 0,
        w: blockSizePx.w,
        h: blockSizePx.h,
      }, {
        allowOutsideBounds: true,
        compositeContentCollapse: true,
      }),
    ];
  },

  calcGeometry_InComposite: (_measurable: CompositeMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    const sizeBl = { w: compositeWidthBl, h: 1 };
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveAreaBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2)
    };
    const moveBoundsPx = compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, leftMarginBl == 0 ? 2 : 0);
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ShowPointer, moveBoundsPx, { compositeMoveOut: true }),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_InDocument: (composite: CompositeMeasurable, blockSizePx: Dimensions, documentWidthBl: number, leftMarginBl: number, topPx: number, collapsed: boolean = false): ItemGeometry => {
    const cloned = CompositeFns.asCompositeMeasurable(ItemFns.cloneMeasurableFields(composite));
    cloned.spatialWidthGr = documentWidthBl * GRID_SIZE;
    const sizeBl = CompositeFns.calcSpatialDimensionsBl(cloned, collapsed);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w + CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: topPx,
      w: documentWidthBl * blockSizePx.w - (CONTAINER_IN_COMPOSITE_PADDING_PX * 2) - 2,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveAreaBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2)
    };
    const titleHitboxMaybe = CompositeFns.showTitle(composite)
      ? [HitboxFns.create(HitboxFlags.Click | HitboxFlags.ContentEditable, { x: 0, y: 0, w: innerBoundsPx.w, h: blockSizePx.h })]
      : [];
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: boundsPx,
      hitboxes: [
        ...CompositeFns.collapseToggleHitboxMaybe(composite, blockSizePx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ShowPointer, compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, leftMarginBl == 0 ? 2 : 0), { compositeMoveOut: true }),
        ...titleHitboxMaybe,
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_Spatial: (composite: CompositeMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean, collapsed: boolean = false): ItemGeometry => {
    const sizeBl = CompositeFns.calcSpatialDimensionsBl(composite, collapsed);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (composite.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (composite.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const titleHitboxMaybe = CompositeFns.showTitle(composite)
      ? [HitboxFns.create(HitboxFlags.Click | HitboxFlags.ContentEditable, { x: 0, y: 0, w: innerBoundsPx.w, h: blockSizePx.h })]
      : [];
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        ...titleHitboxMaybe,
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ],
    });
  },

  calcGeometry_Attachment: (composite: CompositeMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(composite, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_composite: CompositeMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, expandable: boolean): ItemGeometry => {
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
    const expandAreaBoundsPx = {
      x: boundsPx.w - blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w,
      h: blockSizePx.h
    };
    const hitboxes = [
      HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
    ];
    if (expandable) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Expand, expandAreaBoundsPx));
    }
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes
    });
  },

  calcGeometry_InCell: (composite: CompositeMeasurable, cellBoundsPx: BoundingBox, maximize: boolean, collapsed: boolean = false): ItemGeometry => {
    const sizeBl = CompositeFns.calcSpatialDimensionsBl(composite, collapsed);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const titleHitboxMaybe = CompositeFns.showTitle(composite)
      ? [HitboxFns.create(HitboxFlags.Click | HitboxFlags.ContentEditable, { x: 0, y: 0, w: innerBoundsPx.w, h: blockSizePx.h })]
      : [];
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      blockSizePx,
      viewportBoundsPx: boundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        ...titleHitboxMaybe,
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ]
    });
  },

  asCompositeMeasurable: (item: ItemTypeMixin): CompositeMeasurable => {
    if (item.itemType == ItemType.Composite) { return item as CompositeMeasurable; }
    panic("not composite measurable.");
  },

  cloneMeasurableFields: (composite: CompositeMeasurable): CompositeMeasurable => {
    return ({
      itemType: composite.itemType,
      id: composite.id,
      spatialPositionGr: composite.spatialPositionGr,
      spatialWidthGr: composite.spatialWidthGr,
      title: composite.title,
      childrenLoaded: composite.childrenLoaded,
      computed_children: composite.computed_children,
      computed_attachments: composite.computed_attachments,
      flags: composite.flags,
    });
  },

  handleEditTitleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const itemPath = VeFns.veToPath(visualElement);
    const handledByList = handleListPageLineItemClickMaybe(visualElement, store);
    if (!itemCanEdit(visualElement.displayItem)) {
      if (!handledByList) {
        store.history.setFocus(itemPath);
        arrangeNow(store, "composite-title-focus-only");
      }
      return;
    }

    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Composite });
    const editingDomId = itemPath + ":title";
    const el = document.getElementById(editingDomId);
    if (!(el instanceof HTMLElement)) {
      store.overlay.setTextEditInfo(store.history, null);
      store.history.setFocus(itemPath);
      arrangeNow(store, "composite-title-edit-target-missing");
      return;
    }

    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    arrangeNow(store, "composite-enter-title-edit-mode");
    const freshEl = document.getElementById(editingDomId);
    if (freshEl instanceof HTMLElement) {
      freshEl.focus();
      setCaretPosition(freshEl, closestIdx);
    }
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel, forceEdit: boolean = false): void => {
    if (forceEdit) {
      CompositeFns.handleEditTitleClick(visualElement, store);
      return;
    }
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    store.history.setFocus(VeFns.veToPath(visualElement));
    requestArrange(store, "composite-focus-only");
  },

  handlePopupClick: (visualElement: VisualElement, store: StoreContextModel, _isFromAttachment?: boolean): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if (isInsidePopupHierarchy(visualElement)) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    } else {
      store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    }
    requestArrange(store, "item-popup-open");
  },

  debugSummary: (_compositeItem: CompositeItem) => {
    return "[composite] " + _compositeItem.title;
  },

  getFingerprint: (compositeItem: CompositeItem): string => {
    return compositeItem.title + "~~~!@#~~~" + compositeItem.flags + "@#$" + compositeItem.computed_children.length;
  }
};


export function isComposite(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Composite;
}

export function asCompositeItem(item: ItemTypeMixin): CompositeItem {
  if (item.itemType == ItemType.Composite) { return item as CompositeItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a composite.`);
}
