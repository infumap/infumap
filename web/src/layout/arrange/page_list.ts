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
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem } from "../../items/link-item";
import { PageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { VisualElementSignal } from "../../util/signals";
import { HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { arrangeSelectedListItem } from "./item";
import { arrangeCellPopup } from "./popup";
import { getVePropertiesForItem } from "./util";

export function arrange_list_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    isPagePopup: boolean,
    isRoot: boolean,
    isListPageMainItem: boolean,
    isMoving: boolean): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = isPagePopup;



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

  return pageWithChildrenVisualElementSpec;
}