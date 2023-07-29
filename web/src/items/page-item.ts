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

import { ATTACH_AREA_SIZE_PX, GRID_PAGE_CELL_ASPECT, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxType, createHitbox } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, Vector, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemTypeMixin, ITEM_TYPE_PAGE } from './base/item';
import { TitledItem } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { UserStoreContextModel } from '../store/UserStoreProvider';
import { PositionalMixin } from './base/positional-item';
import { ARRANGE_ALGO_GRID, ARRANGE_ALGO_LIST, ARRANGE_ALGO_SPATIAL_STRETCH, arrange, currentVesCache, switchToPage } from '../layout/arrange';
import { createNumberSignal, NumberSignal } from '../util/signals';
import { VisualElement, lineItemFlagSet, pagePopupFlagSet } from '../layout/visual-element';
import { getHitInfo } from '../mouse/hitInfo';
import { itemStore } from '../store/ItemStore';
import { PopupType, breadcrumbStore } from '../store/BreadcrumbStore';


export interface PageItem extends PageMeasurable, XSizableItem, ContainerItem, AttachmentsItem, TitledItem, Item {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  backgroundColorIndex: number;
  arrangeAlgorithm: string;
  popupPositionGr: Vector;
  popupAlignmentPoint: string;
  popupWidthGr: number;
  gridNumberOfColumns: number;

  scrollXPx: NumberSignal;
  scrollYPx: NumberSignal;

  selectedItem: Uid;

  pendingPopupPositionGr: Vector | null;
  pendingPopupWidthGr: number | null;
  pendingPopupAlignmentPoint: string | null;
}

export interface PageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  arrangeAlgorithm: string;
  id: Uid;
  childrenLoaded: boolean;
  gridNumberOfColumns: number;
  computed_children: Array<Uid>;
}


export function newPageItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): PageItem {
  return ({
    itemType: ITEM_TYPE_PAGE,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    title,
    spatialPositionGr: { x: 0.0, y: 0.0 },

    spatialWidthGr: 4.0 * GRID_SIZE,

    innerSpatialWidthGr: 60.0 * GRID_SIZE,
    naturalAspect: 2.0,
    backgroundColorIndex: 0,
    arrangeAlgorithm: ARRANGE_ALGO_SPATIAL_STRETCH,
    popupPositionGr: { x: 30.0 * GRID_SIZE, y: 15.0 * GRID_SIZE },
    popupAlignmentPoint: "center",
    popupWidthGr: 10.0 * GRID_SIZE,
    gridNumberOfColumns: 6,

    orderChildrenBy: "title[ASC]",

    computed_children: [],
    computed_attachments: [],
    childrenLoaded: false,
  
    scrollXPx: createNumberSignal(0),
    scrollYPx: createNumberSignal(0),
    selectedItem: EMPTY_UID,
    pendingPopupPositionGr: null,
    pendingPopupWidthGr: null,
    pendingPopupAlignmentPoint: null,
  });
}

export function pageFromObject(o: any): PageItem {
  // TODO: dynamic type check of o.
  return ({
    itemType: o.itemType,
    ownerId: o.ownerId,
    id: o.id,
    parentId: o.parentId ? o.parentId : null,
    relationshipToParent: o.relationshipToParent,
    creationDate: o.creationDate,
    lastModifiedDate: o.lastModifiedDate,
    ordering: new Uint8Array(o.ordering),
    title: o.title,
    spatialPositionGr: o.spatialPositionGr,

    spatialWidthGr: o.spatialWidthGr,

    innerSpatialWidthGr: o.innerSpatialWidthGr,
    naturalAspect: o.naturalAspect,
    backgroundColorIndex: o.backgroundColorIndex,
    arrangeAlgorithm: o.arrangeAlgorithm,
    popupPositionGr: o.popupPositionGr,
    popupAlignmentPoint: o.popupAlignmentPoint,
    popupWidthGr: o.popupWidthGr,
    gridNumberOfColumns: o.gridNumberOfColumns,

    orderChildrenBy: o.orderChildrenBy,

    computed_children: [],
    computed_attachments: [],

    childrenLoaded: false,

    scrollXPx: createNumberSignal(0),
    scrollYPx: createNumberSignal(0),
    selectedItem: EMPTY_UID,
    pendingPopupPositionGr: null,
    pendingPopupWidthGr: null,
    pendingPopupAlignmentPoint: null,
  });
}

export function pageToObject(p: PageItem): object {
  return ({
    itemType: p.itemType,
    ownerId: p.ownerId,
    id: p.id,
    parentId: p.parentId == EMPTY_UID ? null : p.parentId,
    relationshipToParent: p.relationshipToParent,
    creationDate: p.creationDate,
    lastModifiedDate: p.lastModifiedDate,
    ordering: Array.from(p.ordering),
    title: p.title,
    spatialPositionGr: p.spatialPositionGr,

    spatialWidthGr: p.spatialWidthGr,

    innerSpatialWidthGr: p.innerSpatialWidthGr,
    naturalAspect: p.naturalAspect,
    backgroundColorIndex: p.backgroundColorIndex,
    arrangeAlgorithm: p.arrangeAlgorithm,
    popupPositionGr: p.popupPositionGr,
    popupAlignmentPoint: p.popupAlignmentPoint,
    popupWidthGr: p.popupWidthGr,
    gridNumberOfColumns: p.gridNumberOfColumns,

    orderChildrenBy: p.orderChildrenBy,
  });
}


export function calcPageSizeForSpatialBl(page: PageMeasurable): Dimensions {
  if (page.arrangeAlgorithm == ARRANGE_ALGO_GRID) {
    if (page.childrenLoaded) {
      const numCols = page.gridNumberOfColumns;
      const numRows = Math.ceil(page.computed_children.length / numCols);
      const cellWGr = page.spatialWidthGr / numCols;
      const cellHGr = cellWGr * (1.0/GRID_PAGE_CELL_ASPECT);
      const pageHeightGr = cellHGr * numRows;
      const pageHeightBl = Math.ceil(pageHeightGr / GRID_SIZE);
      return { w: page.spatialWidthGr / GRID_SIZE, h: pageHeightBl < 1.0 ? 1.0 : pageHeightBl };
    }
    return { w: page.spatialWidthGr / GRID_SIZE, h: 0.5 };
  } else {
    let bh = Math.round(page.spatialWidthGr / GRID_SIZE / page.naturalAspect * 2.0) / 2.0;
    return { w: page.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
  }
}


export function calcPageInnerSpatialDimensionsBl(page: PageMeasurable): Dimensions {
  return ({
    w: page.innerSpatialWidthGr / GRID_SIZE,
    h: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect)
  });
}


export function calcGeometryOfPageItem_Desktop(page: PageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  const boundsPx = {
    x: (page.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (page.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcPageSizeForSpatialBl(page).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: calcPageSizeForSpatialBl(page).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  const popupClickBoundsPx = parentIsPopup
  ? cloneBoundingBox(innerBoundsPx)!
  : { x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
      w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0 };
  return ({
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      createHitbox(HitboxType.Move, innerBoundsPx),
      createHitbox(HitboxType.Click, innerBoundsPx),
      createHitbox(HitboxType.OpenPopup, popupClickBoundsPx),
      createHitbox(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      createHitbox(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
    ],
  });
}


export function calcGeometryOfPageItem_Attachment(page: PageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(page, parentBoundsPx, parentInnerSizeBl, index, isSelected);
}


export function calcGeometryOfPageItem_ListItem(_page: PageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  const popupClickAreaBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: blockSizePx.w,
    h: blockSizePx.h
  };
  const clickAreaBoundsPx = {
    x: blockSizePx.w,
    y: 0.0,
    w: blockSizePx.w * (widthBl - 1),
    h: blockSizePx.h
  };
  return ({
    boundsPx,
    hitboxes: [
      createHitbox(HitboxType.Click, clickAreaBoundsPx),
      createHitbox(HitboxType.OpenPopup, popupClickAreaBoundsPx),
      createHitbox(HitboxType.Move, innerBoundsPx)
    ]
  });
}


export function calcGeometryOfPageItem_Cell(_page: PageMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [
      createHitbox(HitboxType.Click, zeroBoundingBoxTopLeft(cellBoundsPx))
    ]
  });
}


export function isPage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_PAGE;
}

export function asPageItem(item: ItemTypeMixin): PageItem {
  if (item.itemType == ITEM_TYPE_PAGE) { return item as PageItem; }
  panic();
}

export function asPageMeasurable(item: ItemTypeMixin): PageMeasurable {
  if (item.itemType == ITEM_TYPE_PAGE) { return item as PageMeasurable; }
  panic();
}


export const calcBlockPositionGr = (desktopStore: DesktopStoreContextModel, page: PageItem, desktopPosPx: Vector): Vector => {
  const hbi = getHitInfo(desktopStore, desktopPosPx, [], false);
  const propX = (desktopPosPx.x - hbi.overElementVes.get().boundsPx.x) / hbi.overElementVes.get().boundsPx.w;
  const propY = (desktopPosPx.y - hbi.overElementVes.get().boundsPx.y) / hbi.overElementVes.get().boundsPx.h;
  return ({
    x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
    y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
  });
}


export function handlePageClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel, _userStore: UserStoreContextModel): void {
  const parentItem = itemStore.getItem(visualElement.displayItem.parentId)!
  if (lineItemFlagSet(visualElement) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    const parentPage = asPageItem(parentItem);
    parentPage.selectedItem = visualElement.displayItem.id;
    arrange(desktopStore);
    return;
  }

  switchToPage(desktopStore, visualElement.displayItem.id);
}


export function handlePagePopupClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel, _userStore: UserStoreContextModel): void {
  const parentItem = itemStore.getItem(visualElement.displayItem.parentId)!;
  if (lineItemFlagSet(visualElement) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    const parentPage = asPageItem(parentItem);
    parentPage.selectedItem = visualElement.displayItem.id;
  } else if (pagePopupFlagSet(currentVesCache.get(visualElement.parentPath!)!.get())) {
    breadcrumbStore.pushPopup({ type: PopupType.Page, uid: visualElement.displayItem.id, vePath: null });
  } else {
    breadcrumbStore.replacePopup({ type: PopupType.Page, uid: visualElement.displayItem.id, vePath: null });
  }
  arrange(desktopStore);
}


export function clonePageMeasurableFields(page: PageMeasurable): PageMeasurable {
  return ({
    itemType: page.itemType,
    id: page.id,
    spatialPositionGr: page.spatialPositionGr,
    spatialWidthGr: page.spatialWidthGr,
    naturalAspect: page.naturalAspect,
    innerSpatialWidthGr: page.innerSpatialWidthGr,
    arrangeAlgorithm: page.arrangeAlgorithm,
    gridNumberOfColumns: page.gridNumberOfColumns,
    childrenLoaded: page.childrenLoaded,
    computed_children: page.computed_children,
  });
}


export function pageDebugSummary(pageItem: PageItem) {
  return "[page] " + pageItem.title;
}


export function getPopupPositionGr(pageItem: PageItem): Vector {
  if (pageItem.pendingPopupPositionGr != null) {
    return pageItem.pendingPopupPositionGr;
  }
  return pageItem.popupPositionGr;
}


export function getPopupWidthGr(pageItem: PageItem): number {
  if (pageItem.pendingPopupWidthGr != null) {
    return pageItem.pendingPopupWidthGr;
  }
  return pageItem.popupWidthGr;
}


export function popupPositioningHasChanged(pageItem: PageItem): boolean {
  if (pageItem.pendingPopupPositionGr != null) {
    if (pageItem.pendingPopupPositionGr!.x != pageItem.popupPositionGr.x ||
        pageItem.pendingPopupPositionGr!.y != pageItem.popupPositionGr.y) {
      return true;
    }
  }
  if (pageItem.pendingPopupWidthGr != null) {
    if (pageItem.pendingPopupWidthGr != pageItem.popupWidthGr) {
      return true;
    }
  }
  return false;
}
