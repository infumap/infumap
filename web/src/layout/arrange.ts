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

import { batch } from "solid-js";
import { HEADER_HEIGHT_BL } from "../components/items/Table";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE } from "../constants";
import { Uid } from "../util/uid";
import { DesktopStoreContextModel, visualElementsWithId } from "../store/DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ITEM_TYPE_LINK, Item } from "../items/base/item";
import { calcGeometryOfAttachmentItem, calcGeometryOfItemInCell, calcGeometryOfItemInPage, calcGeometryOfItemInTable, calcSizeForSpatialBl } from "../items/base/item-polymorphism";
import { PageItem, asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { TableItem, asTableItem, isTable } from "../items/table-item";
import { createVisualElement } from "./visual-element";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { LinkItem, asLinkItem, isLink, newLinkItem } from "../items/link-item";
import { ItemGeometry } from "./item-geometry";
import { Child } from "./relationship-to-parent";
import { newOrdering } from "../util/ordering";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { panic } from "../util/lang";
import { initiateLoadChildItemsIfNotLoaded } from "./load";
import { mouseMoveNoButtonDownHandler } from "../mouse/mouse";
import { newUid } from "../util/uid";


const POPUP_LINK_ID = newUid();


export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid) => {
  batch(() => {
    desktopStore.pushTopLevelPageId(id);
    var page = asPageItem(desktopStore.getItem(id)!);
    // TODO (HIGH): get rid of this horrible hack!
    let desktopEl = window.document.getElementById("desktop")!;
    if (desktopEl) {
      desktopEl.scrollTop = 0;
      desktopEl.scrollLeft = 0;
    }
    // TODO (MEDIUM): retain these.
    page.scrollXPx.set(0);
    page.scrollYPx.set(0);
    arrange(desktopStore);
  });
}


/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never called directly). The arrange function in this implementation did include (nested)
 * visual element signals though, which had dependencies on the relevant part of the item state. All the items
 * were solidjs signals. This approach was simpler from the point of view that the visual elements did not need
 * to be imperatively updated / managed. However, the functional approach turned out to be a dead end:
 * 1. It was effectively impossible to perfectly optimize it in the case of, for example, resizing pages because
 *    the children were a function of page size. By comparison, as a general comment, the stateful approach makes
 *    it easy(er) to make precisely the optimal updates at precisely the required times.
 * 2. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", I think the code is simpler to work on due to this.
 */
export const arrange = (desktopStore: DesktopStoreContextModel): void => {
  if (desktopStore.topLevelPageId() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, desktopStore.topLevelPageId()!);
  let currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  if (currentPage.arrangeAlgorithm == "grid") {
    arrange_grid(desktopStore);
  } else {
    arrange_spatialStretch(desktopStore);
  }
  mouseMoveNoButtonDownHandler(desktopStore);
}


const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel) => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = currentPage.naturalAspect;
  const topLevelPageBoundsPx = (() => {
    let result = desktopStore.desktopBoundsPx();
    // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
    if (pageAspect / desktopAspect > 1.25) {
      // page to scroll horizontally.
      result.w = Math.round(result.h * pageAspect);
    } else if (pageAspect / desktopAspect < 0.75) {
      // page needs to scroll vertically.
      result.h = Math.round(result.w / pageAspect);
    }
    return result;
  })();

  const topLevelVisualElement = createVisualElement({
    item: currentPage,
    isInteractive: true,
    isDragOverPositioning: true,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
  });

  topLevelVisualElement.children = currentPage.computed_children
    .map(childId => arrangeItemOnPage(
      desktopStore,
      desktopStore.getItem(childId)!,
      topLevelPageBoundsPx,
      { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
      false, false));

  let popupId = desktopStore.popupId();
  if (popupId != null) {
    let li = newLinkItem(currentPage.ownerId, currentPage.id, Child, newOrdering(), popupId);
    li.id = POPUP_LINK_ID;
    let widthGr = Math.round((currentPage.innerSpatialWidthGr / GRID_SIZE) / 2.0) * GRID_SIZE;
    let heightGr = Math.round((currentPage.innerSpatialWidthGr / currentPage.naturalAspect / GRID_SIZE)/ 2.0) * GRID_SIZE;
    li.spatialWidthGr = widthGr;
    li.spatialPositionGr = { x: Math.round((widthGr / GRID_SIZE) / 2.0) * GRID_SIZE, y: ((heightGr / GRID_SIZE) / 2.0) * GRID_SIZE };
    topLevelVisualElement.children.push(
      arrangeItemOnPage(
        desktopStore,
        li,
        topLevelPageBoundsPx,
        { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
        false, true));
  }

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}


enum RenderStyle {
  Full,
  InsidePopup,
  Placeholder,
}


export const arrangeItemOnPage = (
    desktopStore: DesktopStoreContextModel,
    item: Item,
    containerBoundsPx: BoundingBox,
    parentSignalUnderConstruction: VisualElementSignal, // used to establish back references only, not called.
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {

  if (isPopup) {
    if (!isLink(item)) {
      panic();
    }
  }

  const parent = asPageItem(desktopStore.getItem(item.parentId)!);
  const pageBoundsPx = zeroBoundingBoxTopLeft(containerBoundsPx);
  const pageInnerPageDimensionsBl = calcPageInnerSpatialDimensionsBl(parent);

  const geometry = calcGeometryOfItemInPage(item, pageBoundsPx, pageInnerPageDimensionsBl, true, parentIsPopup, desktopStore.getItem);

  let spatialWidthGr = isXSizableItem(item)
    ? asXSizableItem(item).spatialWidthGr
    : 0;

  let linkItemMaybe: LinkItem | null = null;
  if (item.itemType == ITEM_TYPE_LINK) {
    linkItemMaybe = asLinkItem(item);
    item = desktopStore.getItem(linkItemMaybe.linkToId)!;
    if (isXSizableItem(item)) {
      spatialWidthGr = linkItemMaybe.spatialWidthGr;
    }
  }

  if (isPage(item) && asPageItem(item).arrangeAlgorithm == "grid") {
    // Always make sure child items of grid pages are loaded, even if not visible,
    // because they are needed to to calculate the height.
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
  }

  if (isPage(item) &&
      // This test does not depend on pixel size, so is invariant over display devices.
      spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangePageWithChildren(desktopStore, asPageItem(item), linkItemMaybe, geometry, parentSignalUnderConstruction, isPopup);
  }

  if (isTable(item) && (item.parentId == desktopStore.topLevelPageId() || parentIsPopup)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangeTable(desktopStore, asTableItem(item), linkItemMaybe, geometry, parentSignalUnderConstruction);
  }

  const renderStyle = parentIsPopup
    ? RenderStyle.InsidePopup
    : item.parentId == desktopStore.topLevelPageId()
      ? RenderStyle.Full
      : RenderStyle.Placeholder;
  return arrangeItemNoChildren(desktopStore, item, linkItemMaybe, geometry, parentSignalUnderConstruction, renderStyle);
}


const arrangeTable = (
    desktopStore: DesktopStoreContextModel,
    tableItem: TableItem,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal): VisualElementSignal => {

  const sizeBl = { w: tableItem.spatialWidthGr / GRID_SIZE, h: tableItem.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: geometry.boundsPx.w / sizeBl.w, h: geometry.boundsPx.h / sizeBl.h };
  const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;

  let childAreaBoundsPx = {
    x: geometry.boundsPx.x, y: geometry.boundsPx.y + headerHeightPx,
    w: geometry.boundsPx.w, h: geometry.boundsPx.h - headerHeightPx
  };

  const tableVisualElement = createVisualElement({
    item: tableItem,
    linkItemMaybe,
    isInteractive: true,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: geometry.hitboxes,
    parent: parentSignalUnderConstruction,
  });
  const tableVisualElementSignal = createVisualElementSignal(tableVisualElement);

  tableVisualElement.children = (() => {
    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.length; ++idx) {
      const childId = tableItem.computed_children[idx];
      const childItem = desktopStore.getItem(childId)!;
      if (isLink(childItem)) { panic(); }  // TODO (MEDIUM).
      const geometry = calcGeometryOfItemInTable(childItem, blockSizePx, idx, 0, sizeBl.w, desktopStore.getItem);

      const tableItemVe = createVisualElement({
        item: childItem,
        isInteractive: true,
        isInsideTable: true,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parent: tableVisualElementSignal,
      });
      const tableItemVisualElementSignal = createVisualElementSignal(tableItemVe);
      tableVeChildren.push(tableItemVisualElementSignal);

      if (isAttachmentsItem(childItem)) {
        let tableItemVeAttachments: Array<VisualElementSignal> = [];
        const attachmentsItem = asAttachmentsItem(childItem);
        let leftBl = tableItem.tableColumns[0].widthGr / GRID_SIZE;
        for (let i=0; i<attachmentsItem.computed_attachments.length; ++i) {
          if (i >= tableItem.tableColumns.length-1) { break; }
          const attachmentId = attachmentsItem.computed_attachments[i];
          const attachmentItem = desktopStore.getItem(attachmentId)!;
          const geometry = calcGeometryOfItemInTable(attachmentItem, blockSizePx, idx, leftBl, sizeBl.w, desktopStore.getItem);
          const tableItemAttachmentVe = createVisualElement({
            item: attachmentItem,
            isInteractive: true,
            isInsideTable: true,
            isAttachment: true,
            boundsPx: geometry.boundsPx,
            hitboxes: geometry.hitboxes,
            parent: tableItemVisualElementSignal,
          });
          tableItemVeAttachments.push(createVisualElementSignal(tableItemAttachmentVe));
          leftBl += tableItem.tableColumns[i+1].widthGr / GRID_SIZE;
        }
        tableItemVe.attachments = tableItemVeAttachments;
      }
    };
    return tableVeChildren;
  })();

  arrangeItemAttachments(desktopStore, tableVisualElementSignal);

  return tableVisualElementSignal;
}


const arrangePageWithChildren = (
    desktopStore: DesktopStoreContextModel,
    pageItem: PageItem,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal,
    isPopup: boolean): VisualElementSignal => {

  const pageWithChildrenVisualElement = createVisualElement({
    item: pageItem,
    linkItemMaybe,
    isInteractive: true,
    isPopup,
    isDragOverPositioning: true,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes: geometry.hitboxes,
    parent: parentSignalUnderConstruction,
  });
  const pageWithChildrenVisualElementSignal = createVisualElementSignal(pageWithChildrenVisualElement);

  const innerDimensionsBl = calcPageInnerSpatialDimensionsBl(pageItem);
  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

  pageWithChildrenVisualElement.children = pageItem.computed_children.map(childId => {
    const innerChildItem = desktopStore.getItem(childId)!;
    if (isLink(innerChildItem)) { panic(); } // TODO
    if (isPopup) {
      return arrangeItemOnPage(desktopStore, innerChildItem, pageWithChildrenVisualElement.childAreaBoundsPx!, pageWithChildrenVisualElementSignal, true, false);
    }
    const geometry = calcGeometryOfItemInPage(innerChildItem, innerBoundsPx, innerDimensionsBl, true, false, desktopStore.getItem);
    return arrangeItemNoChildren(desktopStore, innerChildItem, null, geometry, pageWithChildrenVisualElementSignal, RenderStyle.Placeholder);
  });

  arrangeItemAttachments(desktopStore, pageWithChildrenVisualElementSignal);

  return pageWithChildrenVisualElementSignal;
}


const arrangeItemNoChildren = (
    desktopStore: DesktopStoreContextModel,
    item: Item,
    linkItemMaybe: LinkItem | null,
    geometry: ItemGeometry,
    parentSignalUnderConstruction: VisualElementSignal,
    renderStyle: RenderStyle): VisualElementSignal => {

  const itemVisualElement = createVisualElement({
    item,
    linkItemMaybe,
    isInteractive: renderStyle != RenderStyle.Placeholder,
    boundsPx: geometry.boundsPx,
    hitboxes: geometry.hitboxes,
    parent: parentSignalUnderConstruction,
  });
  const itemVisualElementSignal = createVisualElementSignal(itemVisualElement);

  arrangeItemAttachments(desktopStore, itemVisualElementSignal);

  return itemVisualElementSignal;
}


function arrangeItemAttachments(desktopStore: DesktopStoreContextModel, itemVisualElementSignal: VisualElementSignal) {
  const itemVisualElement = itemVisualElementSignal.get();
  const itemBoundsPx = itemVisualElement.boundsPx;
  const itemSizeBl = calcSizeForSpatialBl(itemVisualElement.item, desktopStore.getItem);

  if (isAttachmentsItem(itemVisualElement.item)) {
    const attachmentsItem = asAttachmentsItem(itemVisualElement.item);
    for (let i=0; i<attachmentsItem.computed_attachments.length; ++i) {
      const attachmentId = attachmentsItem.computed_attachments[i];
      const attachmentItem = desktopStore.getItem(attachmentId)!;
      const attachmentGeometry = calcGeometryOfAttachmentItem(attachmentItem, itemBoundsPx, itemSizeBl, i, desktopStore.getItem);

      const attachmentVisualElement = createVisualElement({
        item: attachmentItem,
        boundsPx: attachmentGeometry.boundsPx,
        hitboxes: attachmentGeometry.hitboxes,
        parent: itemVisualElementSignal,
        isAttachment: true,
      });

      itemVisualElementSignal.get().attachments.push(createVisualElementSignal(attachmentVisualElement));
    }
  }
}


const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const numCols = currentPage.gridNumberOfColumns;
  const numRows = Math.ceil(currentPage.computed_children.length / numCols);
  const colAspect = 1.5;
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = pageBoundsPx.w / numCols * (1.0/colAspect);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx;
  const boundsPx = (() => {
    const result = pageBoundsPx;
    result.h = pageHeightPx;
    return result;
  })();

  const topLevelVisualElement = createVisualElement({
    item: currentPage,
    isInteractive: true,
    isDragOverPositioning: true,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
  });

  topLevelVisualElement.children = (() => {
    const children: Array<VisualElementSignal> = [];
    const childItems = currentPage.computed_children.map(childId => desktopStore.getItem(childId)!);
    for (let i=0; i<childItems.length; ++i) {
      const item = childItems[i];
      const col = i % numCols;
      const row = Math.floor(i / numCols);
      const cellBoundsPx = {
        x: col * cellWPx + marginPx,
        y: row * cellHPx + marginPx,
        w: cellWPx - marginPx * 2.0,
        h: cellHPx - marginPx * 2.0
      };

      let geometry = calcGeometryOfItemInCell(item, cellBoundsPx, desktopStore.getItem);
      if (!isTable(item)) {
        const ve = createVisualElement({
          item,
          isInteractive: true,
          boundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          parent: { get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement },
        });
        children.push(createVisualElementSignal(ve));
      } else {
        console.log("TODO: child tables in grid pages.");
      }
    }
    return children;
  })();

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}

export const rearrangeVisualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid): void => {
  visualElementsWithId(desktopStore, id).forEach(ve => {
    const parentIsPage = ve.get().parent == null || isPage(ve.get().parent!.get().item);
    if (parentIsPage) {
      rearrangeVisualElement(desktopStore, ve);
    } else {
      console.log("TODO: rearrange table children")
    }
  });
}

export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void => {
  const visualElement = visualElementSignal.get();
  if (desktopStore.topLevelPageId() == visualElement.item.id) {
    arrange(desktopStore);
    return;
  }

  if (visualElement.isAttachment) {
    rearrangeAttachment(desktopStore, visualElementSignal);
  } else {
    const item = visualElement.linkItemMaybe != null
      ? visualElement.linkItemMaybe!
      : visualElement.item;
    const rearrangedVisualElement = arrangeItemOnPage(
      desktopStore,
      item,
      visualElement.parent!.get().childAreaBoundsPx!,
      visualElement.parent!,
      visualElement.parent!.get().isPopup,
      visualElement.isPopup).get();
    visualElementSignal.set(rearrangedVisualElement);
  }
}

function rearrangeAttachment(desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal) {
  const visualElement = visualElementSignal.get();
  const parentVisualElement = visualElement.parent!.get();
  let index = -1;
  for (let i=0; i<parentVisualElement.attachments.length; ++i) {
    if (parentVisualElement.attachments[i].get().item == visualElement.item) {
      index = i;
      break;
    }
  }
  if (index == -1) { panic(); }

  const itemSizeBl = calcSizeForSpatialBl(parentVisualElement.item, desktopStore.getItem);
  const attachmentGeometry = calcGeometryOfAttachmentItem(visualElement.item, parentVisualElement.boundsPx, itemSizeBl, index, desktopStore.getItem);
  const attachmentVisualElement = createVisualElement({
    item: visualElement.item,
    boundsPx: attachmentGeometry.boundsPx,
    hitboxes: attachmentGeometry.hitboxes,
    parent: visualElement.parent!,
    isAttachment: true,
  });

  visualElementSignal.set(attachmentVisualElement);
}
