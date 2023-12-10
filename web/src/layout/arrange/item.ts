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
import { VisualElementFlags, VisualElementSpec, VisualElementPath, VeFns, Veid } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { LinkItem, isLink } from "../../items/link-item";
import { panic } from "../../util/lang";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { ItemGeometry } from "../item-geometry";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { arrangeItemAttachments } from "./attachments";
import { getVePropertiesForItem } from "./util";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { MouseAction, MouseActionState } from "../../input/state";
import { arrangeTable } from "./table";
import { arrangeComposite } from "./composite";
import { arrangePageWithChildren } from "./page";


export enum ArrangeItemFlags {
  None                  = 0x000,
  RenderChildrenAsFull  = 0x001,
  IsPopup               = 0x002,
  IsRoot                = 0x004,
  IsListPageMainItem    = 0x008,
  ParentIsPopup         = 0x010,
  IsMoving              = 0x020,
  RenderAsOutline       = 0x040,
}

export const arrangeItem = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    parentArrangeAlgorithm: string,
    item: Item,
    itemGeometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSignal => {
  if (flags & ArrangeItemFlags.IsPopup && !isLink(item)) { panic("arrangeItem: popup isn't a link."); }

  const { displayItem, linkItemMaybe, spatialWidthGr } = getVePropertiesForItem(store, item);
  const itemVeid = VeFns.veidFromItems(displayItem, linkItemMaybe);

  let isMoving = false;
  if (!MouseActionState.empty() && MouseActionState.get().action == MouseAction.Moving) {
    const activeElementPath = MouseActionState.get().activeElement;
    if (activeElementPath == VeFns.addVeidToPath(itemVeid, parentPath)) {
      isMoving = true;
    }
  }

  flags |= (isMoving ? ArrangeItemFlags.IsMoving : ArrangeItemFlags.None);

  const renderWithChildren = (() => {
    if (flags & ArrangeItemFlags.IsRoot) { return true; }
    if (flags & ArrangeItemFlags.IsPopup) { return true; }
    if (!(flags & ArrangeItemFlags.RenderChildrenAsFull)) { return false; }
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
      store, parentPath, realParentVeid, asPageItem(displayItem), linkItemMaybe, itemGeometry, flags);
  }

  if (isTable(displayItem) && (item.parentId == store.history.currentPage()!.itemId || flags & ArrangeItemFlags.RenderChildrenAsFull)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeTable(
      store, parentPath, asTableItem(displayItem), linkItemMaybe, itemGeometry, flags);
  }

  if (isComposite(displayItem)) {
    initiateLoadChildItemsMaybe(store, itemVeid);
    return arrangeComposite(
      store, parentPath, asCompositeItem(displayItem), linkItemMaybe, itemGeometry, flags);
  }

  const renderAsOutline = !(flags & ArrangeItemFlags.RenderChildrenAsFull);
  flags |= (renderAsOutline ? ArrangeItemFlags.RenderAsOutline : ArrangeItemFlags.None);
  return arrangeItemNoChildren(store, parentPath, displayItem, linkItemMaybe, itemGeometry, flags);
}


export const arrangeItemNoChildren = (
    store: StoreContextModel,
    parentVePath: VisualElementPath,
    displayItem: Item,
    linkItemMaybe: LinkItem | null,
    itemGeometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSignal => {
  const currentVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), parentVePath);

  const item = displayItem != null ? displayItem : linkItemMaybe!;
  const itemVisualElement: VisualElementSpec = {
    displayItem: item,
    linkItemMaybe,
    flags: (flags & ArrangeItemFlags.RenderAsOutline ? VisualElementFlags.None : VisualElementFlags.Detailed) |
           (flags & ArrangeItemFlags.IsPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
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
