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

import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, LINE_HEIGHT_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { StoreContextModel } from "../../store/StoreProvider";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PageItem, asPageItem, isPage, ArrangeAlgorithm } from "../../items/page-item";
import { asTableItem, isTable } from "../../items/table-item";
import { VisualElementFlags, VisualElementSpec, VisualElementPath, VeFns, Veid } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { BoundingBox } from "../../util/geometry";
import { LinkFns, LinkItem, isLink } from "../../items/link-item";
import { panic } from "../../util/lang";
import { initiateLoadChildItemsMaybe } from "../load";
import { itemState } from "../../store/ItemState";
import { VesCache } from "../ves-cache";
import { ItemGeometry } from "../item-geometry";
import { asCompositeItem, isComposite } from "../../items/composite-item";
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
import { arrange_grid_page } from "./page_grid";
import { arrange_spatial_page } from "./page_spatial";
import { arrange_justified_page } from "./page_justified";
import { arrange_document_page } from "./page_document";
import { arrange_list_page } from "./page_list";
import { arrangeTable } from "./table";
import { arrangeComposite } from "./composite";


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

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  switch (displayItem_pageWithChildren.arrangeAlgorithm) {
    case ArrangeAlgorithm.Grid:
      pageWithChildrenVisualElementSpec = arrange_grid_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);
      break;
    case ArrangeAlgorithm.Justified:
      pageWithChildrenVisualElementSpec = arrange_justified_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);
      break;
    case ArrangeAlgorithm.Document:
      pageWithChildrenVisualElementSpec = arrange_document_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);
      break;
    case ArrangeAlgorithm.SpatialStretch:
      pageWithChildrenVisualElementSpec = arrange_spatial_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);
      break;
    case ArrangeAlgorithm.List:
      pageWithChildrenVisualElementSpec = arrange_list_page(store, parentPath, realParentVeid, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, geometry, isPagePopup, isRoot, isListPageMainItem, isMoving);
      break;
    default:
      panic(`arrangePageWithChildren: unknown arrangeAlgorithm: ${displayItem_pageWithChildren.arrangeAlgorithm}.`);
  }

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;

  if (!isRoot) {
    const attachments = arrangeItemAttachments(store, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, outerBoundsPx, pageWithChildrenVePath);
    pageWithChildrenVisualElementSpec.attachmentsVes = attachments;
  }

  const pageWithChildrenVisualElementSignal = VesCache.createOrRecycleVisualElementSignal(pageWithChildrenVisualElementSpec, pageWithChildrenVePath);
  return pageWithChildrenVisualElementSignal;
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
