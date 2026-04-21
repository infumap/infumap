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

import { CHILD_ITEMS_VISIBLE_WIDTH_BL, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { StoreContextModel } from "../../store/StoreProvider";
import { Item } from "../../items/base/item";
import { asPageItem, isPage, ArrangeAlgorithm } from "../../items/page-item";
import { asTableItem, isTable } from "../../items/table-item";
import { asSearchItem, isSearch } from "../../items/search-item";
import { VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec, VeFns } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { LinkItem, isLink } from "../../items/link-item";
import { panic } from "../../util/lang";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { ItemGeometry } from "../item-geometry";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { arrangeItemAttachments } from "./attachments";
import { getVePropertiesForItem } from "./util";
import { MouseAction, MouseActionState } from "../../input/state";
import { arrangeTable } from "./table";
import { arrangeComposite } from "./composite";
import { arrangePageWithChildren } from "./page";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { arrangeSearchResultsPathMaybe } from "./search";


export enum ArrangeItemFlags {
  None = 0x000,
  IsTopRoot = 0x001,
  IsPopupRoot = 0x002,
  IsListPageMainRoot = 0x008,
  IsEmbeddedInteractiveRoot = 0x010,
  IsDockRoot = 0x020,
  ParentIsPopup = 0x040,
  IsMoving = 0x080,
  RenderChildrenAsFull = 0x100,
  RenderAsOutline = 0x200,
  InsideCompositeOrDoc = 0x400,
  IsFixed = 0x800,
}

export function arrangeFlagIsRoot(flags: ArrangeItemFlags): boolean {
  return !!(flags & ArrangeItemFlags.IsTopRoot |
    flags & ArrangeItemFlags.IsPopupRoot |
    flags & ArrangeItemFlags.IsListPageMainRoot |
    flags & ArrangeItemFlags.IsEmbeddedInteractiveRoot |
    flags & ArrangeItemFlags.IsDockRoot);
}

export function getCommonVisualElementFlags(flags: ArrangeItemFlags): VisualElementFlags {
  return (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None) |
    (flags & ArrangeItemFlags.IsFixed ? VisualElementFlags.Fixed : VisualElementFlags.None);
}


export const arrangeItem = (
  store: StoreContextModel,
  parentPath: VisualElementPath,
  parentArrangeAlgorithm: string,
  itemWhichMightBeLink: Item,
  actualLinkItemMaybe: LinkItem | null,
  itemGeometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementSignal => {

  if (flags & ArrangeItemFlags.IsPopupRoot && !isLink(itemWhichMightBeLink)) { panic("arrangeItem: popup isn't a link."); }

  const { displayItem, linkItemMaybe, spatialWidthGr } = getVePropertiesForItem(store, itemWhichMightBeLink);
  const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);

  let isMoving = false;
  if (!MouseActionState.empty() && MouseActionState.isAction(MouseAction.Moving)) {
    const activeElementPath = MouseActionState.getActiveElementPath()!;
    if (activeElementPath == VeFns.addVeidToPath(itemVeid, parentPath)) {
      isMoving = true;
    } else {
      const activeParentPath = VeFns.parentPath(activeElementPath);
      const group = MouseActionState.getGroupMoveItems();
      if (group && activeParentPath == parentPath) {
        isMoving = group.some(g => g.veid.itemId == itemVeid.itemId && g.veid.linkIdMaybe == itemVeid.linkIdMaybe);
      }
    }
  }

  flags |= (isMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None);

  const renderPageWithChildren = (() => {
    if (!isPage(displayItem)) { return false; }
    if (arrangeFlagIsRoot(flags)) { return true; }
    if (flags & ArrangeItemFlags.IsPopupRoot) { return true; }
    if (flags & ArrangeItemFlags.IsTopRoot) { return true; }
    if (parentArrangeAlgorithm == ArrangeAlgorithm.List) { return true; }
    if (!(flags & ArrangeItemFlags.RenderChildrenAsFull)) { return false; }
    if (parentArrangeAlgorithm == ArrangeAlgorithm.Dock) { return true; }
    if (parentArrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      // This test does not depend on pixel size, so is invariant over display devices.
      return (spatialWidthGr / GRID_SIZE >= CHILD_ITEMS_VISIBLE_WIDTH_BL);
    }
    // However, this test does.
    return itemGeometry.boundsPx.w / LINE_HEIGHT_PX >= CHILD_ITEMS_VISIBLE_WIDTH_BL;
  })();

  if (renderPageWithChildren) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangePageWithChildren(
      store, parentPath, asPageItem(displayItem), linkItemMaybe, actualLinkItemMaybe, itemGeometry, flags);
  }

  if (isTable(displayItem) && (itemWhichMightBeLink.parentId == store.history.currentPageVeid()!.itemId || flags & ArrangeItemFlags.RenderChildrenAsFull)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeTable(
      store, parentPath, asTableItem(displayItem), linkItemMaybe, actualLinkItemMaybe, itemGeometry, flags);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeComposite(
      store, parentPath, asCompositeItem(displayItem), linkItemMaybe, actualLinkItemMaybe, itemGeometry, flags);
  }

  const renderAsOutline = !(flags & ArrangeItemFlags.RenderChildrenAsFull);
  flags |= (renderAsOutline ? ArrangeItemFlags.RenderAsOutline : ArrangeItemFlags.None);
  return arrangeItemNoChildren(store, parentPath, displayItem, linkItemMaybe, actualLinkItemMaybe, itemGeometry, flags);
}

export const arrangeItemPath = (
  store: StoreContextModel,
  parentPath: VisualElementPath,
  parentArrangeAlgorithm: string,
  itemWhichMightBeLink: Item,
  actualLinkItemMaybe: LinkItem | null,
  itemGeometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementPath => {

  return VeFns.veToPath(arrangeItem(
    store,
    parentPath,
    parentArrangeAlgorithm,
    itemWhichMightBeLink,
    actualLinkItemMaybe,
    itemGeometry,
    flags,
  ).get());
}

export const arrangeItemNoChildren = (
  store: StoreContextModel,
  parentVePath: VisualElementPath,
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  actualLinkItemMaybe: LinkItem | null,
  itemGeometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementSignal => {
  const currentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), parentVePath);

  if (displayItem == null) { panic("displayItem == null is unexpected"); }

  const highlightedPath = store.find.highlightedPath.get();
  const isHighlighted = highlightedPath !== null && highlightedPath === currentVePath;

  const itemVisualElementSpec: VisualElementSpec = {
    displayItem,
    linkItemMaybe,
    actualLinkItemMaybe,
    flags: (flags & ArrangeItemFlags.RenderAsOutline ? VisualElementFlags.None : VisualElementFlags.Detailed) |
      getCommonVisualElementFlags(flags) |
      (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: itemGeometry.boundsPx,
    blockSizePx: itemGeometry.blockSizePx,
    row: itemGeometry.row,
    col: itemGeometry.col,
    hitboxes: itemGeometry.hitboxes,
    parentPath: parentVePath,
  };

  const isInOverlaySelection = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem, actualLinkItemMaybe);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();
  if (isInOverlaySelection) {
    itemVisualElementSpec.flags = (itemVisualElementSpec.flags || VisualElementFlags.None) | VisualElementFlags.SelectionHighlighted;
  }

  // TODO (MEDIUM): reconcile, don't override.
  // TODO (MEDIUM): perhaps attachments is a sub-signal.
  const itemRelationships: VisualElementRelationships = {};
  if (isAttachmentsItem(displayItem)) {
    const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe == null ? displayItem : linkItemMaybe);
    itemRelationships.attachmentsPaths = arrangeItemAttachments(store, asAttachmentsItem(displayItem).computed_attachments, parentItemSizeBl, itemGeometry.boundsPx, currentVePath);
  } else {
    itemRelationships.attachmentsPaths = [];
  }
  if (isSearch(displayItem) && (flags & ArrangeItemFlags.RenderChildrenAsFull)) {
    const searchResultsPath = arrangeSearchResultsPathMaybe(store, asSearchItem(displayItem), currentVePath, itemGeometry);
    itemRelationships.childrenPaths = searchResultsPath == null ? [] : [searchResultsPath];
  }

  const itemVisualElementSignal = VesCache.arrange.writeVisualElementSignal(itemVisualElementSpec, itemRelationships, currentVePath);
  return itemVisualElementSignal;
}

export const arrangeItemNoChildrenPath = (
  store: StoreContextModel,
  parentVePath: VisualElementPath,
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  actualLinkItemMaybe: LinkItem | null,
  itemGeometry: ItemGeometry,
  flags: ArrangeItemFlags): VisualElementPath => {

  return VeFns.veToPath(arrangeItemNoChildren(
    store,
    parentVePath,
    displayItem,
    linkItemMaybe,
    actualLinkItemMaybe,
    itemGeometry,
    flags,
  ).get());
}
