/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { GRID_SIZE, RESIZE_BOX_SIZE_PX } from '../../../constants';
import { HitboxType } from '../hitbox';
import { BoundingBox, cloneBoundingBox, cloneVector, Dimensions, Vector, zeroTopLeft } from '../../../util/geometry';
import { currentUnixTimeSeconds, panic } from '../../../util/lang';
import { newUid, Uid } from '../../../util/uid';
import { AttachmentsItem } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemTypeMixin, ITEM_TYPE_PAGE } from './base/item';
import { TitledItem } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../item-geometry';
import { batch } from 'solid-js';
import { DesktopStoreContextModel } from '../DesktopStoreProvider';
import { UserStoreContextModel } from '../../UserStoreProvider';
import { PositionalMixin } from './base/positional-item';
import { newLinkItem } from './link-item';
import { newOrdering } from '../../../util/ordering';
import { Child } from '../relationship-to-parent';
import { arrange, switchToPage } from '../layout/arrange';
import { createBooleanSignal, createNumberSignal, createUidArraySignal, createVectorSignal, NumberSignal } from '../../../util/signals';


export interface PageItem extends PageMeasurable, XSizableItem, ContainerItem, AttachmentsItem, TitledItem, Item {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  backgroundColorIndex: number;
  arrangeAlgorithm: string;
  popupPositionGr: Vector;
  popupAlignmentPoint: string;
  popupWidthGr: number;

  scrollXPx: NumberSignal;
  scrollYPx: NumberSignal;
}

export interface PageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin {
  innerSpatialWidthGr: number;
  naturalAspect: number;
}


export function newPageItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): PageItem {
  return {
    itemType: ITEM_TYPE_PAGE,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    title,
    spatialPositionGr: createVectorSignal({ x: 0.0, y: 0.0 }),

    spatialWidthGr: 4.0 * GRID_SIZE,

    innerSpatialWidthGr: 60.0 * GRID_SIZE,
    naturalAspect: 2.0,
    backgroundColorIndex: 0,
    arrangeAlgorithm: "spatial-stretch",
    popupPositionGr: { x: 30.0 * GRID_SIZE, y: 15.0 * GRID_SIZE },
    popupAlignmentPoint: "center",
    popupWidthGr: 10.0 * GRID_SIZE,

    computed_children: createUidArraySignal([]),
    computed_attachments: createUidArraySignal([]),
    computed_movingItemIsOver: createBooleanSignal(false),
    computed_mouseIsOver: createBooleanSignal(false),

    scrollXPx: createNumberSignal(0),
    scrollYPx: createNumberSignal(0),
  };
}

export function pageFromObject(o: any): PageItem {
  // TODO: dynamic type check of o.
  return ({
    itemType: o.itemType,
    ownerId: o.ownerId,
    id: o.id,
    parentId: o.parentId,
    relationshipToParent: o.relationshipToParent,
    creationDate: o.creationDate,
    lastModifiedDate: o.lastModifiedDate,
    ordering: new Uint8Array(o.ordering),
    title: o.title,
    spatialPositionGr: createVectorSignal(o.spatialPositionGr),

    spatialWidthGr: o.spatialWidthGr,

    innerSpatialWidthGr: o.innerSpatialWidthGr,
    naturalAspect: o.naturalAspect,
    backgroundColorIndex: o.backgroundColorIndex,
    arrangeAlgorithm: o.arrangeAlgorithm,
    popupPositionGr: o.popupPositionGr,
    popupAlignmentPoint: o.popupAlignmentPoint,
    popupWidthGr: o.popupWidthGr,

    computed_children: createUidArraySignal([]),
    computed_attachments: createUidArraySignal([]),

    computed_movingItemIsOver: createBooleanSignal(false),
    computed_mouseIsOver: createBooleanSignal(false),

    scrollXPx: createNumberSignal(0),
    scrollYPx: createNumberSignal(0),
  });
}

export function pageToObject(p: PageItem): object {
  return ({
    itemType: p.itemType,
    ownerId: p.ownerId,
    id: p.id,
    parentId: p.parentId,
    relationshipToParent: p.relationshipToParent,
    creationDate: p.creationDate,
    lastModifiedDate: p.lastModifiedDate,
    ordering: Array.from(p.ordering),
    title: p.title,
    spatialPositionGr: p.spatialPositionGr.get(),

    spatialWidthGr: p.spatialWidthGr,

    innerSpatialWidthGr: p.innerSpatialWidthGr,
    naturalAspect: p.naturalAspect,
    backgroundColorIndex: p.backgroundColorIndex,
    arrangeAlgorithm: p.arrangeAlgorithm,
    popupPositionGr: p.popupPositionGr,
    popupAlignmentPoint: p.popupAlignmentPoint,
    popupWidthGr: p.popupWidthGr,
  });
}


export function calcPageSizeForSpatialBl(page: PageMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  let bh = Math.round(page.spatialWidthGr / GRID_SIZE / page.naturalAspect * 2.0) / 2.0;
  return { w: page.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
}


export function calcPageInnerSpatialDimensionsBl(page: PageMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  return {
    w: page.innerSpatialWidthGr / GRID_SIZE,
    h: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect)
  };
}


export function calcGeometryOfPageItem(page: PageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (page.spatialPositionGr.get().x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (page.spatialPositionGr.get().y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcPageSizeForSpatialBl(page, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcPageSizeForSpatialBl(page, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  const popupClickBoundsPx = {
    x: boundsPx.w / 3.0,
    y: boundsPx.h / 3.0,
    w: boundsPx.w / 3.0,
    h: boundsPx.h / 3.0,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.OpenPopup, boundsPx: popupClickBoundsPx },
      { type: HitboxType.Resize,
        boundsPx: { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  };
}


export function calcGeometryOfPageAttachmentItem(_page: PageMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: containerBoundsPx.w - (20 * index),
    y: -5,
    w: 15,
    h: 10,
  };
  return {
    boundsPx,
    hitboxes: [],
  }
}


export function calcGeometryOfPageItemInTable(_page: PageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) },
    ],
  };
}


export function calcGeometryOfPageItemInCell(_page: PageMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(cellBoundsPx) },
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


export const calcBlockPositionGr = (page: PageItem, desktopPosPx: Vector): Vector => {
  // let propX = (desktopPosPx.x - page.computed_geometry[page.parentId].boundsPx.x) / page.computed_geometry[page.parentId].boundsPx.w!;
  // let propY = (desktopPosPx.y - page.computed_geometry[page.parentId].boundsPx.y) / page.computed_geometry[page.parentId].boundsPx.h!;
  // return {
  //   x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
  //   y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
  // };
  return ({
    x: 0,
    y: 0,
  });
}


export function handlePageClick(pageItem: PageItem, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  switchToPage(desktopStore, pageItem.id, userStore.getUser());
}


export function handlePagePopupClick(pageItem: PageItem, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  batch(() => {
    let li = newLinkItem(pageItem.ownerId, pageItem.parentId, Child, newOrdering(), pageItem.id);
    li.spatialWidthGr = 20 * GRID_SIZE;
    desktopStore.addItem(li);
  });
}


export function clonePageMeasurableFields(page: PageMeasurable): PageMeasurable {
  return ({
    itemType: page.itemType,
    spatialPositionGr: page.spatialPositionGr,
    spatialWidthGr: page.spatialWidthGr,
    naturalAspect: page.naturalAspect,
    innerSpatialWidthGr: page.innerSpatialWidthGr,
  });
}
