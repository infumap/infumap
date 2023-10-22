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

import { COL_HEADER_HEIGHT_BL, HEADER_HEIGHT_BL } from "../../components/items/Table";
import { CHILD_ITEMS_VISIBLE_WIDTH_BL, COMPOSITE_ITEM_GAP_BL, GRID_PAGE_CELL_ASPECT, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL } from "../../constants";
import { DesktopStoreContextModel } from "../../store/DesktopStoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PageItem, asPageItem, isPage, PageFns, ArrangeAlgorithm } from "../../items/page-item";
import { TableItem, asTableItem, isTable } from "../../items/table-item";
import { VisualElementFlags, VisualElementSpec, VisualElementPath, VeFns, EMPTY_VEID, Veid } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { LinkFns, LinkItem, isLink } from "../../items/link-item";
import { panic } from "../../util/lang";
import { initiateLoadChildItemsMaybe } from "../load";
import { itemState } from "../../store/ItemState";
import { TableFlags } from "../../items/base/flags-item";
import { VesCache } from "../ves-cache";
import { ItemGeometry } from "../item-geometry";
import { CompositeItem, asCompositeItem, isComposite } from "../../items/composite-item";
import { arrangeItemAttachments } from "./attachments";
import { getVePropertiesForItem } from "./util";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { newUid } from "../../util/uid";
import { RelationshipToParent } from "../relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { LastMouseMoveEventState, MouseAction, MouseActionState } from "../../mouse/state";


const PAGE_TITLE_UID = newUid();

export const arrangeItem = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    parentArrangeAlgorithm: string,
    item: Item,
    itemGeometry: ItemGeometry,
    renderChildrenAsFull: boolean,
    isPopup: boolean,
    isRoot: boolean): VisualElementSignal => {
  if (isPopup && !isLink(item)) { panic(); }

  const { displayItem, linkItemMaybe, spatialWidthGr } = getVePropertiesForItem(desktopStore, item);
  const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);

  let isMoving = false;
  if (!MouseActionState.empty() && MouseActionState.get().action == MouseAction.Moving) {
    const activeElementPath = MouseActionState.get().activeElement;
    if (activeElementPath == VeFns.addVeidToPath(itemVeid, parentPath)) {
      isMoving = true;
    }
  }

  if (renderChildrenAsFull &&
      (isPage(displayItem) &&
       (parentArrangeAlgorithm == ArrangeAlgorithm.SpatialStretch
          ? // This test does not depend on pixel size, so is invariant over display devices.
            (spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)
          : // However, this test does.
            itemGeometry.boundsPx.w / LINE_HEIGHT_PX >= CHILD_ITEMS_VISIBLE_WIDTH_BL))) {
    initiateLoadChildItemsMaybe(desktopStore, itemVeid);
    return arrangePageWithChildren(
      desktopStore, parentPath, asPageItem(displayItem), linkItemMaybe, itemGeometry, isPopup, isRoot, isMoving);
  }

  if (isTable(displayItem) && (item.parentId == desktopStore.currentPage()!.itemId || renderChildrenAsFull)) {
    initiateLoadChildItemsMaybe(desktopStore, itemVeid);
    return arrangeTable(
      desktopStore, parentPath, asTableItem(displayItem), linkItemMaybe, itemGeometry, isMoving);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(desktopStore, itemVeid);
    return arrangeComposite(
      desktopStore, parentPath, asCompositeItem(displayItem), linkItemMaybe, itemGeometry, isMoving);
  }

  const renderAsOutline = !renderChildrenAsFull;
  return arrangeItemNoChildren(desktopStore, parentPath, displayItem, linkItemMaybe, itemGeometry, isPopup, isMoving, renderAsOutline);
}


const arrangePageWithChildren = (
    desktopStore: DesktopStoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    isPagePopup: boolean,
    isRoot: boolean,
    isMoving: boolean): VisualElementSignal => {
  const pageWithChildrenVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren), parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  let pageWithChildrenVisualElementSpec: VisualElementSpec;


  // *** GRID ***
  if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Grid) {

    let movingItem = null;
    if (!MouseActionState.empty() && (MouseActionState.get().action & MouseAction.Moving)) {
      const veid = VeFns.veidFromPath(MouseActionState.get().activeElement);
      if (veid.linkIdMaybe) {
        movingItem = itemState.get(veid.linkIdMaybe);
      } else {
        movingItem = itemState.get(veid.itemId);
      }
      if (movingItem!.parentId != displayItem_pageWithChildren.id) {
        movingItem = null;
      }
    }
    const movingItemIsNewlyCreatedLink = !MouseActionState.empty() && movingItem && MouseActionState.get().linkCreatedOnMoveStart;

    const scale = geometry.boundsPx.w / desktopStore.desktopBoundsPx().w;

    const headingMarginPx = isPagePopup || isRoot ? LINE_HEIGHT_PX * (PageFns.pageTitleStyle().lineHeightMultiplier) * scale : 0;

    const pageItem = asPageItem(displayItem_pageWithChildren);
    const numCols = pageItem.gridNumberOfColumns;
    // don't leave a space for link items that were created at the start of the move action.
    const numRows = Math.ceil((pageItem.computed_children.length - (movingItemIsNewlyCreatedLink ? 1 : 0)) / numCols);
    const cellWPx = geometry.boundsPx.w / numCols;
    const cellHPx = cellWPx * (1.0/GRID_PAGE_CELL_ASPECT);
    const marginPx = cellWPx * 0.01;
    const pageHeightPx = numRows * cellHPx + headingMarginPx;
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
            (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
            (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: boundsPx,
      hitboxes,
      parentPath,
    };

    function arrangePageTitle(): VisualElementSignal {
      const pageTitleDimensionsBl = PageFns.calcTitleSpatialDimensionsBl(displayItem_pageWithChildren);

      const li = LinkFns.create(displayItem_pageWithChildren.ownerId, displayItem_pageWithChildren.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(displayItem_pageWithChildren.id), displayItem_pageWithChildren.id!);
      li.id = PAGE_TITLE_UID;
      li.spatialWidthGr = pageTitleDimensionsBl.w * GRID_SIZE;
      li.spatialPositionGr = { x: 0, y: 0 };

      const geometry = PageFns.calcGeometry_GridPageTitle(desktopStore, displayItem_pageWithChildren, pageWithChildrenVisualElementSpec.childAreaBoundsPx!);
      const pageTitleElementSpec: VisualElementSpec = {
        displayItem: displayItem_pageWithChildren,
        linkItemMaybe: li,
        flags: VisualElementFlags.PageTitle,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath,
      };

      const pageTitlePath = VeFns.addVeidToPath({ itemId: displayItem_pageWithChildren.id, linkIdMaybe: PAGE_TITLE_UID }, parentPath);
      return VesCache.createOrRecycleVisualElementSignal(pageTitleElementSpec, pageTitlePath);
    }

    const children = isPagePopup || isRoot ? [arrangePageTitle()] : [];
    let idx = 0;
    for (let i=0; i<pageItem.computed_children.length; ++i) {
      const item = itemState.get(pageItem.computed_children[i])!;
      if (movingItemIsNewlyCreatedLink && item.id == movingItem!.id) {
        continue;
      }
      const col = idx % numCols;
      const row = Math.floor(idx / numCols);
      idx += 1;
      const cellBoundsPx = {
        x: col * cellWPx + marginPx,
        y: row * cellHPx + marginPx + headingMarginPx,
        w: cellWPx - marginPx * 2.0,
        h: cellHPx - marginPx * 2.0
      };

      let geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false);
      const ves = arrangeItem(desktopStore, pageWithChildrenVePath, ArrangeAlgorithm.Grid, item, geometry, true, false, false);
      children.push(ves);
    }

    if (movingItem) {
      const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItem);
      const cellBoundsPx = {
        x: LastMouseMoveEventState.get().clientX - outerBoundsPx.x,
        y: LastMouseMoveEventState.get().clientY - outerBoundsPx.y,
        w: dimensionsBl.w * LINE_HEIGHT_PX * scale,
        h: dimensionsBl.h * LINE_HEIGHT_PX * scale,
      };
      const geometry = ItemFns.calcGeometry_InCell(movingItem, cellBoundsPx, false);
      const ves = arrangeItem(desktopStore, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItem, geometry, true, false, false);
      children.push(ves);
    }

    pageWithChildrenVisualElementSpec.children = children;


  // *** SPATIAL_STRETCH ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    const innerBoundsPx = zeroBoundingBoxTopLeft(geometry.boundsPx);

    function arrangePageTitle(): VisualElementSignal {
      const pageTitleDimensionsBl = PageFns.calcTitleSpatialDimensionsBl(displayItem_pageWithChildren);

      const li = LinkFns.create(displayItem_pageWithChildren.ownerId, displayItem_pageWithChildren.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(displayItem_pageWithChildren.id), displayItem_pageWithChildren.id!);
      li.id = PAGE_TITLE_UID;
      li.spatialWidthGr = pageTitleDimensionsBl.w * GRID_SIZE;
      li.spatialPositionGr = { x: 0, y: 0 };

      const geometry = PageFns.calcGeometry_SpatialPageTitle(displayItem_pageWithChildren, pageWithChildrenVisualElementSpec.childAreaBoundsPx!);
      const pageTitleElementSpec: VisualElementSpec = {
        displayItem: displayItem_pageWithChildren,
        linkItemMaybe: li,
        flags: VisualElementFlags.PageTitle,
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath,
      };

      const pageTitlePath = VeFns.addVeidToPath({ itemId: displayItem_pageWithChildren.id, linkIdMaybe: PAGE_TITLE_UID }, parentPath);
      return VesCache.createOrRecycleVisualElementSignal(pageTitleElementSpec, pageTitlePath);
    }

    const children = isPagePopup || isRoot ? [arrangePageTitle()] : [];
    for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
      const childId = displayItem_pageWithChildren.computed_children[i];
      const childItem = itemState.get(childId)!;
      const parentIsPopup = isPagePopup;
      const emitHitboxes = true;
      const childItemIsPopup = false; // never the case.
      const hasPendingChanges = false; // it may do, but only matters for popups.
      if (isPagePopup || isRoot) {
        const itemGeometry = ItemFns.calcGeometry_Spatial(
          childItem,
          zeroBoundingBoxTopLeft(pageWithChildrenVisualElementSpec.childAreaBoundsPx!),
          PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren),
          parentIsPopup,
          emitHitboxes,
          childItemIsPopup,
          hasPendingChanges);
        children.push(arrangeItem(desktopStore, pageWithChildrenVePath, ArrangeAlgorithm.SpatialStretch, childItem, itemGeometry, true, childItemIsPopup, false));
      } else {
        const { displayItem, linkItemMaybe } = getVePropertiesForItem(desktopStore, childItem);
        const parentPageInnerDimensionsBl = PageFns.calcInnerSpatialDimensionsBl(displayItem_pageWithChildren);
        const itemGeometry = ItemFns.calcGeometry_Spatial(
          childItem,
          innerBoundsPx,
          parentPageInnerDimensionsBl,
          parentIsPopup,
          emitHitboxes,
          childItemIsPopup,
          hasPendingChanges);
        children.push(arrangeItemNoChildren(desktopStore, pageWithChildrenVePath, displayItem, linkItemMaybe, itemGeometry, childItemIsPopup, isMoving, true));
      }
    }
    pageWithChildrenVisualElementSpec.children = children;


  // *** LIST VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.List) {

    const scale = outerBoundsPx.w / desktopStore.desktopBoundsPx().w;

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    let selectedVeid = EMPTY_VEID;
    if (isPagePopup) {
      const poppedUp = desktopStore.currentPopupSpec()!;
      const poppedUpPath = poppedUp.vePath;
      const poppedUpVeid = VeFns.veidFromPath(poppedUpPath);
      selectedVeid = VeFns.veidFromPath(desktopStore.getSelectedListPageItem(poppedUpVeid));
    } else if (isRoot) {
      // TODO (MEDIUM): list pages in list pages.
      console.log("not implemented");
    } else {
      const listPageVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
      selectedVeid = VeFns.veidFromPath(desktopStore.getSelectedListPageItem(listPageVeid)!);
    }

    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
      const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(desktopStore, childItem);

      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

      const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx + 1, 0, widthBl);

      const listItemVeSpec: VisualElementSpec = {
        displayItem,
        linkItemMaybe,
        flags: VisualElementFlags.LineItem |
               (VeFns.compareVeids(selectedVeid, VeFns.veidFromItems(displayItem, linkItemMaybe)) == 0 ? VisualElementFlags.Selected : VisualElementFlags.None),
        boundsPx: geometry.boundsPx,
        hitboxes: geometry.hitboxes,
        parentPath: pageWithChildrenVePath,
        col: 0,
        row: idx,
        oneBlockWidthPx: LINE_HEIGHT_PX * scale,
      };
      const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
      const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
      listVeChildren.push(listItemVisualElementSignal);
    }
    pageWithChildrenVisualElementSpec.children = listVeChildren;

    if (selectedVeid != EMPTY_VEID) {
      const boundsPx = {
        x: (LIST_PAGE_LIST_WIDTH_BL+1) * LINE_HEIGHT_PX * scale,
        y: LINE_HEIGHT_PX * scale,
        w: outerBoundsPx.w - ((LIST_PAGE_LIST_WIDTH_BL+2) * LINE_HEIGHT_PX) * scale,
        h: outerBoundsPx.h - (2 * LINE_HEIGHT_PX) * scale
      };
      pageWithChildrenVisualElementSpec.children.push(
        arrangeSelectedListItem(desktopStore, selectedVeid, boundsPx, pageWithChildrenVePath, false));
    }


  // *** DOCUMENT VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Document) {

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };


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
    compositeGeometry: ItemGeometry,
    isMoving: boolean): VisualElementSignal => {
  const compositeVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Composite, linkItemMaybe_Composite), parentPath);

  let childAreaBoundsPx = {
    x: compositeGeometry.boundsPx.x, y: compositeGeometry.boundsPx.y,
    w: compositeGeometry.boundsPx.w, h: compositeGeometry.boundsPx.h
  };

  const compositeVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Composite,
    linkItemMaybe: linkItemMaybe_Composite,
    flags: VisualElementFlags.Detailed |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
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

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(desktopStore, childItem);

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      compositeSizeBl.w,
      topPx);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;

    const compositeChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.InsideComposite | VisualElementFlags.Detailed,
      boundsPx: {
        x: geometry.boundsPx.x,
        y: geometry.boundsPx.y,
        w: geometry.boundsPx.w,
        h: geometry.boundsPx.h,
      },
      hitboxes: geometry.hitboxes,
      parentPath: compositeVePath,
      col: 0,
      row: idx,
      oneBlockWidthPx: blockSizePx.w,
    };

    const compositeChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), compositeVePath);
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
    tableGeometry: ItemGeometry,
    isMoving: boolean): VisualElementSignal => {

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
    flags: VisualElementFlags.Detailed |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
    boundsPx: tableGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: tableGeometry.hitboxes,
    parentPath,
  };
  const tableVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Table, linkItemMaybe_Table), parentPath);

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_Table.computed_children.length; ++idx) {
    const childId = displayItem_Table.computed_children[idx];
    const childItem = itemState.get(childId)!;
    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(desktopStore, childItem);
    const childVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);

    if (isComposite(displayItem_childItem)) {

      initiateLoadChildItemsMaybe(desktopStore, childVeid);
    }

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
    const tableChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), tableVePath);

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
        const { displayItem: displayItem_attachment, linkItemMaybe: linkItemMaybe_attachment } = getVePropertiesForItem(desktopStore, attachmentItem);
        const attachment_veid = VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment);

        if (isComposite(displayItem_attachment)) {
          initiateLoadChildItemsMaybe(desktopStore, attachment_veid);
        }

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
        const tableChildAttachmentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
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


const arrangeItemNoChildren = (
    desktopStore: DesktopStoreContextModel,
    parentVePath: VisualElementPath,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    itemGeometry: ItemGeometry,
    isPopup: boolean,
    isMoving: boolean,
    renderAsOutline: boolean): VisualElementSignal => {
  const currentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), parentVePath);

  const item = displayItem != null ? displayItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (renderAsOutline ? VisualElementFlags.None : VisualElementFlags.Detailed) |
           (isPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  itemVisualElement.attachments = arrangeItemAttachments(desktopStore, displayItem, linkItemMaybe, itemGeometry.boundsPx, currentVePath);

  const itemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(itemVisualElement, currentVePath);

  if (isNote(item)) {
    const noteItem = asNoteItem(item);
    if (NoteFns.isExpression(noteItem)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(itemVisualElementSignal.get()));
    }
  }

  return itemVisualElementSignal;
}


const LIST_FOCUS_ID = newUid();

export function arrangeSelectedListItem(desktopStore: DesktopStoreContextModel, veid: Veid, boundsPx: BoundingBox, currentPath: VisualElementPath, expandable: boolean): VisualElementSignal {
  const item = itemState.get(veid.itemId)!;

  let li = LinkFns.create(item.ownerId, item.parentId, RelationshipToParent.Child, newOrdering(), veid.itemId);
  li.id = LIST_FOCUS_ID;
  if (isXSizableItem(item)) { li.spatialWidthGr = asXSizableItem(item).spatialWidthGr; }
  if (isYSizableItem(item)) { li.spatialHeightGr = asYSizableItem(item).spatialHeightGr; }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  const geometry = ItemFns.calcGeometry_InCell(li, boundsPx, expandable);

  const result = arrangeItem(desktopStore, currentPath, ArrangeAlgorithm.List, li, geometry, true, false, true);
  return result;
}
