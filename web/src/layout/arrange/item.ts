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
import { BLOCK_SIZE_PX, CHILD_ITEMS_VISIBLE_WIDTH_BL, COMPOSITE_ITEM_GAP_BL, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, PAGE_DOCUMENT_LEFT_MARGIN_PX, PAGE_DOCUMENT_TOP_MARGIN_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { StoreContextModel } from "../../store/StoreProvider";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PageItem, asPageItem, isPage, ArrangeAlgorithm } from "../../items/page-item";
import { TableItem, asTableItem, isTable } from "../../items/table-item";
import { VisualElementFlags, VisualElementSpec, VisualElementPath, VeFns, EMPTY_VEID, Veid } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
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
import { MouseAction, MouseActionState } from "../../input/state";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { arrangeCellPopup } from "./popup";
import { arrange_grid_page } from "./page_grid";
import { arrange_spatial_page } from "./page_spatial";
import { arrange_justified_page } from "./page_justified";
import { arrange_document_page } from "./page_document";


export const arrangeItem = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    parentArrangeAlgorithm: string,
    item: Item,
    itemGeometry: ItemGeometry,
    renderChildrenAsFull: boolean,
    isPopup: boolean,
    isRoot: boolean,
    isListPageMainItem: boolean,
    parentIsPopup: boolean): VisualElementSignal => {
  if (isPopup && !isLink(item)) { panic("arrangeItem: popup isn't a link."); }

  const { displayItem, linkItemMaybe, spatialWidthGr } = getVePropertiesForItem(store, item);
  const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);

  let isMoving = false;
  if (!MouseActionState.empty() && MouseActionState.get().action == MouseAction.Moving) {
    const activeElementPath = MouseActionState.get().activeElement;
    if (activeElementPath == VeFns.addVeidToPath(itemVeid, parentPath)) {
      isMoving = true;
    }
  }

  const renderWithChildren = (() => {
    if (isRoot) { return true; }
    if (isPopup) { return true; }
    if (!renderChildrenAsFull) { return false; }
    if (!isPage(displayItem)) { return false; }
    if (parentArrangeAlgorithm == ArrangeAlgorithm.Dock) { return true; }
    return (parentArrangeAlgorithm == ArrangeAlgorithm.SpatialStretch
      ? // This test does not depend on pixel size, so is invariant over display devices.
        (spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL)
      : // However, this test does.
        itemGeometry.boundsPx.w / LINE_HEIGHT_PX >= CHILD_ITEMS_VISIBLE_WIDTH_BL);
  })();

  if (renderWithChildren) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangePageWithChildren(
      store, parentPath, realParentVeid, asPageItem(displayItem), linkItemMaybe, itemGeometry, isPopup, isRoot, isListPageMainItem, isMoving);
  }

  if (isTable(displayItem) && (item.parentId == store.history.currentPage()!.itemId || renderChildrenAsFull)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeTable(
      store, parentPath, asTableItem(displayItem), linkItemMaybe, itemGeometry, isListPageMainItem, parentIsPopup, isMoving);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeComposite(
      store, parentPath, asCompositeItem(displayItem), linkItemMaybe, itemGeometry, isListPageMainItem, isMoving);
  }

  const renderAsOutline = !renderChildrenAsFull;
  return arrangeItemNoChildren(store, parentPath, displayItem, linkItemMaybe, itemGeometry, isPopup, isListPageMainItem, isMoving, renderAsOutline);
}


const arrangePageWithChildren = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    isPagePopup: boolean,
    isRoot: boolean,
    isListPageMainItem: boolean,
    isMoving: boolean): VisualElementSignal => {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const parentIsPopup = isPagePopup;

  if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Grid) {

    pageWithChildrenVisualElementSpec = arrange_grid_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);

  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Justified) {

    pageWithChildrenVisualElementSpec = arrange_justified_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);

  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.Document) {

    pageWithChildrenVisualElementSpec = arrange_document_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);

  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {

    pageWithChildrenVisualElementSpec = arrange_spatial_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);


  // *** LIST VIEW ***
  } else if (displayItem_pageWithChildren.arrangeAlgorithm == ArrangeAlgorithm.List) {

    const isFull = outerBoundsPx.h == store.desktopMainAreaBoundsPx().h;
    const scale = isFull ? 1.0 : outerBoundsPx.w / store.desktopMainAreaBoundsPx().w;

    let resizeBoundsPx = {
      x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX - RESIZE_BOX_SIZE_PX,
      y: 0,
      w: RESIZE_BOX_SIZE_PX,
      h: store.desktopMainAreaBoundsPx().h
    }
    if (isFull) {
      hitboxes.push(HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx));
    }

    pageWithChildrenVisualElementSpec = {
      displayItem: displayItem_pageWithChildren,
      linkItemMaybe: linkItemMaybe_pageWithChildren,
      flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
             (isPagePopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
             (isPagePopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
             (isRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
             (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
             (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
      boundsPx: outerBoundsPx,
      childAreaBoundsPx: geometry.boundsPx,
      hitboxes,
      parentPath,
    };

    let selectedVeid = EMPTY_VEID;
    if (isPagePopup) {
      const poppedUp = store.history.currentPopupSpec()!;
      const poppedUpPath = poppedUp.vePath;
      const poppedUpVeid = VeFns.veidFromPath(poppedUpPath);
      selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(poppedUpVeid));
    } else {
      if (realParentVeid == null) {
        selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(store.history.currentPage()!));
      } else {
        selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(realParentVeid!));
      }
    }

    let listVeChildren: Array<VisualElementSignal> = [];
    for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
      const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

      const widthBl = LIST_PAGE_LIST_WIDTH_BL;
      const blockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

      const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, parentIsPopup);

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
        blockSizePx,
      };
      const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
      const listItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
      listVeChildren.push(listItemVisualElementSignal);
    }
    pageWithChildrenVisualElementSpec.childrenVes = listVeChildren;

    if (selectedVeid != EMPTY_VEID) {
      const boundsPx = {
        x: LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX * scale,
        y: 0,
        w: outerBoundsPx.w - (LIST_PAGE_LIST_WIDTH_BL * LINE_HEIGHT_PX) * scale,
        h: outerBoundsPx.h - LINE_HEIGHT_PX * scale
      };
      const selectedIsRoot = isRoot && isPage(itemState.get(selectedVeid.itemId)!);
      const isExpandable = selectedIsRoot;
      pageWithChildrenVisualElementSpec.selectedVes =
        arrangeSelectedListItem(store, selectedVeid, boundsPx, pageWithChildrenVePath, isExpandable, selectedIsRoot);
    }

    if (isRoot && !isPagePopup) {
      const currentPopupSpec = store.history.currentPopupSpec();
      if (currentPopupSpec != null) {
        pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
      }
    }


  } else {

    panic(`arrangePageWithChildren: unknown arrangeAlgorithm: ${displayItem_pageWithChildren.arrangeAlgorithm}.`);
  }

  const attachments = arrangeItemAttachments(store, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, outerBoundsPx, pageWithChildrenVePath);
  pageWithChildrenVisualElementSpec.attachmentsVes = attachments;

  const pageWithChildrenVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  return pageWithChildrenVisualElementSignal;
}


const arrangeComposite = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Composite: CompositeItem,
    linkItemMaybe_Composite: LinkItem | null,
    compositeGeometry: ItemGeometry,
    isListPageMainItem: boolean,
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
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
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

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    if (isTable(displayItem_childItem)) { continue; }

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      compositeSizeBl.w,
      topPx);

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;

    const compositeChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.InsideCompositeOrDoc | VisualElementFlags.Detailed,
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
      blockSizePx,
    };

    const attachments = arrangeItemAttachments(store, displayItem_childItem, linkItemMaybe_childItem, geometry.boundsPx, compositeVePath);
    compositeChildVeSpec.attachmentsVes = attachments;

    const compositeChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), compositeVePath);
    const compositeChildVeSignal = VesCache.createOrRecycleVisualElementSignal(compositeChildVeSpec, compositeChildVePath);
    compositeVeChildren.push(compositeChildVeSignal);
  }
  compositeVisualElementSpec.childrenVes = compositeVeChildren;

  const compositeVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(compositeVisualElementSpec, compositeVePath);

  return compositeVisualElementSignal;
}


const arrangeTable = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Table: TableItem,
    linkItemMaybe_Table: LinkItem | null,
    tableGeometry: ItemGeometry,
    isListPageMainItem: boolean,
    parentIsPopup: boolean,
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
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: tableGeometry.boundsPx,
    childAreaBoundsPx,
    hitboxes: tableGeometry.hitboxes,
    blockSizePx,
    parentPath,
  };
  const tableVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Table, linkItemMaybe_Table), parentPath);

  let tableVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_Table.computed_children.length; ++idx) {
    const childId = displayItem_Table.computed_children[idx];
    const childItem = itemState.get(childId)!;
    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);
    const childVeid = VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem);

    if (isComposite(displayItem_childItem)) {
      initiateLoadChildItemsMaybe(store, childVeid);
    }

    let widthBl = displayItem_Table.tableColumns.length == 1
      ? sizeBl.w
      : Math.min(displayItem_Table.tableColumns[0].widthGr / GRID_SIZE, sizeBl.w);

    const geometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, parentIsPopup);

    const tableChildVeSpec: VisualElementSpec = {
      displayItem: displayItem_childItem,
      linkItemMaybe: linkItemMaybe_childItem,
      flags: VisualElementFlags.LineItem | VisualElementFlags.InsideTable,
      boundsPx: geometry.boundsPx,
      hitboxes: geometry.hitboxes,
      parentPath: tableVePath,
      col: 0,
      row: idx,
      blockSizePx,
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
        const { displayItem: displayItem_attachment, linkItemMaybe: linkItemMaybe_attachment } = getVePropertiesForItem(store, attachmentItem);
        const attachment_veid = VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment);

        if (isComposite(displayItem_attachment)) {
          initiateLoadChildItemsMaybe(store, attachment_veid);
        }

        const geometry = ItemFns.calcGeometry_ListItem(attachmentItem, blockSizePx, idx, leftBl, widthBl, parentIsPopup);

        const tableChildAttachmentVeSpec: VisualElementSpec = {
          displayItem: displayItem_attachment,
          linkItemMaybe: linkItemMaybe_attachment,
          flags: VisualElementFlags.InsideTable | VisualElementFlags.Attachment,
          boundsPx: geometry.boundsPx,
          hitboxes: geometry.hitboxes,
          col: i + 1,
          row: idx,
          parentPath: tableChildVePath,
          blockSizePx
        };
        const tableChildAttachmentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_attachment, linkItemMaybe_attachment), tableChildVePath);
        const tableChildAttachmentVeSignal = VesCache.createOrRecycleVisualElementSignal(tableChildAttachmentVeSpec, tableChildAttachmentVePath);

        if (isNote(tableChildAttachmentVeSpec.displayItem)) {
          const noteItem = asNoteItem(tableChildAttachmentVeSpec.displayItem);
          if (NoteFns.isExpression(noteItem)) {
            VesCache.markEvaluationRequired(VeFns.veToPath(tableChildAttachmentVeSignal.get()));
          }
        }

        tableItemVeAttachments.push(tableChildAttachmentVeSignal);
        leftBl += displayItem_Table.tableColumns[i+1].widthGr / GRID_SIZE;
      }

      tableChildVeSpec.attachmentsVes = tableItemVeAttachments;
    }
    const tableItemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableChildVeSpec, tableChildVePath);

    if (isNote(tableChildVeSpec.displayItem)) {
      const noteItem = asNoteItem(tableChildVeSpec.displayItem);
      if (NoteFns.isExpression(noteItem)) {
        VesCache.markEvaluationRequired(VeFns.veToPath(tableItemVisualElementSignal.get()));
      }
    }

    tableVeChildren.push(tableItemVisualElementSignal);
  };

  tableVisualElementSpec.childrenVes = tableVeChildren;

  const attachments = arrangeItemAttachments(store, displayItem_Table, linkItemMaybe_Table, tableGeometry.boundsPx, tableVePath);
  tableVisualElementSpec.attachmentsVes = attachments;

  const tableVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(tableVisualElementSpec, tableVePath);

  return tableVisualElementSignal;
}


export const arrangeItemNoChildren = (
    store: StoreContextModel,
    parentVePath: VisualElementPath,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    itemGeometry: ItemGeometry,
    isPopup: boolean,
    isListPageMainItem: boolean,
    isMoving: boolean,
    renderAsOutline: boolean): VisualElementSignal => {
  const currentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), parentVePath);

  const item = displayItem != null ? displayItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (renderAsOutline ? VisualElementFlags.None : VisualElementFlags.Detailed) |
           (isPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (isMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (isListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: itemGeometry.boundsPx,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  itemVisualElement.attachmentsVes = arrangeItemAttachments(store, displayItem, linkItemMaybe, itemGeometry.boundsPx, currentVePath);

  const itemVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(itemVisualElement, currentVePath);

  if (isNote(item)) {
    const noteItem = asNoteItem(item);
    if (NoteFns.isExpression(noteItem)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(itemVisualElementSignal.get()));
    }
  }

  return itemVisualElementSignal;
}


export const LIST_PAGE_MAIN_ITEM_LINK_ITEM = newUid();

export function arrangeSelectedListItem(store: StoreContextModel, veid: Veid, boundsPx: BoundingBox, currentPath: VisualElementPath, isExpandable: boolean, isRoot: boolean): VisualElementSignal {
  const item = itemState.get(veid.itemId)!;
  const canonicalItem = VeFns.canonicalItemFromVeid(veid)!;

  const paddedBoundsPx = {
    x: boundsPx.x + LINE_HEIGHT_PX,
    y: boundsPx.y + LINE_HEIGHT_PX,
    w: boundsPx.w - 2 * LINE_HEIGHT_PX,
    h: boundsPx.h - 2 * LINE_HEIGHT_PX,
  };

  let li = LinkFns.create(item.ownerId, canonicalItem.parentId, RelationshipToParent.Child, newOrdering(), veid.itemId);
  li.id = LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  if (isXSizableItem(item)) { li.spatialWidthGr = asXSizableItem(item).spatialWidthGr; }
  if (isYSizableItem(item)) { li.spatialHeightGr = asYSizableItem(item).spatialHeightGr; }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  const geometry = ItemFns.calcGeometry_InCell(li, paddedBoundsPx, isExpandable, false, false, false, false);
  if (isPage(item)) {
    geometry.boundsPx = boundsPx;
    geometry.hitboxes = [];
    if (isExpandable) {
      geometry.hitboxes = [
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: boundsPx.h, w: RESIZE_BOX_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX, w: boundsPx.w }),
        HitboxFns.create(HitboxFlags.Expand, { x: 0, y: boundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: boundsPx.w }),
        HitboxFns.create(HitboxFlags.Expand, { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: boundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      ];
    }
  }

  const result = arrangeItem(store, currentPath, veid, ArrangeAlgorithm.List, li, geometry, true, false, isRoot, true, false);
  return result;
}
