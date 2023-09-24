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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxType, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, Vector, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemTypeMixin, ItemType } from './base/item';
import { TitledItem } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { DesktopStoreContextModel, PopupType } from '../store/DesktopStoreProvider';
import { UserStoreContextModel } from '../store/UserStoreProvider';
import { PositionalMixin } from './base/positional-item';
import { VisualElement, VisualElementFlags, VeFns } from '../layout/visual-element';
import { getHitInfo } from '../mouse/hit';
import { VesCache } from '../layout/ves-cache';
import { PermissionFlags, PermissionFlagsMixin } from './base/permission-flags-item';
import { calcBoundsInCell, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { switchToPage } from '../layout/navigation';
import { arrange } from '../layout/arrange';


export const ArrangeAlgorithm = {
  SpatialStretch: "spatial-stretch",
  Grid: "grid",
  List: "list"
};

export interface PageItem extends PageMeasurable, XSizableItem, ContainerItem, AttachmentsItem, TitledItem, PermissionFlagsMixin, Item {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  backgroundColorIndex: number;
  arrangeAlgorithm: string;
  gridNumberOfColumns: number;
  popupPositionGr: Vector;
  popupAlignmentPoint: string;
  popupWidthGr: number;

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


export const PageFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): PageItem => {
    return ({
      itemType: ItemType.Page,
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
      arrangeAlgorithm: ArrangeAlgorithm.SpatialStretch,
      popupPositionGr: { x: 30.0 * GRID_SIZE, y: 15.0 * GRID_SIZE },
      popupAlignmentPoint: "center",
      popupWidthGr: 10.0 * GRID_SIZE,
      gridNumberOfColumns: 6,
  
      orderChildrenBy: "title[ASC]",
  
      permissionFlags: PermissionFlags.None,
  
      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,
    
      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,
      pendingPopupAlignmentPoint: null,
    });
  },

  fromObject: (o: any): PageItem => {
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
  
      permissionFlags: o.permissionFlags,
  
      computed_children: [],
      computed_attachments: [],
  
      childrenLoaded: false,
  
      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,
      pendingPopupAlignmentPoint: null,
    });
  },

  toObject: (p: PageItem): object => {
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
  
      permissionFlags: p.permissionFlags,
    });
  },

  calcSpatialDimensionsBl: (page: PageMeasurable): Dimensions => {
    let bh = Math.round(page.spatialWidthGr / GRID_SIZE / page.naturalAspect * 2.0) / 2.0;
    return { w: page.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
  },

  calcInnerSpatialDimensionsBl: (page: PageMeasurable): Dimensions => {
    return ({
      w: page.innerSpatialWidthGr / GRID_SIZE,
      h: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect)
    });
  },

  calcGeometry_Spatial: (page: PageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const boundsPx = {
      x: (page.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
      y: (page.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
      w: PageFns.calcSpatialDimensionsBl(page).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
      h: PageFns.calcSpatialDimensionsBl(page).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const popupClickBoundsPx = parentIsPopup
    ? cloneBoundingBox(innerBoundsPx)!
    : { x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
        w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0 };
    return ({
      boundsPx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxType.Move, innerBoundsPx),
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.OpenPopup, popupClickBoundsPx),
        HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ],
    });
  },

  calcGeometry_InComposite: (_measurable: PageMeasurable, _blockSizePx: Dimensions, _compositeWidthBl: number, _topPx: number): ItemGeometry => {
    panic();
  },

  calcGeometry_Attachment: (page: PageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(page, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_page: PageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry => {
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
        HitboxFns.create(HitboxType.Click, clickAreaBoundsPx),
        HitboxFns.create(HitboxType.OpenPopup, popupClickAreaBoundsPx),
        HitboxFns.create(HitboxType.Move, innerBoundsPx)
      ]
    });
  },

  calcGeometry_Cell: (page: PageMeasurable, cellBoundsPx: BoundingBox): ItemGeometry => {
    const sizeBl = PageFns.calcSpatialDimensionsBl(page);
    const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const popupClickBoundsPx =
      { x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
        w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0 };
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      hitboxes: [
        HitboxFns.create(HitboxType.Click, innerBoundsPx),
        HitboxFns.create(HitboxType.OpenPopup, popupClickBoundsPx),
      ]
    });
  },

  asPageMeasurable: (item: ItemTypeMixin): PageMeasurable => {
    if (item.itemType == ItemType.Page) { return item as PageMeasurable; }
    panic();
  },

  calcBlockPositionGr: (desktopStore: DesktopStoreContextModel, page: PageItem, desktopPosPx: Vector): Vector => {
    const hbi = getHitInfo(desktopStore, desktopPosPx, [], false);
    const propX = (desktopPosPx.x - hbi.overElementVes.get().boundsPx.x) / hbi.overElementVes.get().boundsPx.w;
    const propY = (desktopPosPx.y - hbi.overElementVes.get().boundsPx.y) / hbi.overElementVes.get().boundsPx.h;
    return ({
      x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
      y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
    });
  },

  handleClick: (visualElement: VisualElement, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
    switchToPage(desktopStore, userStore, VeFns.veidFromVe(visualElement), true);
  },

  handlePopupClick: (visualElement: VisualElement, desktopStore: DesktopStoreContextModel, _userStore: UserStoreContextModel): void => {
    const parentItem = VesCache.get(visualElement.parentPath!)!.get().displayItem;
    if ((visualElement.flags & VisualElementFlags.LineItem) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
      desktopStore.setSelectedListPageItem(VeFns.veidFromPath(visualElement.parentPath!), VeFns.veToPath(visualElement));
    } else if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
      desktopStore.pushPopup({ type: PopupType.Page, vePath: VeFns.veToPath(visualElement) });
    } else {
      desktopStore.replacePopup({ type: PopupType.Page, vePath: VeFns.veToPath(visualElement) });
    }
    arrange(desktopStore);
  },

  cloneMeasurableFields: (page: PageMeasurable): PageMeasurable => {
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
  },

  debugSummary: (pageItem: PageItem) => {
    return "[page] " + pageItem.title;
  },

  getPopupPositionGr: (pageItem: PageItem): Vector => {
    if (pageItem.pendingPopupPositionGr != null) {
      return pageItem.pendingPopupPositionGr;
    }
    return pageItem.popupPositionGr;
  },

  getPopupWidthGr: (pageItem: PageItem): number => {
    if (pageItem.pendingPopupWidthGr != null) {
      return pageItem.pendingPopupWidthGr;
    }
    return pageItem.popupWidthGr;
  },

  popupPositioningHasChanged: (pageItem: PageItem): boolean => {
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
  },

  getFingerprint: (pageItem: PageItem): string => {
    return pageItem.backgroundColorIndex + "~~~!@#~~~" + pageItem.title + "~~!@#~~~" + pageItem.arrangeAlgorithm;
  }
};


export function isPage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Page;
}

export function asPageItem(item: ItemTypeMixin): PageItem {
  if (item.itemType == ItemType.Page) { return item as PageItem; }
  panic();
}
