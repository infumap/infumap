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

import { HEADER_HEIGHT_BL } from "../../../components/items/Table";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE } from "../../../constants";
import { zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { VisualElementSignal, createBooleanSignal, createVisualElementSignal } from "../../../util/signals";
import { Uid } from "../../../util/uid";
import { DesktopStoreContextModel, visualElementsWithId } from "../DesktopStoreProvider";
import { isAttachmentsItem } from "../items/base/attachments-item";
import { ITEM_TYPE_PAGE, ITEM_TYPE_TABLE } from "../items/base/item";
import { calcGeometryOfItemInPage, calcGeometryOfItemInTable } from "../items/base/item-polymorphism";
import { asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { asTableItem, isTable } from "../items/table-item";
import { VisualElement } from "../visual-element";
import { arrange } from "./arrange";
import { initiateLoadChildItemsIfNotLoaded } from "./load";


export const rearrangeVisualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid): void => {
  const ves = visualElementsWithId(desktopStore, id);
  ves.forEach(ve => { rearrangeVisualElement(desktopStore, ve); });
}

export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void => {
  const ve = visualElementSignal.get();
  if (desktopStore.topLevelPageId() == ve.itemId) {
    arrange(desktopStore);
    return;
  }

  if (isTable(ve)) {
    rearrangeTable(desktopStore, visualElementSignal);
  } else if (isPage(ve)) {
    rearrangePage(desktopStore, visualElementSignal);
  } else {
    rearrangeItem(desktopStore, visualElementSignal);
  }
}

export const rearrangeItem = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) { throw new Error(`item ${ve.get().itemId} has no parent.`); }

  const parentVisualElement = parent!.get();
  const currentPage = asPageItem(desktopStore.getItem(parentVisualElement.itemId)!);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = zeroBoundingBoxTopLeft(parentVisualElement.childAreaBoundsPx!);

  const childId = ve.get().itemId;
  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);

  const itemVisualElement: VisualElement = {
    itemType: ve.get().itemType,
    itemId: childId,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: null,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };

  ve.set(itemVisualElement);
}

export const rearrangeTable = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) { throw new Error(`table ${ve.get().itemId} has no parent.`); }

  const parentVisualElement = parent!.get();
  const currentPage = asPageItem(desktopStore.getItem(parentVisualElement.itemId)!);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = zeroBoundingBoxTopLeft(parentVisualElement.childAreaBoundsPx!);

  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, currentPageBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);
  let tableItem = asTableItem(childItem);

  const sizeBl = { w: tableItem.spatialWidthGr.get() / GRID_SIZE, h: tableItem.spatialHeightGr.get() / GRID_SIZE };
  const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };

  let childAreaBoundsPx = (() => {
    const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
    return {
      x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
      w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
    };
  })();

  let tableVisualElement: VisualElement = {
    itemType: ITEM_TYPE_TABLE,
    itemId: tableItem.id,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  }

  tableVisualElement.children = (() => {
    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.get().length; ++idx) {
      const childId = tableItem.computed_children.get()[idx];
      const childItem = desktopStore.getItem(childId)!;
      const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

      let tableItemVisualElement: VisualElement = {
        itemType: childItem.itemType,
        itemId: childItem.id,
        isInteractive: true,
        isPopup: false,
        resizingFromBoundsPx: null,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        children: [],
        attachments: [],
        childAreaBoundsPx: null,
        parent: ve,
        computed_mouseIsOver: createBooleanSignal(false),
        computed_movingItemIsOver: createBooleanSignal(false),
      };
      tableVeChildren.push(createVisualElementSignal(tableItemVisualElement));
      // let attachments: Array<VisualElementSignal> = [];

      if (isAttachmentsItem(childItem)) {
        // TODO.
      }
    };
    return tableVeChildren;
  })();

  ve.set(tableVisualElement);
}

export const rearrangePage = (desktopStore: DesktopStoreContextModel, ve: VisualElementSignal) => {
  const parent = ve.get().parent;
  if (parent == null) {
    console.log("TODO: not rearranging page because parent is null");
    return;
  }

  const parentVisualElement = parent!.get();
  const parentItem = desktopStore.getItem(parentVisualElement.itemId)!;
  if (!isPage(parentItem)) {
    return;
  }
  const currentPage = asPageItem(parentItem);
  const currentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(currentPage);
  const currentPageBoundsPx = parentVisualElement.childAreaBoundsPx!;
  const innerBoundsPx = zeroBoundingBoxTopLeft(currentPageBoundsPx);

  const childId = ve.get().itemId;
  const childItem = desktopStore.getItem(ve.get().itemId)!;
  const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, currentPageInnerDimensionsBl, true, desktopStore.getItem);

  const pageVisualElement: VisualElement = {
    itemType: ITEM_TYPE_PAGE,
    itemId: childId,
    isInteractive: true,
    isPopup: false,
    resizingFromBoundsPx: null,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes: geometry.hitboxes,
    children: [],
    attachments: [],
    parent,
    computed_mouseIsOver: createBooleanSignal(false),
    computed_movingItemIsOver: createBooleanSignal(false),
  };

  if (// Page children are visible.
      // This test does not depend on pixel size, so is invariant over display devices.
      asPageItem(childItem).spatialWidthGr.get() / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    const pageItem = asPageItem(childItem);
    initiateLoadChildItemsIfNotLoaded(desktopStore, pageItem.id);

    const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem);
    const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    // TODO (MEDIUM): If these already exist, they don't need to be replaced, only updated.
    pageVisualElement.children = pageItem.computed_children.get().map(childId => {
      const childItem = desktopStore.getItem(childId)!;
      const geometry = calcGeometryOfItemInPage(childItem, innerBoundsPx, innerDimensionsBl, false, desktopStore.getItem);
      const childVisualElement: VisualElement = {
        itemType: childItem.itemType,
        itemId: childItem.id,
        isInteractive: false,
        isPopup: false,
        resizingFromBoundsPx: null,
        boundsPx: geometry.boundsPx,
        childAreaBoundsPx: null,
        hitboxes: [],
        children: [],
        attachments: [],
        parent: ve,
        computed_mouseIsOver: createBooleanSignal(false),
        computed_movingItemIsOver: createBooleanSignal(false),
      };
      return createVisualElementSignal(childVisualElement);
    });
  }

  ve.set(pageVisualElement);
}

