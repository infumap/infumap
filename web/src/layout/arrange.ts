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
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_PAGE_CELL_ASPECT, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, POPUP_TOOLBAR_WIDTH_BL } from "../constants";
import { EMPTY_UID } from "../util/uid";
import { DesktopStoreContextModel, PopupType } from "../store/DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PageItem, asPageItem, isPage, PageFns } from "../items/page-item";
import { TableItem, asTableItem, isTable } from "../items/table-item";
import { Veid, VisualElementFlags, VisualElementSpec, VisualElementPath, EMPTY_VEID, VeFns } from "./visual-element";
import { VisualElementSignal } from "../util/signals";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../util/geometry";
import { LinkItem, asLinkItem, isLink, LinkFns } from "../items/link-item";
import { newOrdering } from "../util/ordering";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { panic } from "../util/lang";
import { initiateLoadChildItemsIfNotLoaded, initiateLoadItem, initiateLoadItemFromRemote } from "./load";
import { mouseMove_handleNoButtonDown } from "../mouse/mouse_move";
import { newUid } from "../util/uid";
import { HitboxType, HitboxFns } from "./hitbox";
import { itemState } from "../store/ItemState";
import { TableFlags } from "../items/base/flags-item";
import { VesCache } from "./ves-cache";
import { ItemGeometry } from "./item-geometry";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { CompositeItem, asCompositeItem, isComposite } from "../items/composite-item";
import { RelationshipToParent } from "./relationship-to-parent";

export const ARRANGE_ALGO_SPATIAL_STRETCH = "spatial-stretch"
export const ARRANGE_ALGO_GRID = "grid";
export const ARRANGE_ALGO_LIST = "list";

enum RenderStyle {
  Full,
  Outline,
}

const POPUP_LINK_ID = newUid();
const LIST_FOCUS_ID = newUid();



/**
 * Create the visual element tree for the current page.
 * 
 * Design note: Initially, this was implemented such that the visual element state was a function of the item
 * state (arrange was never called imperatively). The arrange function in that implementation did produce (nested)
 * visual element signals though, which had dependencies on the relevant part of the item state. In that
 * implementation, all the items were solidjs signals (whereas in the current approach they are not). The functional
 * approach was simpler from the point of view that the visual element tree did not need to be explicitly updated /
 * managed. However, it turned out to be a dead end:
 * 1. It was effectively impossible to perfectly optimize it in the case of resizing page items (and probably other
 *    scenarios) because the set of children were a function of page size. By comparison, as a general comment, the
 *    stateful approach makes it easy(er) to make precisely the optimal updates at precisely the required times.
 * 2. The visual element tree state is required for mouse interaction as well as rendering, and it was messy to
 *    create a cached version of this as a side effect of the functional arrange method. And there were associated
 *    bugs, which were not trivial to track down.
 * 3. The functional represenation was not straightforward (compared to the current approach) to reason about -
 *    you need to be very congisant of functional dependencies, what is being captured etc. Even though the direct
 *    approach is more ad-hoc / less "automated", I think the code is simpler to work on due to this.
 */
export const arrange = (desktopStore: DesktopStoreContextModel): void => {
  if (desktopStore.currentPage() == null) { return; }
  initiateLoadChildItemsIfNotLoaded(desktopStore, desktopStore.currentPage()!.itemId);
  let currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_GRID) {
    arrange_grid(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_SPATIAL_STRETCH) {
    arrange_spatialStretch(desktopStore);
  } else if (currentPage.arrangeAlgorithm == ARRANGE_ALGO_LIST) {
    arrange_list(desktopStore);
  }
  mouseMove_handleNoButtonDown(desktopStore);
}



// ARRANGE LIST PAGE

const arrange_list = (desktopStore: DesktopStoreContextModel) => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const selectedVeid = VeFns.veidFromPath(desktopStore.getSelectedListPageItem(desktopStore.currentPage()!));
  const topLevelPageBoundsPx  = desktopStore.desktopBoundsPx();
  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: topLevelPageBoundsPx,
    childAreaBoundsPx: topLevelPageBoundsPx,
  };

  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<currentPage.computed_children.length; ++idx) {
    const childItem = itemState.get(currentPage.computed_children[idx])!;
    const [displayItem, linkItemMaybe, _] = getVeItems(desktopStore, childItem);

    const widthBl = LIST_PAGE_LIST_WIDTH_BL;
    const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl);

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      flags: VisualElementFlags.LineItem |
             (VeFns.compareVeids(selectedVeid, VeFns.createVeid(displayItem, linkItemMaybe)) == 0 ? VisualElementFlags.Selected : VisualElementFlags.None),
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
      col: 0,
      row: idx,
      oneBlockWidthPx: LINE_HEIGHT_PX,
    };
    const childPath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem, linkItemMaybe), currentPath);
    const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
    listVeChildren.push(listItemVisualElementSignal);
  }
  topLevelVisualElementSpec.children = listVeChildren;

  if (selectedVeid != EMPTY_VEID) {
    const boundsPx = {
      x: (LIST_PAGE_LIST_WIDTH_BL+1) * LINE_HEIGHT_PX,
      y: LINE_HEIGHT_PX,
      w: desktopStore.desktopBoundsPx().w - ((LIST_PAGE_LIST_WIDTH_BL+2) * LINE_HEIGHT_PX),
      h: desktopStore.desktopBoundsPx().h - (2 * LINE_HEIGHT_PX)
    };
    topLevelVisualElementSpec.children.push(
      arrangeSelectedListItem(desktopStore, selectedVeid, boundsPx, currentPath));
  }

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}

function arrangeSelectedListItem(desktopStore: DesktopStoreContextModel, veid: Veid, boundsPx: BoundingBox, currentPath: VisualElementPath): VisualElementSignal {
  const item = itemState.get(veid.itemId)!;

  let li = LinkFns.create(item.ownerId, item.parentId, RelationshipToParent.Child, newOrdering(), veid.itemId);
  li.id = LIST_FOCUS_ID;
  if (isXSizableItem(item)) {
    li.spatialWidthGr = asXSizableItem(item).spatialWidthGr;
  }
  if (isYSizableItem(item)) {
    li.spatialHeightGr = asYSizableItem(item).spatialHeightGr;
  }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  const geometry = ItemFns.calcGeometry_InCell(li, boundsPx);

  return arrangeItem(desktopStore, currentPath, ARRANGE_ALGO_LIST, li, geometry, true, false, true);
}



// SPATIAL STRETCH

const arrange_spatialStretch = (desktopStore: DesktopStoreContextModel) => {
  const pageItem = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const desktopAspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
  const pageAspect = pageItem.naturalAspect;
  const pageBoundsPx = (() => {
    let result = desktopStore.desktopBoundsPx();
    // TODO (MEDIUM): make these cutoff aspect ratios configurable in user settings.
    if (pageAspect / desktopAspect > 1.18) {
      // page to scroll horizontally.
      result.w = Math.round(result.h * pageAspect);
    } else if (pageAspect / desktopAspect < 0.82) {
      // page needs to scroll vertically.
      result.h = Math.round(result.w / pageAspect);
    }
    return result;
  })();

  VesCache.initFullArrange();

  const currentPath = pageItem.id;

  const visualElementSpec: VisualElementSpec = {
    displayItem: pageItem,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: pageBoundsPx,
    childAreaBoundsPx: pageBoundsPx,
  };

  const children = pageItem.computed_children
    .map(childId => arrangeItem_Desktop(
      desktopStore,
      currentPath,
      itemState.get(childId)!,
      pageItem, // parent item
      pageBoundsPx,
      true, // render children as full
      false, // parent is popup
      false // is popup
    ));

  const currentPopupSpec = desktopStore.currentPopupSpec();
  if (currentPopupSpec != null) {
    if (currentPopupSpec.type == PopupType.Page) {
      // Position of page popup in spatial pages is user defined.
      const popupLinkToPageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
      const li = LinkFns.create(pageItem.ownerId, pageItem.id, RelationshipToParent.Child, newOrdering(), popupLinkToPageId!);
      li.id = POPUP_LINK_ID;
      const widthGr = PageFns.getPopupWidthGr(pageItem);
      const heightGr = Math.round((widthGr / pageItem.naturalAspect / GRID_SIZE)/ 2.0) * GRID_SIZE;
      li.spatialWidthGr = widthGr;
      // assume center positioning.
      li.spatialPositionGr = {
        x: PageFns.getPopupPositionGr(pageItem).x - widthGr / 2.0,
        y: PageFns.getPopupPositionGr(pageItem).y - heightGr / 2.0
      };
      children.push(
        arrangeItem_Desktop(
          desktopStore,
          currentPath,
          li,
          pageItem, // parent item
          pageBoundsPx,
          true, // render children as full
          false, // parent is popup
          true // is popup
        ));
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.
    } else if (currentPopupSpec.type == PopupType.Image) {
      children.push(arrangeCellPopup(desktopStore));
    } else {
      panic();
    }
  }

  visualElementSpec.children = children;

  VesCache.finalizeFullArrange(visualElementSpec, currentPath, desktopStore);
}


const arrangeItem_Desktop = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    item: Item,
    parentPage: PageItem,
    parentPageBoundsPx: BoundingBox,
    renderChildrenAsFull: boolean,
    parentIsPopup: boolean,
    isPopup: boolean): VisualElementSignal => {
  const [displayItem, linkItemMaybe, _] = getVeItems(desktopStore, item);
  const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
  const itemGeometry = ItemFns.calcGeometry_Desktop(
    linkItemMaybe ? linkItemMaybe : displayItem, zeroBoundingBoxTopLeft(parentPageBoundsPx), parentPageInnerDimensionsBl, parentIsPopup, true);
  return arrangeItem(desktopStore, parentPath, ARRANGE_ALGO_SPATIAL_STRETCH, item, itemGeometry, renderChildrenAsFull, isPopup, false);
}



// ARRANGE GRID PAGE

const arrange_grid = (desktopStore: DesktopStoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

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

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: boundsPx,
    childAreaBoundsPx: boundsPx,
  };

  const children = [];
  for (let i=0; i<currentPage.computed_children.length; ++i) {
    const item = itemState.get(currentPage.computed_children[i])!;
    const col = i % numCols;
    const row = Math.floor(i / numCols);
    const cellBoundsPx = {
      x: col * cellWPx + marginPx,
      y: row * cellHPx + marginPx,
      w: cellWPx - marginPx * 2.0,
      h: cellHPx - marginPx * 2.0
    };

    const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx);
    const ves = arrangeItem(desktopStore, currentPath, ARRANGE_ALGO_GRID, item, geometry, true, false, false);
    children.push(ves);
  }

  const currentPopupSpec = desktopStore.currentPopupSpec();
  if (currentPopupSpec != null) {
    if (currentPopupSpec.type == PopupType.Page) {
      children.push(arrangeCellPopup(desktopStore));
    } else if (currentPopupSpec.type == PopupType.Attachment) {
      // Ves are created inline.
    } else if (currentPopupSpec.type == PopupType.Image) {
      children.push(arrangeCellPopup(desktopStore));
    } else {
      panic();
    }
  }

  topLevelVisualElementSpec.children = children;

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}



// --------

const arrangeItem = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    parentArrangeAlgorithm: string,
    item: Item,
    itemGeometry: ItemGeometry,
    renderChildrenAsFull: boolean,
    isPopup: boolean,
    isRoot: boolean): VisualElementSignal => {
  if (isPopup && !isLink(item)) { panic(); }

  const [displayItem, linkItemMaybe, spatialWidthGr] = getVeItems(desktopStore, item);

  if (renderChildrenAsFull &&
      (isPage(displayItem) &&
       (parentArrangeAlgorithm == ARRANGE_ALGO_SPATIAL_STRETCH
          ? // This test does not depend on pixel size, so is invariant over display devices.
            (spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)
          : // However, this test does.
            itemGeometry.boundsPx.w / LINE_HEIGHT_PX >= CHILD_ITEMS_VISIBLE_WIDTH_BL))) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, displayItem.id);
    return arrangePageWithChildren(
      desktopStore, parentPath, asPageItem(displayItem), linkItemMaybe, itemGeometry, isPopup, isRoot);
  }

  if (isTable(displayItem) && (item.parentId == desktopStore.currentPage()!.itemId || renderChildrenAsFull)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, displayItem.id);
    return arrangeTable(
      desktopStore, parentPath, asTableItem(displayItem), linkItemMaybe, itemGeometry);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsIfNotLoaded(desktopStore, displayItem.id);
    return arrangeComposite(
      desktopStore, parentPath, asCompositeItem(displayItem), linkItemMaybe, itemGeometry);
  }

  const renderStyle = renderChildrenAsFull
    ? RenderStyle.Full
    : RenderStyle.Outline;

  return arrangeItemNoChildren(desktopStore, parentPath, displayItem, linkItemMaybe, itemGeometry, isPopup, renderStyle);
}


const arrangePageWithChildren = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    isPagePopup: boolean,
    isRoot: boolean): VisualElementSignal => {
  const pageWithChildrenVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren), parentPath);

  let outerBoundsPx = geometry.boundsPx;
  let hitboxes = geometry.hitboxes;
  if (isPagePopup) {
    const spatialWidthBl = linkItemMaybe_pageWithChildren!.spatialWidthGr / GRID_SIZE;
    const widthPx = outerBoundsPx.w;
    const blockWidthPx = widthPx / spatialWidthBl;
    const toolbarWidthPx = blockWidthPx * POPUP_TOOLBAR_WIDTH_BL;
    outerBoundsPx = {
      x: geometry.boundsPx.x - toolbarWidthPx,
      y: geometry.boundsPx.y,
      w: geometry.boundsPx.w + toolbarWidthPx,
      h: geometry.boundsPx.h,
    };
    const rsHbs = geometry.hitboxes.filter(hb => hb.type == HitboxType.Resize);
    if (rsHbs.length == 0) { // popup page in page type that does not allow it to be moved.
      hitboxes = [];
    } else {
      const defaultResizeHitbox = rsHbs[0];
      if (defaultResizeHitbox.type != HitboxType.Resize) { panic(); }
      const rhbBoundsPx = defaultResizeHitbox.boundsPx;
      hitboxes = [
        HitboxFns.create(HitboxType.Resize, { x: rhbBoundsPx.x + toolbarWidthPx, y: rhbBoundsPx.y, w: rhbBoundsPx.w, h: rhbBoundsPx.h }),
        HitboxFns.create(HitboxType.Move, { x: 0, y: 0, w: toolbarWidthPx, h: outerBoundsPx.h })
      ];
    }
  }

  let pageWithChildrenVisualElementSpec: VisualElementSpec;


  // *** GRID ***
  if (displayItem_pageWithChildren.arrangeAlgorithm == ARRANGE_ALGO_GRID) {

    const pageItem = asPageItem(displayItem_pageWithChildren);
    const numCols = pageItem.gridNumberOfColumns;
    const numRows = Math.ceil(pageItem.computed_children.length / numCols);
    const cellWPx = geometry.boundsPx.w / numCols;
    const cellHPx = cellWPx * (1.0/GRID_PAGE_CELL_ASPECT);
    const marginPx = cellWPx * 0.01;
    const pageHeightPx = numRows * cellHPx;
    const boundsPx = (() => {
      const result = cloneBoundingBox(geometry.boundsPx)!;
      result.h = pageHeightPx;
      return result;
    })();

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
            (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
            (isRoot ? VisualElementFlags.Root : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: boundsPx,
      hitboxes,
      parentPath,
    };

    const children = [];
    for (let i=0; i<pageItem.computed_children.length; ++i) {
      const item = itemState.get(pageItem.computed_children[i])!;
      const col = i % numCols;
      const row = Math.floor(i / numCols);
      const cellBoundsPx = {
        x: col * cellWPx + marginPx,
        y: row * cellHPx + marginPx,
        w: cellWPx - marginPx * 2.0,
        h: cellHPx - marginPx * 2.0
      };

      let geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx);
      if (!isLink(item)) {
        const veSpec: VisualElementSpec = {
          displayItem: item,
          flags: isPagePopup ? VisualElementFlags.Detailed : VisualElementFlags.None,
          boundsPx: geometry.boundsPx,
          childAreaBoundsPx: geometry.boundsPx, // TODO (HIGH): incorrect.
          hitboxes: geometry.hitboxes,
          parentPath: pageWithChildrenVePath,
        };
        const childPath = VeFns.prependVeidToPath(VeFns.createVeid(item, null), pageWithChildrenVePath);
        const ves = VesCache.createOrRecycleVisualElementSignal(veSpec, childPath);

        children.push(ves);
      } else {
        console.log("TODO: child tables in grid pages.");
      }
    }
    pageWithChildrenVisualElementSpec.children = children;


  // *** SPATIAL_STRETCH ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ARRANGE_ALGO_SPATIAL_STRETCH) {

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    pageWithChildrenVisualElementSpec.children = displayItem_pageWithChildren.computed_children.map(childId => {
      const itemIsPopup = false;
      const childItem = itemState.get(childId)!;
      if (isPagePopup || isRoot) {
        return arrangeItem_Desktop(
          desktopStore,
          pageWithChildrenVePath,
          childItem,
          displayItem_pageWithChildren, // parent item
          pageWithChildrenVisualElementSpec.childAreaBoundsPx!,
          true, // render children as full
          isPagePopup, // parent is popup
          itemIsPopup,
        );
      } else {
        const [displayItem, linkItemMaybe, _] = getVeItems(desktopStore, childItem);
        const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
        const itemGeometry = ItemFns.calcGeometry_Desktop(
          linkItemMaybe ? linkItemMaybe : displayItem,
          innerBoundsPx, parentPageInnerDimensionsBl, isPagePopup, true);
        return arrangeItemNoChildren(desktopStore, pageWithChildrenVePath, displayItem, linkItemMaybe, itemGeometry, itemIsPopup, RenderStyle.Outline);
      }
    });


  // *** LIST VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ARRANGE_ALGO_LIST) {

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    const _innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
      const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
      const [displayItem, linkItemMaybe, _] = getVeItems(desktopStore, childItem);
      const selectedVeid = VeFns.veidFromPath(desktopStore.getSelectedListPageItem({ itemId: displayItem.id, linkIdMaybe: linkItemMaybe ? linkItemMaybe.id : null }));

      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX, h: LINE_HEIGHT_PX };

      const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl);

      const listItemVeSpec: VisualElementSpec = {
        displayItem,
        linkItemMaybe,
        flags: VisualElementFlags.LineItem |
               (VeFns.compareVeids(selectedVeid, VeFns.createVeid(displayItem, linkItemMaybe)) == 0 ? VisualElementFlags.Selected : VisualElementFlags.None),
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: idx,
        oneBlockWidthPx: LINE_HEIGHT_PX,
      };
      const childPath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem, linkItemMaybe), pageWithChildrenVePath);
      const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
      listVeChildren.push(listItemVisualElementSignal);
    }
    pageWithChildrenVisualElementSpec.children = listVeChildren;


  } else {

    panic();
  }

  const attachments = arrangeItemAttachments(desktopStore, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, outerBoundsPx, pageWithChildrenVePath);
  pageWithChildrenVisualElementSpec.attachments = attachments;

  const pageWithChildrenVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  return pageWithChildrenVisualElementSignal;
}


const arrangeComposite = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Composite: CompositeItem,
    linkItemMaybe_Composite: LinkItem | null,
    compositeGeometry: ItemGeometry): VisualElementSignal => {
  const compositeVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_Composite, linkItemMaybe_Composite), parentPath);

  let childAreaBoundsPx = {
    x: compositeGeometry.boundsPx.x, y: compositeGeometry.boundsPx.y,
    w: compositeGeometry.boundsPx.w, h: compositeGeometry.boundsPx.h
  };

  const compositeVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Composite,
    linkItemMaybe: linkItemMaybe_Composite,
    flags: VisualElementFlags.Detailed,
    boundsPx: compositeGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: compositeGeometry.hitboxes,
    parentPath,
  };

  const compositeSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_Composite ? linkItemMaybe_Composite : displayItem_Composite);
  const blockSizePx = { w: compositeGeometry.boundsPx.w / compositeSizeBl.w, h: compositeGeometry.boundsPx.h / compositeSizeBl.h };

  let compositeVeChildren: Array<VisualElementSignal> = [];
  let topPx = 0.0;
  for (let idx=0; idx<displayItem_Composite.computed_children.length; ++idx) {
    const childId = displayItem_Composite.computed_children[idx];
    const childItem = itemState.get(childId)!;

    const [displayItem_childItem, linkItemMaybe_childItem] = getVeItems(desktopStore, childItem);

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      compositeSizeBl.w,
      topPx);

    topPx += geometry.boundsPx.h;

    const compositeChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.InsideComposite | VisualElementFlags.Detailed,
      boundsPx: {
        x: geometry.boundsPx.x,
        y: geometry.boundsPx.y,
        w: geometry.boundsPx.w - ITEM_BORDER_WIDTH_PX*2,
        h: geometry.boundsPx.h - ITEM_BORDER_WIDTH_PX*2
      },
      hitboxes: geometry.hitboxes,
      parentPath: compositeVePath,
      col: 0,
      row: idx,
      oneBlockWidthPx: blockSizePx.w,
    };

    const compositeChildVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_childItem, linkItemMaybe_childItem), compositeVePath);
    const compositeChildVeSignal = VesCache.createOrRecycleVisualElementSignal(compositeChildVeSpec, compositeChildVePath);
    compositeVeChildren.push(compositeChildVeSignal);
  }

  compositeVisualElementSpec.children = compositeVeChildren;

  const attachments = arrangeItemAttachments(desktopStore, displayItem_Composite, linkItemMaybe_Composite, compositeGeometry.boundsPx, compositeVePath);
  compositeVisualElementSpec.attachments = attachments;

  const compositeVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(compositeVisualElementSpec, compositeVePath);

  return compositeVisualElementSignal;
}


const arrangeTable = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Table: TableItem,
    linkItemMaybe_Table: LinkItem | null,
    tableGeometry: ItemGeometry): VisualElementSignal => {

  const sizeBl = linkItemMaybe_Table
    ? { w: linkItemMaybe_Table!.spatialWidthGr / GRID_SIZE, h: linkItemMaybe_Table!.spatialHeightGr / GRID_SIZE }
    : { w: displayItem_Table.spatialWidthGr / GRID_SIZE, h: displayItem_Table.spatialHeightGr / GRID_SIZE };
  const blockSizePx = { w: tableGeometry.boundsPx.w / sizeBl.w, h: tableGeometry.boundsPx.h / sizeBl.h };
  const headerHeightPx = blockSizePx.h * HEADER_HEIGHT_BL;
  const colHeaderHeightPx = ((displayItem_Table.flags & TableFlags.ShowColHeader)) ? (blockSizePx.h * COL_HEADER_HEIGHT_BL) : 0;

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
  const tableVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_Table, linkItemMaybe_Table), parentPath);

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_Table.computed_children.length; ++idx) {
    const childId = displayItem_Table.computed_children[idx];
    const childItem = itemState.get(childId)!;
    const [displayItem_childItem, linkItemMaybe_childItem] = getVeItems(desktopStore, childItem);

    let widthBl = displayItem_Table.tableColumns.length == 1
      ? sizeBl.w
      : Math.min(displayItem_Table.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl);

    const tableChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.LineItem | VisualElementFlags.InsideTable,
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: tableVePath,
      col: 0,
      row: idx,
      oneBlockWidthPx: blockSizePx.w,
    };
    const tableChildVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

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
        const attachmentItem = itemState.get(attachmentId)!;
        const [displayItem_attachment, linkItemMaybe_attachment] = getVeItems(desktopStore, attachmentItem);

        const geometry = ItemFns.calcGeometry_ListItem(attachmentItem, blockSizePx, idx, leftBl, widthBl);

        const tableChildAttachmentVeSpec: VisualElementSpec = {
          displayItem: displayItem_attachment,
          linkItemMaybe: linkItemMaybe_attachment,
          flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
          boundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          col: i + 1,
          row: idx,
          parentPath: tableChildVePath,
          oneBlockWidthPx: blockSizePx.w
        };
        const tableChildAttachmentVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
        const tableChildAttachmentVeSignal = VesCache.createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);
        tableItemVeAttachments.push(tableChildAttachmentVeSignal);
        leftBl += displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      }

      tableChildVeSpec.attachments = tableItemVeAttachments;
    }
    const tableItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);
    tableVeChildren.push(tableItemVisualElementSignal);
  };

  tableVisualElementSpec.children = tableVeChildren;

  const attachments = arrangeItemAttachments(desktopStore, displayItem_Table, linkItemMaybe_Table, tableGeometry.boundsPx, tableVePath);
  tableVisualElementSpec.attachments = attachments;

  const tableVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableVisualElementSpec, tableVePath);

  return tableVisualElementSignal;
}


/**
 * Given an item, calculate the visual element display item (what is visually depicted), linkItemMaybe and spatialWidthGr.
 */
function getVeItems(desktopStore: DesktopStoreContextModel, item: Item): [Item, LinkItem | null, number] {
  let displayItem = item;
  let linkItemMaybe: LinkItem | null = null;
  let spatialWidthGr = isXSizableItem(displayItem)
    ? asXSizableItem(displayItem).spatialWidthGr
    : 0;
  if (isLink(item)) {
    linkItemMaybe = asLinkItem(item);
    const linkToId = LinkFns.getLinkToId(linkItemMaybe);
    const displayItemMaybe = itemState.get(linkToId)!;
    if (displayItemMaybe != null) {
      displayItem = displayItemMaybe!;
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


const arrangeItemNoChildren = (
    desktopStore: DesktopStoreContextModel,
    parentVePath: VisualElementPath,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    itemGeometry: ItemGeometry,
    isPopup: boolean,
    renderStyle: RenderStyle): VisualElementSignal => {
  const currentVePath = VeFns.prependVeidToPath(VeFns.createVeid(displayItem, linkItemMaybe), parentVePath);

  const item = displayItem != null ? displayItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (renderStyle != RenderStyle.Outline ? VisualElementFlags.Detailed : VisualElementFlags.None) |
           (isPopup ? VisualElementFlags.Popup : VisualElementFlags.None),
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  itemVisualElement.attachments = arrangeItemAttachments(desktopStore, displayItem, linkItemMaybe, itemGeometry.boundsPx, currentVePath);

  const itemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(itemVisualElement, currentVePath);

  return itemVisualElementSignal;
}


function arrangeItemAttachments(
    desktopStore: DesktopStoreContextModel,
    parentDisplayItem: Item,
    parentLinkItemMaybe: LinkItem | null,
    parentItemBoundsPx: BoundingBox,
    parentItemVePath: VisualElementPath): Array<VisualElementSignal> {

  if (!isAttachmentsItem(parentDisplayItem)) {
    return [];
  }
  const attachmentsItem = asAttachmentsItem(parentDisplayItem);

  const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(parentLinkItemMaybe == null ? parentDisplayItem : parentLinkItemMaybe);

  const attachments: Array<VisualElementSignal> = [];
  for (let i=0; i<attachmentsItem.computed_attachments.length; ++i) {
    const attachmentId = attachmentsItem.computed_attachments[i];
    const attachmentItem = itemState.get(attachmentId)!;
    const [attachmentDisplayItem, attachmentLinkItemMaybe, _] = getVeItems(desktopStore, attachmentItem);
    const attachmentVeid: Veid = {
      itemId: attachmentDisplayItem.id,
      linkIdMaybe: attachmentLinkItemMaybe ? attachmentLinkItemMaybe.id : null
    };
    const attachmentVePath = VeFns.prependVeidToPath(attachmentVeid, parentItemVePath);

    const popupSpec = desktopStore.currentPopupSpec();
    let isSelected = false;
    if (popupSpec != null && popupSpec.type == PopupType.Attachment) {
      if (attachmentVePath == popupSpec.vePath) {
        isSelected = true;
      }
    }

    const attachmentGeometry = ItemFns.calcGeometry_Attachment(attachmentItem, parentItemBoundsPx, parentItemSizeBl, i, isSelected);

    const veSpec: VisualElementSpec = {
      displayItem: attachmentDisplayItem,
      linkItemMaybe: attachmentLinkItemMaybe,
      boundsPx: attachmentGeometry.boundsPx,
      hitboxes: attachmentGeometry.hitboxes,
      parentPath: parentItemVePath,
      flags: VisualElementFlags.Attachment |
             (isSelected ? VisualElementFlags.Detailed : VisualElementFlags.None),
    };
    const attachmentVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(veSpec, attachmentVePath);
    attachments.push(attachmentVisualElementSignal);
  }

  return attachments;
}


function arrangeCellPopup(desktopStore: DesktopStoreContextModel): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = VeFns.prependVeidToPath(VeFns.createVeid(currentPage, null), "");
  const currentPopupSpec = desktopStore.currentPopupSpec()!;

  const popupLinkToImageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, newOrdering(), popupLinkToImageId!);
  li.id = POPUP_LINK_ID;
  li.spatialWidthGr = 1000;
  li.spatialPositionGr = { x: 0, y: 0, };
  const desktopBoundsPx = desktopStore.desktopBoundsPx();
  const cellBoundsPx = {
    x: desktopBoundsPx.w * 0.1,
    y: desktopBoundsPx.h * 0.07,
    w: desktopBoundsPx.w * 0.8,
    h: desktopBoundsPx.h * 0.8,
  };
  let geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx);

  const item = itemState.get(popupLinkToImageId)!;

  if (isPage(item)) {
    let ves: VisualElementSignal;
    batch(() => {
      ves = arrangeItem(desktopStore, currentPath, currentPage.arrangeAlgorithm, li, geometry, true, true, true);
      let newV = ves.get();
      newV.flags |= (currentPage.arrangeAlgorithm == ARRANGE_ALGO_GRID ? VisualElementFlags.Fixed : VisualElementFlags.None);
      ves.set(newV);
    });
    return ves!;
  } else {
    const itemVisualElement: VisualElementSpec = {
      displayItem: item,
      linkItemMaybe: li,
      flags: VisualElementFlags.Detailed | VisualElementFlags.Popup |
             (currentPage.arrangeAlgorithm == ARRANGE_ALGO_GRID ? VisualElementFlags.Fixed : VisualElementFlags.None),
      boundsPx: geometry.boundsPx,
      childAreaBoundsPx: isPage(item) ? geometry.boundsPx : undefined,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
    };

    const itemPath = VeFns.prependVeidToPath(VeFns.createVeid(item, li), currentPath);
    itemVisualElement.attachments = arrangeItemAttachments(desktopStore, item, li, geometry.boundsPx, itemPath);
    return VesCache.createOrRecycleVisualElementSignal(itemVisualElement, itemPath);
  }
}
