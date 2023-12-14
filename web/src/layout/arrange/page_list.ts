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

import { LINE_HEIGHT_PX, LIST_PAGE_LIST_WIDTH_BL, RESIZE_BOX_SIZE_PX } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { LinkFns, LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { newUid } from "../../util/uid";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { RelationshipToParent } from "../relationship-to-parent";
import { VesCache } from "../ves-cache";
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem } from "./item";
import { arrangeCellPopup } from "./popup";
import { getVePropertiesForItem } from "./util";


export function arrange_list_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopupRoot);

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

  const isEmbeddedInteractive = (displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) && VeFns.pathDepth(parentPath) == 2;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
           (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractiveRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopupRoot && store.getToolbarFocus()!.itemId == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None),
    boundsPx: outerBoundsPx,
    childAreaBoundsPx: geometry.boundsPx,
    hitboxes,
    parentPath,
  };

  let selectedVeid = EMPTY_VEID;
  if (flags & ArrangeItemFlags.IsPopupRoot) {
    const poppedUp = store.history.currentPopupSpec()!;
    const poppedUpPath = poppedUp.vePath;
    const poppedUpVeid = VeFns.veidFromPath(poppedUpPath);
    selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(poppedUpVeid));
  } else if (flags & ArrangeItemFlags.IsTopRoot) {
    selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(store.history.currentPage()!));
  } else if (flags & ArrangeItemFlags.IsListPageMainRoot) {
    selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(realParentVeid!));
  } else if (flags & ArrangeItemFlags.IsEmbeddedInteractiveRoot || ArrangeItemFlags.RenderChildrenAsFull) {
    const veid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
    selectedVeid = VeFns.veidFromPath(store.perItem.getSelectedListPageItem(veid));
  } else {
    console.log(flags);
    panic("unexpected list page scenario.");
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
    const selectedIsRoot = arrangeFlagIsRoot(flags) && isPage(itemState.get(selectedVeid.itemId)!);
    const isExpandable = selectedIsRoot;
    pageWithChildrenVisualElementSpec.selectedVes =
      arrangeSelectedListItem(store, selectedVeid, boundsPx, pageWithChildrenVePath, isExpandable, selectedIsRoot);
  }

  if (arrangeFlagIsRoot(flags) && !(flags & ArrangeItemFlags.IsPopupRoot)) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
    }
  }

  return pageWithChildrenVisualElementSpec;
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

  const result = arrangeItem(
    store, currentPath, veid, ArrangeAlgorithm.List, li, geometry,
    ArrangeItemFlags.RenderChildrenAsFull | (isRoot ? ArrangeItemFlags.IsListPageMainRoot : ArrangeItemFlags.None));
  return result;
}
