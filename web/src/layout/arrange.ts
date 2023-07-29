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
import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../components/items/Table";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_PAGE_CELL_ASPECT, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, POPUP_TOOLBAR_WIDTH_BL } from "../constants";
import { EMPTY_UID, Uid } from "../util/uid";
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { EMPTY_ITEM, Item } from "../items/base/item";
import { calcGeometryOfItem_Attachment, calcGeometryOfItem_Cell, calcGeometryOfItem_Desktop, calcGeometryOfItem_ListItem, calcSizeForSpatialBl } from "../items/base/item-polymorphism";
import { PageItem, asPageItem, calcPageInnerSpatialDimensionsBl, getPopupPositionGr, getPopupWidthGr, isPage } from "../items/page-item";
import { TableItem, asTableItem, isTable } from "../items/table-item";
import { Veid, VesCache, VisualElement, VisualElementFlags, VisualElementSpec, VisualElementPath, attachmentFlagSet, createVeid, createVesCache, createVisualElement, getVeid, insideTableFlagSet, pagePopupFlagSet, prependVeidToPath, visualElementSignalFromPath, visualElementToPath } from "./visual-element";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { LinkItem, asLinkItem, getLinkToId, isLink, newLinkItem } from "../items/link-item";
import { Child } from "./relationship-to-parent";
import { newOrdering } from "../util/ordering";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { panic } from "../util/lang";
import { initiateLoadChildItemsIfNotLoaded, initiateLoadItem, initiateLoadItemFromRemote } from "./load";
import { mouseMoveNoButtonDownHandler } from "../mouse/mouse";
import { newUid } from "../util/uid";
import { updateHref } from "../util/browser";
import { HitboxType, createHitbox } from "./hitbox";
import { itemStore } from "../store/ItemStore";
import { PopupType, breadcrumbStore } from "../store/BreadcrumbStore";

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


export let currentVesCache: VesCache = {};


export const switchToPage = (desktopStore: DesktopStoreContextModel, id: Uid) => {
  batch(() => {
    breadcrumbStore.pushPage(id);
    var page = asPageItem(itemStore.getItem(id)!);
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
  updateHref();
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
 * 1. It was effectively impossible to perfectly optimize it in the case of resizing pages (and probably other
 *    scenarios) because the children were a function of page size. By comparison, as a general comment, the
 *    stateful approach makes it easy(er) to make precisely the optimal updates at precisely the required times.
 * 2. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", I think the code is simpler to work on due to this.
 */
export const arrange = (desktopStore: DesktopStoreContextModel): void => {
  if (breadcrumbStore.currentPage() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, breadcrumbStore.currentPage()!);
  let currentPage = asPageItem(itemStore.getItem(breadcrumbStore.currentPage()!)!);
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
  const currentPage = asPageItem(itemStore.getItem(breadcrumbStore.currentPage()!)!);
  const topLevelPageBoundsPx  = desktopStore.desktopBoundsPx();
  const topLevelVisualElement = createVisualElement({
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.DragOverPositioning,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
  });

  const currentPath = prependVeidToPath(createVeid(currentPage, null), "");

  topLevelVisualElement.children = (() => {
    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
      const childId = currentPage.computed_children[idx];
      const childItem = itemStore.getItem(childId)!;
      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

      const geometry = calcGeometryOfItem_ListItem(childItem, blockSizePx, idx, 0, widthBl);

      const listItemVe = createVisualElement({
        displayItem: childItem,
        flags: VisualElementFlags.LineItem |
               VisualElementFlags.Detailed |
               (currentPage.selectedItem == childId ? VisualElementFlags.Selected : VisualElementFlags.None),
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath: currentPath,
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
  const currentPage = asPageItem(itemStore.getItem(breadcrumbStore.currentPage()!)!);
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

  let currentPath = "";
  let newCache: VesCache = {};
  const topLevel = arrange_spatialStretch(desktopStore, newCache, currentPath, topLevelPageBoundsPx, currentPage);
  newCache[currentPage.id] = desktopStore.topLevelVisualElementSignal();
  currentVesCache = newCache;

  desktopStore.topLevelVisualElementSignal().set(topLevel);
}

const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel, newCache: VesCache, parentPath: VisualElementPath, pageBoundsPx: BoundingBox, pageItem: PageItem): VisualElement => {
  const currentPath = prependVeidToPath(createVeid(pageItem, null), parentPath);

  const visualElement = createVisualElement({
    displayItem: pageItem,
    flags: VisualElementFlags.Detailed | VisualElementFlags.DragOverPositioning,
    boundsPx: pageBoundsPx,
    childAreaBoundsPx: pageBoundsPx,
  });

  const children = pageItem.computed_children
    .map(childId => arrangeItem_Desktop(
      desktopStore,
      newCache,
      currentPath,
      itemStore.getItem(childId)!,
      pageItem, // parent item
      pageBoundsPx,
      true,  // render children as full
      false, // parent is popup
      false  // is popup
    ));

  const currentPopupSpec = breadcrumbStore.currentPopupSpec();
  if (currentPopupSpec != null) {

    // ** PAGE POPUP
    if (currentPopupSpec.type == PopupType.Page) {
      const popupLinkToPageId = currentPopupSpec.uid;
      const li = newLinkItem(pageItem.ownerId, pageItem.id, Child, newOrdering(), popupLinkToPageId!);
      li.id = POPUP_LINK_ID;
      const widthGr = getPopupWidthGr(pageItem);
      const heightGr = Math.round((widthGr / pageItem.naturalAspect / GRID_SIZE)/ 2.0) * GRID_SIZE;
      li.spatialWidthGr = widthGr;
      // assume center positioning.
      li.spatialPositionGr = {
        x: getPopupPositionGr(pageItem).x - widthGr / 2.0,
        y: getPopupPositionGr(pageItem).y - heightGr / 2.0
      };
      children.push(
        arrangeItem_Desktop(
          desktopStore,
          newCache,
          currentPath,
          li,
          pageItem, // parent item
          pageBoundsPx,
          true, // render children as full
          false, // parent is popup
          true  // is popup
        ));

    // ** ATTACHMENT POPUP
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.

    } else {
      panic();
    }
  }

  visualElement.children = children;

  return visualElement;
}


const arrangeItem_Desktop = (
    desktopStore: DesktopStoreContextModel,
    newCache: VesCache,
    parentPath: VisualElementPath,
    item: Item,
    parentPage: PageItem,
    parentPageBoundsPx: BoundingBox,
    renderChildrenAsFull: boolean,
    parentIsPopup: boolean,
    isPagePopup: boolean): VisualElementSignal => {
  if (isPagePopup && !isLink(item)) { panic(); }

  const [canonicalItem, linkItemMaybe, spatialWidthGr] = calcVeDisplayItemAndLinkItemMaybe(desktopStore, item);

  if (isPage(canonicalItem) && asPageItem(canonicalItem).arrangeAlgorithm == ARRANGE_ALGO_GRID) {
    // Always make sure child items of grid pages are loaded, even if not visible,
    // because they are needed to to calculate the height.
    initiateLoadChildItemsIfNotLoaded(desktopStore, canonicalItem.id);
  }

  if (isPage(canonicalItem) &&
      // This test does not depend on pixel size, so is invariant over display devices.
      spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, canonicalItem.id);
    return arrangePageWithChildren_Desktop(
      desktopStore,
      newCache,
      parentPath,
      asPageItem(canonicalItem),
      linkItemMaybe,
      parentPage,
      zeroBoundingBoxTopLeft(parentPageBoundsPx),
      parentIsPopup,
      isPagePopup, false);
  }

  if (isTable(canonicalItem) && (item.parentId == breadcrumbStore.currentPage() || renderChildrenAsFull)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, canonicalItem.id);
    return arrangeTable_Desktop(
      desktopStore,
      newCache,
      parentPath,
      asTableItem(canonicalItem),
      linkItemMaybe,
      parentPage,
      zeroBoundingBoxTopLeft(parentPageBoundsPx),
      parentIsPopup);
  }

  const renderStyle = renderChildrenAsFull
    ? RenderStyle.Full
    : RenderStyle.Outline;

  return arrangeItemNoChildren_Desktop(
    desktopStore,
    newCache,
    parentPath,
    canonicalItem,
    linkItemMaybe,
    parentPage,
    zeroBoundingBoxTopLeft(parentPageBoundsPx),
    false, // parentIsPopup.
    renderStyle);
}


const arrangePageWithChildren_Desktop = (
    desktopStore: DesktopStoreContextModel,
    newCache: VesCache,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    parentIsPopup: boolean,
    isPagePopup: boolean,
    isRoot: boolean): VisualElementSignal => {

  const pageWithChildrenVePath = prependVeidToPath(createVeid(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren), parentPath);

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const geometry = calcGeometryOfItem_Desktop(
    linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : displayItem_pageWithChildren,
    parentPageInnerBoundsPx, parentPageInnerDimensionsBl, parentIsPopup, true);
  let boundsPx = geometry.boundsPx;
  let childAreaBoundsPx = geometry.boundsPx;
  let hitboxes = geometry.hitboxes;
  if (isPagePopup) {
    const spatialWidthBl = linkItemMaybe_pageWithChildren!.spatialWidthGr / GRID_SIZE;
    const widthPx = boundsPx.w;
    const blockWidthPx = widthPx / spatialWidthBl;
    const toolbarWidthPx = blockWidthPx * POPUP_TOOLBAR_WIDTH_BL;
    boundsPx = {
      x: childAreaBoundsPx.x - toolbarWidthPx,
      y: childAreaBoundsPx.y,
      w: childAreaBoundsPx.w + toolbarWidthPx,
      h: childAreaBoundsPx.h,
    };
    const defaultResizeHitbox = geometry.hitboxes.filter(hb => hb.type == HitboxType.Resize)[0];
    if (defaultResizeHitbox.type != HitboxType.Resize) { panic(); }
    const rhbBoundsPx = defaultResizeHitbox.boundsPx;
    hitboxes = [
      createHitbox(HitboxType.Resize, { x: rhbBoundsPx.x + toolbarWidthPx, y: rhbBoundsPx.y, w: rhbBoundsPx.w, h: rhbBoundsPx.h }),
      createHitbox(HitboxType.Move, { x: 0, y: 0, w: toolbarWidthPx, h: boundsPx.h })
    ];
  }
  const pageWithChildrenVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.DragOverPositioning |
           (isPagePopup ? VisualElementFlags.PagePopup : VisualElementFlags.None) |
           (isRoot ? VisualElementFlags.Root : VisualElementFlags.None),
    boundsPx,
    childAreaBoundsPx,
    hitboxes,
    parentPath,
  };

  const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

  if (displayItem_pageWithChildren.arrangeAlgorithm == ARRANGE_ALGO_GRID || displayItem_pageWithChildren.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    console.log("TODO: arrange child grid page.");
  } else {
    pageWithChildrenVisualElementSpec.children = displayItem_pageWithChildren.computed_children.map(childId => {
      const childItem = itemStore.getItem(childId)!;
      if (isPagePopup || isRoot) {
        return arrangeItem_Desktop(
          desktopStore,
          newCache,
          pageWithChildrenVePath,
          childItem,
          displayItem_pageWithChildren, // parent item
          pageWithChildrenVisualElementSpec.childAreaBoundsPx!,
          true,    // render children as full
          isPagePopup, // parent is popup
          false    // is popup
        );
      } else {
        let linkItemMaybe: LinkItem | null = null;
        let canonicalItem = childItem;
        if (isLink(childItem)) {
          linkItemMaybe = asLinkItem(childItem);
          const canonicalItemMaybe = itemStore.getItem(getLinkToId(linkItemMaybe));
          if (canonicalItemMaybe != null) {
            canonicalItem = canonicalItemMaybe!;
          }
        }
        return arrangeItemNoChildren_Desktop(
          desktopStore, newCache, pageWithChildrenVePath, canonicalItem, linkItemMaybe, displayItem_pageWithChildren, innerBoundsPx, isPagePopup, RenderStyle.Outline);
      }
    });
  }

  const attachments = arrangeItemAttachments(desktopStore, newCache, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, boundsPx, pageWithChildrenVePath);
  pageWithChildrenVisualElementSpec.attachments = attachments;

  const pageWithChildrenVisualElementSignal = createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  newCache[pageWithChildrenVePath] = pageWithChildrenVisualElementSignal;

  return pageWithChildrenVisualElementSignal;
}


const arrangeTable_Desktop = (
    desktopStore: DesktopStoreContextModel,
    newCache: VesCache,
    parentPath: VisualElementPath,
    displayItem_Table: TableItem,
    linkItemMaybe_Table: LinkItem | null,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    parentIsPopup: boolean): VisualElementSignal => {

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const tableGeometry = calcGeometryOfItem_Desktop(
    linkItemMaybe_Table ? linkItemMaybe_Table : displayItem_Table,
    parentPageInnerBoundsPx, parentPageInnerDimensionsBl, parentIsPopup, true);

  const sizeBl = linkItemMaybe_Table
    ? { w: linkItemMaybe_Table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_Table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_Table.spatialWidthGr / GRID_SIZE, h: displayItem_Table.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableGeometry.boundsPx.w / sizeBl.w, h: tableGeometry.boundsPx.h / sizeBl.h };
  const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
  const colHeaderHeightPx = displayItem_Table.showHeader ? (blockSizePx.h * COL_HEADER_HEIGHT_BL) : 0;

  let childAreaBoundsPx = {
    x: tableGeometry.boundsPx.x, y: tableGeometry.boundsPx.y + (headerHeightPx + colHeaderHeightPx),
    w: tableGeometry.boundsPx.w, h: tableGeometry.boundsPx.h - (headerHeightPx + colHeaderHeightPx)
  };

  const tableVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Table,
    linkItemMaybe: linkItemMaybe_Table,
    flags: VisualElementFlags.Detailed,
    boundsPx: tableGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: tableGeometry.hitboxes,
    parentPath,
  };
  const tableVePath = prependVeidToPath(createVeid(displayItem_Table, linkItemMaybe_Table), parentPath);

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_Table.computed_children.length; ++idx) {
    const childId = displayItem_Table.computed_children[idx];
    const childItem = itemStore.getItem(childId)!;
    const [displayItem_childItem, linkItemMaybe_childItem] = calcVeDisplayItemAndLinkItemMaybe(desktopStore, childItem);

    let widthBl = displayItem_Table.tableColumns.length == 1
      ? sizeBl.w
      : Math.min(displayItem_Table.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

    const geometry = calcGeometryOfItem_ListItem(childItem, blockSizePx, idx, 0, widthBl);

    const tableChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.LineItem | VisualElementFlags.Detailed | VisualElementFlags.InsideTable,
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: tableVePath,
      col: 0,
      row: idx,
      oneBlockWidthPx: blockSizePx.w,
    };
    const tableChildVePath = prependVeidToPath(createVeid(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

    if (isAttachmentsItem(displayItem_childItem)) {
      let tableItemVeAttachments: Array<VisualElementSignal> = [];
      const attachmentsItem = asAttachmentsItem(displayItem_childItem);
      let leftBl = displayItem_Table.tableColumns[0].widthGr / GRID_SIZE;
      let i=0;
      for (; i<attachmentsItem.computed_attachments.length; ++i) {
        if (i >= displayItem_Table.tableColumns.length-1) { break; }
        if (leftBl >= displayItem_Table.spatialWidthGr / GRID_SIZE) { break; }
        let widthBl = i == displayItem_Table.tableColumns.length - 2
          ? sizeBl.w - leftBl
          : displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;

        const attachmentId = attachmentsItem.computed_attachments[i];
        const attachmentItem = itemStore.getItem(attachmentId)!;
        const [displayItem_attachment, linkItemMaybe_attachment] = calcVeDisplayItemAndLinkItemMaybe(desktopStore, attachmentItem);

        const geometry = calcGeometryOfItem_ListItem(attachmentItem, blockSizePx, idx, leftBl, widthBl);

        const tableChildAttachmentVeSpec: VisualElementSpec = {
          displayItem: displayItem_attachment,
          linkItemMaybe: linkItemMaybe_attachment,
          flags: VisualElementFlags.Detailed | VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
          boundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          col: i + 1,
          row: idx,
          parentPath: tableChildVePath,
          oneBlockWidthPx: blockSizePx.w
        };
        const tableChildAttachmentVePath = prependVeidToPath(createVeid(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
        const tableChildAttachmentVeSignal = createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
        tableItemVeAttachments.push(tableChildAttachmentVeSignal);
        newCache[tableChildAttachmentVePath] = tableChildAttachmentVeSignal;
        leftBl += displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      }
      // create 'empty' item visual elements for table cells without an associated attachment.
      // TODO: these need to have a unique veid.
      // for (; i<displayItem_Table.tableColumns.length-1; ++i) {
      //   if (leftBl >= displayItem_Table.spatialWidthGr / GRID_SIZE) { break; }
      //   let widthBl = i == displayItem_Table.tableColumns.length - 2
      //     ? sizeBl.w - leftBl
      //     : displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      //   const geometry = calcGeometryOfItem_ListItem(EMPTY_ITEM, blockSizePx, idx, leftBl, widthBl);
      //   const tableChildAttachmentVeSpec: VisualElementSpec = {
      //     displayItem: EMPTY_ITEM,
      //     flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
      //     boundsPx: geometry.boundsPx,
      //     hitboxes: geometry.hitboxes,
      //     col: i + 1,
      //     row: idx,
      //     parentPath: tableChildVePath,
      //   };
      //   tableChildAttachmentVePath = prependVeidToPath(createVeid(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
      //   tableItemVeAttachments.push(createVisualElementSignal(tableItemAttachmentVe));
      //   leftBl += displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      // }

      tableChildVeSpec.attachments = tableItemVeAttachments;

      const tableItemVisualElementSignal = createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);
      tableVeChildren.push(tableItemVisualElementSignal);
      newCache[tableChildVePath] = tableItemVisualElementSignal;
    }
  };

  tableVisualElementSpec.children = tableVeChildren;

  const attachments = arrangeItemAttachments(desktopStore, newCache, displayItem_Table, linkItemMaybe_Table, tableGeometry.boundsPx, tableVePath);
  tableVisualElementSpec.attachments = attachments;

  const tableVisualElementSignal = createOrRecycleVisualElementSignal(tableVisualElementSpec, tableVePath);
  newCache[tableVePath] = tableVisualElementSignal;

  return tableVisualElementSignal;
}


/**
 * Given an item, calculate the visual element display item (what is visually depicted) and linkItemMaybe.
 */
function calcVeDisplayItemAndLinkItemMaybe(desktopStore: DesktopStoreContextModel, item: Item): [Item, LinkItem | null, number] {
  let displayItem = item;
  let linkItemMaybe: LinkItem | null = null;
  let spatialWidthGr = isXSizableItem(displayItem)
    ? asXSizableItem(displayItem).spatialWidthGr
    : 0;
  if (isLink(item)) {
    linkItemMaybe = asLinkItem(item);
    const canonicalItemMaybe = itemStore.getItem(getLinkToId(linkItemMaybe))!;
    if (canonicalItemMaybe != null) {
      displayItem = canonicalItemMaybe!;
      if (isXSizableItem(displayItem)) {
        spatialWidthGr = linkItemMaybe.spatialWidthGr;
      }
    } else {
      if (linkItemMaybe.linkTo != EMPTY_UID) {
        if (linkItemMaybe.linkToBaseUrl == "") {
          initiateLoadItem(desktopStore, linkItemMaybe.linkTo);
        } else {
          initiateLoadItemFromRemote(desktopStore, linkItemMaybe.linkTo, linkItemMaybe.linkToBaseUrl, linkItemMaybe.id);
        }
      }
    }
  }
  return [displayItem, linkItemMaybe, spatialWidthGr];
}


const arrangeItemNoChildren_Desktop = (
    desktopStore: DesktopStoreContextModel,
    newCache: VesCache,
    parentVePath: VisualElementPath,
    canonicalItem: Item,
    linkItemMaybe: LinkItem | null,
    parentPage: PageItem,
    parentPageInnerBoundsPx: BoundingBox,
    parentIsPopup: boolean,
    renderStyle: RenderStyle): VisualElementSignal => {

  const currentVePath = prependVeidToPath(createVeid(canonicalItem, linkItemMaybe), parentVePath);

  const parentPageInnerDimensionsBl = calcPageInnerSpatialDimensionsBl(parentPage);
  const itemGeometry = calcGeometryOfItem_Desktop(
    linkItemMaybe ? linkItemMaybe : canonicalItem,
    parentPageInnerBoundsPx, parentPageInnerDimensionsBl, parentIsPopup, true);

  const item = canonicalItem != null ? canonicalItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (renderStyle != RenderStyle.Outline ? VisualElementFlags.Detailed : VisualElementFlags.None),
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  itemVisualElement.attachments = arrangeItemAttachments(desktopStore, newCache, canonicalItem, linkItemMaybe, itemGeometry.boundsPx, currentVePath);

  const itemVisualElementSignal = createOrRecycleVisualElementSignal(itemVisualElement, currentVePath);
  newCache[currentVePath] = itemVisualElementSignal;

  return itemVisualElementSignal;
}


function createOrRecycleVisualElementSignal(visualElementOverride: VisualElementSpec, path: VisualElementPath) {
  const existing = currentVesCache[path];
  if (existing) {
    const newVals: any = visualElementOverride;
    const oldVals: any = existing.get();
    const newProps = Object.getOwnPropertyNames(visualElementOverride);
    let dirty = false;
    // console.log(newProps, visualElementOverride);
    for (let i=0; i<newProps.length; ++i) {
      // console.log("considering", newProps[i]);
      if (typeof(oldVals[newProps[i]]) == 'undefined') {
        // console.log('prop does not exist:', newProps[i]);
        dirty = true;
        break;
      }
      const oldVal = oldVals[newProps[i]];
      const newVal = newVals[newProps[i]];
      if (oldVal != newVal) {
        if (newProps[i] == "boundsPx") {
          if ((oldVal as BoundingBox).x != (newVal as BoundingBox).x ||
              (oldVal as BoundingBox).y != (newVal as BoundingBox).y ||
              (oldVal as BoundingBox).w != (newVal as BoundingBox).w ||
              (oldVal as BoundingBox).h != (newVal as BoundingBox).h) {
            // console.log("boundsPx changed");
            dirty = true;
            break;
          } else {
            // console.log("boundsPx didn't change!");
          }
        } else {
          // console.log("prop changed: ", newProps[i]);
          dirty = true;
          break;
        }
      }
    }
    if (!dirty) {
      // console.log("not dirty!:", path);
      return existing;
    }
    // console.log("dirty!:", path);
    existing.set(createVisualElement(visualElementOverride));
    return existing;
  }

  // console.log("creating!", path);
  return createVisualElementSignal(createVisualElement(visualElementOverride));
}


function arrangeItemAttachments(
    desktopStore: DesktopStoreContextModel,
    newCache: VesCache,
    parentDisplayItem: Item,
    parentLinkItemMaybe: LinkItem | null,
    parentItemBoundsPx: BoundingBox,
    parentItemVePath: VisualElementPath): Array<VisualElementSignal> {

  if (!isAttachmentsItem(parentDisplayItem)) {
    return [];
  }
  const attachmentsItem = asAttachmentsItem(parentDisplayItem);

  const parentItemSizeBl = calcSizeForSpatialBl(parentLinkItemMaybe == null ? parentDisplayItem : parentLinkItemMaybe);

  const attachments: Array<VisualElementSignal> = [];
  for (let i=0; i<attachmentsItem.computed_attachments.length; ++i) {
    const attachmentId = attachmentsItem.computed_attachments[i];
    const attachmentItem = itemStore.getItem(attachmentId)!;
    const [attachmentDisplayItem, attachmentLinkItemMaybe, _] = calcVeDisplayItemAndLinkItemMaybe(desktopStore, attachmentItem);
    const attachmentVeid: Veid = {
      itemId: attachmentDisplayItem.id,
      linkIdMaybe: attachmentLinkItemMaybe ? attachmentLinkItemMaybe.id : null
    };
    const attachmentVePath = prependVeidToPath(attachmentVeid, parentItemVePath);

    const popupSpec = breadcrumbStore.currentPopupSpec();
    let isSelected = false;
    if (popupSpec != null && popupSpec.type == PopupType.Attachment) {
      if (attachmentVePath == popupSpec.vePath) {
        isSelected = true;
      }
    }

    const attachmentGeometry = calcGeometryOfItem_Attachment(attachmentItem, parentItemBoundsPx, parentItemSizeBl, i, isSelected);

    const veSpec: VisualElementSpec = {
      displayItem: attachmentDisplayItem != null ? attachmentDisplayItem : attachmentLinkItemMaybe!,
      linkItemMaybe: attachmentLinkItemMaybe,
      boundsPx: attachmentGeometry.boundsPx,
      hitboxes: attachmentGeometry.hitboxes,
      parentPath: parentItemVePath,
      flags: VisualElementFlags.Attachment |
             (isSelected ? VisualElementFlags.Detailed : VisualElementFlags.None),
    };
    const attachmentVisualElementSignal = createOrRecycleVisualElementSignal(veSpec, attachmentVePath);
    newCache[attachmentVePath] = attachmentVisualElementSignal;
    attachments.push(attachmentVisualElementSignal);
  }

  return attachments;
}


const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  const currentPage = asPageItem(itemStore.getItem(breadcrumbStore.currentPage()!)!);
  const currentPath = prependVeidToPath(createVeid(currentPage, null), "");

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
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.DragOverPositioning,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
  });

  const childItems = currentPage.computed_children.map(childId => itemStore.getItem(childId)!);
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

    let geometry = calcGeometryOfItem_Cell(item, cellBoundsPx);
    if (!isTable(item)) {
      const ve = createVisualElement({
        displayItem: item,
        flags: VisualElementFlags.Detailed,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath: currentPath,
      });
      topLevelVisualElement.children.push(createVisualElementSignal(ve));
    } else {
      console.log("TODO: child tables in grid pages.");
    }
  }

  desktopStore.setTopLevelVisualElement(topLevelVisualElement);
}


// export const rearrangeVisualElementsWithItemId = (desktopStore: DesktopStoreContextModel, id: Uid): void => {
//   visualElementsWithItemId(desktopStore, id).forEach(ve => {
//     const parentIsDesktopPage =
//       ve.get().parentPath == null ||
//       (isPage(currentVesCache[ve.get().parentPath!].get().item) && !attachmentFlagSet(ve.get()));
//     if (parentIsDesktopPage) {
//       rearrangeVisualElement(desktopStore, ve);
//     } else {
//       console.log("TODO: rearrange table children")
//     }
//   });
// }

// export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void => {
//   const visualElement = visualElementSignal.get();
//   console.log(visualElement);
//   if (breadcrumbStore.currentPage() == visualElement.item.id) {
//     arrange(desktopStore);
//     return;
//   }

//   if (attachmentFlagSet(visualElement)) {
//     rearrangeAttachment(visualElementSignal);
//   } else {
//     const item = visualElement.linkItemMaybe != null
//       ? visualElement.linkItemMaybe!
//       : visualElement.item;
//     if (isPage(currentVesCache[visualElement.parentPath!].get().item)) {
//       const pageItem = asPageItem(currentVesCache[visualElement.parentPath!].get().item);
//       const rearrangedVisualElement = arrangeItem_Desktop(
//         desktopStore,
//         {}, // TODO (HIGH): what here?
//         visualElement.parentPath!,
//         item,
//         pageItem,
//         currentVesCache[visualElement.parentPath!].get().childAreaBoundsPx!,
//         pagePopupFlagSet(currentVesCache[visualElement.parentPath!].get()),
//         pagePopupFlagSet(currentVesCache[visualElement.parentPath!].get()),
//         pagePopupFlagSet(visualElement)).get();
//       visualElementSignal.set(rearrangedVisualElement);
//     } else {
//       // TODO (HIGH)
//       console.log("TODO: rearrangeVisualElement when parent not page");
//     }
//   }
// }

// function rearrangeAttachment(visualElementSignal: VisualElementSignal) {
//   const visualElement = visualElementSignal.get();
//   const parentVisualElement = currentVesCache[visualElement.parentPath!].get();
//   let index = -1;
//   for (let i=0; i<parentVisualElement.attachments.length; ++i) {
//     if (parentVisualElement.attachments[i].get().item == visualElement.item) {
//       index = i;
//       break;
//     }
//   }
//   if (index == -1) { panic(); }
//   if (!insideTableFlagSet(visualElement)) {
//     let isSelected = false;
//     const popupSpec = breadcrumbStore.currentPopupSpec();
//     if (popupSpec != null && popupSpec.type == PopupType.Attachment) {
//       if (visualElementToPath(visualElement) == popupSpec.vePath) {
//         isSelected = true;
//         console.log("selected!");
//       }
//     }
//     const itemSizeBl = calcSizeForSpatialBl(parentVisualElement.item);
//     const attachmentGeometry = calcGeometryOfItem_Attachment(visualElement.item, parentVisualElement.boundsPx, itemSizeBl, index, isSelected);
//     const attachmentVisualElement = createVisualElement({
//       item: visualElement.item,
//       boundsPx: attachmentGeometry.boundsPx,
//       hitboxes: attachmentGeometry.hitboxes,
//       parentPath: visualElement.parentPath!,
//       flags: VisualElementFlags.Attachment |
//              (isSelected ? VisualElementFlags.Detailed : VisualElementFlags.None)
//     });
//     visualElementSignal.set(attachmentVisualElement);
//   } else {
//     console.log("TODO: rearrange attachments inside tables.");
//   }
// }
