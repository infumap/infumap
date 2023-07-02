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
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_PAGE_CELL_ASPECT, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL } from "../constants";
import { EMPTY_UID, Uid } from "../util/uid";
import { DesktopStoreContextModel, visualElementsWithId } from "../store/DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { EMPTY_ITEM, ITEM_TYPE_LINK, Item } from "../items/base/item";
import { calcGeometryOfItem_Attachment, calcGeometryOfItem_Cell, calcGeometryOfItem_Desktop, calcGeometryOfItem_LineItem, calcSizeForSpatialBl, cloneMeasurableFields } from "../items/base/item-polymorphism";
import { PageItem, asPageItem, calcPageInnerSpatialDimensionsBl, isPage } from "../items/page-item";
import { TableItem, asTableItem, isTable } from "../items/table-item";
import { createVisualElement } from "./visual-element";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { BoundingBox, Dimensions, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { LinkItem, asLinkItem, isLink, newLinkItem } from "../items/link-item";
import { ItemGeometry } from "./item-geometry";
import { Child } from "./relationship-to-parent";
import { newOrdering } from "../util/ordering";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { panic } from "../util/lang";
import { initiateLoadChildItemsIfNotLoaded } from "./load";
import { mouseMoveNoButtonDownHandler } from "../mouse/mouse";
import { newUid } from "../util/uid";
import { updateHref } from "../util/browser";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asPositionalItem, isPositionalItem } from "../items/base/positional-item";

export const ARRANGE_ALGO_SPATIAL_STRETCH = "spatial-stretch"
export const ARRANGE_ALGO_GRID = "grid";
export const ARRANGE_ALGO_LIST = "list";

enum RenderStyle {
  Full,
  Outline,
}

const POPUP_LINK_ID = newUid();
const LIST_FOCUS_ID = newUid();
const ATTACHMENT_POPUP_ID = newUid();


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
  updateHref(desktopStore);
}


/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never called imperatively). The arrange function in that implementation did produce (nested)
 * visual element signals though, which had dependencies on the relevant part of the item state. All the items
 * were solidjs signals (whereas in the current approach they are not). The functional approach was simpler from
 * the point of view that the visual elements did not need to be explicitly updated / managed. However, it turned
 * out to be a dead end:
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
  if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_GRID) {
    arrange_grid(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_SPATIAL_STRETCH) {
    arrange_spatialStretch_topLevel(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    arrange_list(desktopStore);
  }
  mouseMoveNoButtonDownHandler(desktopStore);
}

const arrange_list = (desktopStore: DesktopStoreContextModel) => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const topLevelPageBoundsPx  = desktopStore.desktopBoundsPx();
  const topLevelVisualElement = createVisualElement({
    item: currentPage,
    isInteractive: true,
    isDragOverPositioning: true,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
  });

  topLevelVisualElement.children = (() => {
    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
      const childId = currentPage.computed_children[idx];
      const childItem = desktopStore.getItem(childId)!;
      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

      const geometry = calcGeometryOfItem_LineItem(childItem, blockSizePx, idx, 0, widthBl, desktopStore.getItem);

      const listItemVe = createVisualElement({
        item: childItem,
        isSelected: currentPage.selectedItem == childId,
        isLineItem: true,
        isInteractive: true,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parent: desktopStore.topLevelVisualElementSignal(),
        col: 0,
        row: idx,
        oneBlockWidthPx: LINE_HEIGHT_PX,
      });
      const listItemVisualElementSignal = createVisualElementSignal(listItemVe);
      listVeChildren.push(listItemVisualElementSignal);
    }
    return listVeChildren;
  })();

  if (currentPage.selectedItem != EMPTY_UID) {
    const boundsPx = {
      x: (LIST_PAGE_LIST_WIDTH_BL+1) * LINE_HEIGHT_PX,
      y: LINE_HEIGHT_PX,
      w: desktopStore.desktopBoundsPx().w - ((LIST_PAGE_LIST_WIDTH_BL+2) * LINE_HEIGHT_PX),
      h: desktopStore.desktopBoundsPx().h - (2 * LINE_HEIGHT_PX)
    };
    // topLevelVisualElement.children.push(
    //   arrangeInCell(desktopStore, currentPage.selectedItem, boundsPx));
  }

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}

// function arrangeInCell(desktopStore: DesktopStoreContextModel, id: Uid, boundsPx: BoundingBox): VisualElementSignal {
//   const item = desktopStore.getItem(id)!;

//   if (isPage(item) || isTable(item)) {
//     initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
//   }

//   let li = newLinkItem(item.ownerId, item.parentId, Child, newOrdering(), id);
//   li.id = LIST_FOCUS_ID;
//   let widthGr = 10 * GRID_SIZE;
//   li.spatialWidthGr = widthGr;
//   li.spatialPositionGr = { x: 0.0, y: 0.0 };

//   const geometry = calcGeometryOfItem_Cell(li, boundsPx, desktopStore.getItem);

//   return arrangePageWithChildren(
//     desktopStore,
//     asPageItem(item),
//     li,
//     desktopStore.topLevelVisualElementSignal(),
//     false,  // is popup.
//     true    // is full.
//   );
// }

const arrange_spatialStretch_topLevel = (desktopStore: DesktopStoreContextModel) => {
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

  arrange_spatialStretch(desktopStore, topLevelPageBoundsPx, currentPage, desktopStore.topLevelVisualElementSignal());
}

const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel, pageBoundsPx: BoundingBox, pageItem: PageItem, ves: VisualElementSignal) => {
  const visualElement = createVisualElement({
    item: pageItem,
    isInteractive: true,
    isDragOverPositioning: true,
    boundsPx: pageBoundsPx,
    childAreaBoundsPx: pageBoundsPx,
  });

  visualElement.children = pageItem.computed_children
    .map(childId => arrangeItem_Desktop(
      desktopStore,
      desktopStore.getItem(childId)!,
      pageItem,
      pageBoundsPx,
      ves,
      true,  // render children as full
      false, // parent is popup
      false  // is popup
    ));

  let popupLinkToPageId = desktopStore.popupId();
  if (popupLinkToPageId != null) {
    let li = newLinkItem(pageItem.ownerId, pageItem.id, Child, newOrdering(), popupLinkToPageId);
    li.id = POPUP_LINK_ID;
    let widthGr = Math.round((pageItem.innerSpatialWidthGr / GRID_SIZE) / 2.0) * GRID_SIZE;
    let heightGr = Math.round((pageItem.innerSpatialWidthGr / pageItem.naturalAspect / GRID_SIZE)/ 2.0) * GRID_SIZE;
    li.spatialWidthGr = widthGr;
    li.spatialPositionGr = { x: Math.round((widthGr / GRID_SIZE) / 2.0) * GRID_SIZE, y: ((heightGr / GRID_SIZE) / 2.0) * GRID_SIZE };
    visualElement.children.push(
      arrangeItem_Desktop(
        desktopStore,
        li,
        pageItem,
        pageBoundsPx,
        ves,
        true, // render children as full
        true, // parent is popup
        true  // is popup
      ));
  }

  ves.set(visualElement);
}


const arrangeItem_Desktop = (
    desktopStore: DesktopStoreContextModel,
    item: Item,
    parentPage: PageItem,
    parentPageBoundsPx: BoundingBox,
    parentSignal_underConstruction: VisualElementSignal, // used to establish back references only, not called.
    renderChildrenAsFull: boolean,
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {

  if (isPopup && !isLink(item)) { panic(); }

  const parentPageInnerBoundsPx = zeroBoundingBoxTopLeft(parentPageBoundsPx);

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

  if (isPage(item) && asPageItem(item).arrangeAlgorithm == ARRANGE_ALGO_GRID) {
    // Always make sure child items of grid pages are loaded, even if not visible,
    // because they are needed to to calculate the height.
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
  }

  if (isPage(item) &&
      // This test does not depend on pixel size, so is invariant over display devices.
      spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangePageWithChildren_Desktop(desktopStore, asPageItem(item), parentPage, parentPageInnerBoundsPx, parentIsPopup, linkItemMaybe, parentSignal_underConstruction, isPopup, false);
  }

  if (isTable(item) && (item.parentId == desktopStore.topLevelPageId() || renderChildrenAsFull)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, item.id);
    return arrangeTable_Desktop(desktopStore, asTableItem(item), parentPage, parentPageInnerBoundsPx, parentIsPopup, linkItemMaybe, parentSignal_underConstruction);
  }

  const renderStyle = renderChildrenAsFull
    ? RenderStyle.Full
    : RenderStyle.Outline;

  return arrangeItemNoChildren_Desktop(desktopStore, item, parentPage, parentPageInnerBoundsPx, linkItemMaybe, parentSignal_underConstruction, renderStyle);
}


const arrangePageWithChildren_Desktop = (
    desktopStore: DesktopStoreContextModel,
    pageItem: PageItem,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    parentIsPopup: boolean,
    linkItemMaybe: LinkItem | null,
    parentSignal_underConstruction: VisualElementSignal,
    isPopup: boolean,
    isFull: boolean): VisualElementSignal => {

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const geometry = calcGeometryOfItem_Desktop(pageItem, parentPageInnerBoundsPx, parentPageInnerDimensionsBl, true, parentIsPopup, desktopStore.getItem);

  const pageWithChildrenVisualElement = createVisualElement({
    item: pageItem,
    linkItemMaybe,
    isInteractive: true,
    isPopup,
    isFull,
    isDragOverPositioning: true,
    boundsPx: geometry.boundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes: geometry.hitboxes,
    parent: parentSignal_underConstruction,
  });
  const pageWithChildrenVisualElementSignal = createVisualElementSignal(pageWithChildrenVisualElement);

  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

  if (pageItem.arrangeAlgorithm == ARRANGE_ALGO_GRID || pageItem.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    console.log("TODO: arrange child grid page.");
  } else {
    pageWithChildrenVisualElement.children = pageItem.computed_children.map(childId => {
      const childItem = desktopStore.getItem(childId)!;
      if (isLink(childItem)) { panic(); } // TODO (medium).
      if (isPopup || isFull) {
        return arrangeItem_Desktop(
          desktopStore,
          childItem,
          pageItem,
          pageWithChildrenVisualElement.childAreaBoundsPx!,
          pageWithChildrenVisualElementSignal,
          true,    // render children as full
          isPopup, // parent is popup
          false    // is popup
        );
      } else {
        return arrangeItemNoChildren_Desktop(
          desktopStore, childItem, pageItem, innerBoundsPx, null, pageWithChildrenVisualElementSignal, RenderStyle.Outline);
      }
    });
  }

  arrangeItemAttachments(desktopStore, pageWithChildrenVisualElementSignal, parentPage.selectedAttachment);

  return pageWithChildrenVisualElementSignal;
}


const arrangeTable_Desktop = (
    desktopStore: DesktopStoreContextModel,
    tableItem: TableItem,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    parentIsPopup: boolean,
    linkItemMaybe: LinkItem | null,
    parentSignal_underConstruction: VisualElementSignal): VisualElementSignal => {

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const geometry = calcGeometryOfItem_Desktop(tableItem, parentPageInnerBoundsPx, parentPageInnerDimensionsBl, true, parentIsPopup, desktopStore.getItem);

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
    parent: parentSignal_underConstruction,
  });
  const tableVisualElementSignal = createVisualElementSignal(tableVisualElement);

  tableVisualElement.children = (() => {
    let tableVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<tableItem.computed_children.length; ++idx) {
      const childId = tableItem.computed_children[idx];
      const childItem = desktopStore.getItem(childId)!;
      if (isLink(childItem)) { panic(); }  // TODO (MEDIUM).
      let widthBl = tableItem.tableColumns.length == 1
        ? sizeBl.w
        : Math.min(tableItem.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

      const geometry = calcGeometryOfItem_LineItem(childItem, blockSizePx, idx, 0, widthBl, desktopStore.getItem);

      const tableItemVe = createVisualElement({
        item: childItem,
        isLineItem: true,
        isInteractive: true,
        isInsideTable: true,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parent: tableVisualElementSignal,
        col: 0,
        row: idx,
        oneBlockWidthPx: blockSizePx.w,
      });
      const tableItemVisualElementSignal = createVisualElementSignal(tableItemVe);
      tableVeChildren.push(tableItemVisualElementSignal);

      if (isAttachmentsItem(childItem)) {
        let tableItemVeAttachments: Array<VisualElementSignal> = [];
        const attachmentsItem = asAttachmentsItem(childItem);
        let leftBl = tableItem.tableColumns[0].widthGr / GRID_SIZE;
        let i=0;
        for (; i<attachmentsItem.computed_attachments.length; ++i) {
          if (i >= tableItem.tableColumns.length-1) { break; }
          if (leftBl >= tableItem.spatialWidthGr / GRID_SIZE) { break; }
          let widthBl = i == tableItem.tableColumns.length - 2
            ? sizeBl.w - leftBl
            : tableItem.tableColumns[i+1].widthGr / GRID_SIZE;
          const attachmentId = attachmentsItem.computed_attachments[i];
          const attachmentItem = desktopStore.getItem(attachmentId)!;
          const geometry = calcGeometryOfItem_LineItem(attachmentItem, blockSizePx, idx, leftBl, widthBl, desktopStore.getItem);
          const tableItemAttachmentVe = createVisualElement({
            item: attachmentItem,
            isInteractive: true,
            isInsideTable: true,
            isAttachment: true,
            boundsPx: geometry.boundsPx,
            hitboxes: geometry.hitboxes,
            col: i + 1,
            row: idx,
            parent: tableItemVisualElementSignal,
            oneBlockWidthPx: blockSizePx.w
          });
          tableItemVeAttachments.push(createVisualElementSignal(tableItemAttachmentVe));
          leftBl += tableItem.tableColumns[i+1].widthGr / GRID_SIZE;
        }
        // create 'empty' item visual elements for table cells without an associated attachment.
        for (; i<tableItem.tableColumns.length-1; ++i) {
          if (leftBl >= tableItem.spatialWidthGr / GRID_SIZE) { break; }
          let widthBl = i == tableItem.tableColumns.length - 2
            ? sizeBl.w - leftBl
            : tableItem.tableColumns[i+1].widthGr / GRID_SIZE;
          const geometry = calcGeometryOfItem_LineItem(EMPTY_ITEM, blockSizePx, idx, leftBl, widthBl, desktopStore.getItem);
          const tableItemAttachmentVe = createVisualElement({
            item: EMPTY_ITEM,
            isInteractive: false,
            isInsideTable: true,
            isAttachment: true,
            boundsPx: geometry.boundsPx,
            hitboxes: geometry.hitboxes,
            col: i + 1,
            row: idx,
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

  arrangeItemAttachments(desktopStore, tableVisualElementSignal, parentPage.selectedAttachment);

  return tableVisualElementSignal;
}


const arrangeItemNoChildren_Desktop = (
    desktopStore: DesktopStoreContextModel,
    item: Item,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    linkItemMaybe: LinkItem | null,
    parentSignal_underConstruction: VisualElementSignal,
    renderStyle: RenderStyle): VisualElementSignal => {

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const itemGeometry = calcGeometryOfItem_Desktop(item, parentPageInnerBoundsPx, parentPageInnerDimensionsBl, true, false, desktopStore.getItem);

  const itemVisualElement = createVisualElement({
    item,
    linkItemMaybe,
    isInteractive: renderStyle != RenderStyle.Outline,
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parent: parentSignal_underConstruction,
  });
  const itemVisualElementSignal = createVisualElementSignal(itemVisualElement);

  arrangeItemAttachments(desktopStore, itemVisualElementSignal, parentPage.selectedAttachment);

  return itemVisualElementSignal;
}


function arrangeItemAttachments(
    desktopStore: DesktopStoreContextModel,
    itemVisualElementSignal: VisualElementSignal, // the item to arrange attachments on.
    selectedAttachmentId: Uid | null,
  ) {

  const itemVisualElement = itemVisualElementSignal.get();
  if (!isAttachmentsItem(itemVisualElement.item)) {
    return;
  }

  const itemBoundsPx = itemVisualElement.boundsPx;
  const itemSizeBl = calcSizeForSpatialBl(itemVisualElement.item, desktopStore.getItem);
  const attachmentsItem = asAttachmentsItem(itemVisualElement.item);
  for (let i=0; i<attachmentsItem.computed_attachments.length; ++i) {
    const attachmentId = attachmentsItem.computed_attachments[i];
    const attachmentItem = desktopStore.getItem(attachmentId)!;
    const attachmentGeometry = calcGeometryOfItem_Attachment(attachmentItem, itemBoundsPx, itemSizeBl, i, selectedAttachmentId == attachmentId && isPositionalItem(attachmentItem), desktopStore.getItem);
    const attachmentVisualElement = createVisualElement({
      item: attachmentItem,
      boundsPx: attachmentGeometry.boundsPx,
      hitboxes: attachmentGeometry.hitboxes,
      parent: itemVisualElementSignal,
      isAttachment: true,
      isInteractive: selectedAttachmentId == attachmentId
    });
    itemVisualElementSignal.get().attachments.push(createVisualElementSignal(attachmentVisualElement));
  }
}


const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  const currentPage = asPageItem(desktopStore.getItem(desktopStore.topLevelPageId()!)!);
  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const numCols = currentPage.gridNumberOfColumns;
  const numRows = Math.ceil(currentPage.computed_children.length / numCols);
  const cellWPx = pageBoundsPx.w / numCols;
  const cellHPx = cellWPx * (1.0/GRID_PAGE_CELL_ASPECT);
  const marginPx = cellWPx * 0.01;
  const pageHeightPx = numRows * cellHPx;
  const boundsPx = (() => {
    const result = cloneBoundingBox(pageBoundsPx)!;
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

    let geometry = calcGeometryOfItem_Cell(item, cellBoundsPx, desktopStore.getItem);
    if (!isTable(item)) {
      const ve = createVisualElement({
        item,
        isInteractive: true,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parent: desktopStore.topLevelVisualElementSignal(),
      });
      topLevelVisualElement.children.push(createVisualElementSignal(ve));
    } else {
      console.log("TODO: child tables in grid pages.");
    }
  }

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
    const pageItem = asPageItem(visualElement.parent!.get().item);
    const rearrangedVisualElement = arrangeItem_Desktop(
      desktopStore,
      item,
      pageItem,
      visualElement.parent!.get().childAreaBoundsPx!,
      visualElement.parent!,
      visualElement.parent!.get().isPopup,
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

  if (!visualElement.isInsideTable) {
    const itemSizeBl = calcSizeForSpatialBl(parentVisualElement.item, desktopStore.getItem);
    const attachmentGeometry = calcGeometryOfItem_Attachment(visualElement.item, parentVisualElement.boundsPx, itemSizeBl, index, false, desktopStore.getItem);
    const attachmentVisualElement = createVisualElement({
      item: visualElement.item,
      boundsPx: attachmentGeometry.boundsPx,
      hitboxes: attachmentGeometry.hitboxes,
      parent: visualElement.parent!,
      isAttachment: true,
    });
    visualElementSignal.set(attachmentVisualElement);
  } else {
    console.log("TODO: rearrange attachments inside tables.");
  }
}
