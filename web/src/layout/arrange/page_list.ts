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

import { GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, NATURAL_BLOCK_SIZE_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { PageFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { isComposite } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
import { LinkFns, LinkItem, asLinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { newUid } from "../../util/uid";
import { Hitbox, HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { initiateLoadChildItemsMaybe } from "../load";
import { RelationshipToParent } from "../relationship-to-parent";
import { VesCache } from "../ves-cache";
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem } from "./item";
import { arrangeCellPopup } from "./popup";
import { getVePropertiesForItem } from "./util";


export function arrange_list_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  if (flags & ArrangeItemFlags.IsDockRoot) {
    return arrange_dock_list_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags);
  }


  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const focusVeid = VeFns.veidFromPath(store.history.getFocusPath());
  const pages = store.topTitledPages.get();
  let isFocusPage = false;
  let pageIdx = -1;
  for (let i=0; i<pages.length; ++i) {
    const veid = VeFns.veidFromPath(pages[i]);
    if (veid.itemId == pageWithChildrenVeid.itemId && veid.linkIdMaybe == pageWithChildrenVeid.linkIdMaybe) {
      pageIdx = i;
      if (veid.itemId == focusVeid.itemId && veid.linkIdMaybe == focusVeid.linkIdMaybe) {
        isFocusPage = true;
      }
    }
  }

  let focusedChildItemMaybe = null;
  if (pageIdx >= 0) {
    for (let i=0; i<pages.length; ++i) {
      const veid = VeFns.veidFromPath(pages[i]);
      if (veid.itemId == focusVeid.itemId && veid.linkIdMaybe == focusVeid.linkIdMaybe) {
        if (i == pageIdx + 1) {
          focusedChildItemMaybe = itemState.get(focusVeid.itemId);
        }
      }
    }
  }

  const hitboxes = geometry.hitboxes;

  const parentIsPopup = !!(flags & ArrangeItemFlags.IsPopupRoot);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  const scale = isFull ? 1.0 : geometry.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;

  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  const listWidthBl = displayItem_pageWithChildren.tableColumns[0].widthGr / GRID_SIZE;

  let resizeBoundsPx = {
    x: listWidthBl * LINE_HEIGHT_PX - RESIZE_BOX_SIZE_PX,
    y: 0,
    w: RESIZE_BOX_SIZE_PX,
    h: store.desktopMainAreaBoundsPx().h
  }
  if (isFull) {
    hitboxes.push(HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx));
  }

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  const listWidthPx = LINE_HEIGHT_PX * listWidthBl * scale;
  const listChildAreaHeightPx1 = (displayItem_pageWithChildren.computed_children.length * LINE_HEIGHT_PX + LIST_PAGE_TOP_PADDING_PX) * scale;
  const listChildAreaHeightPx2 = geometry.viewportBoundsPx!.h;
  const listChildAreaHeightPx = Math.max(listChildAreaHeightPx1, listChildAreaHeightPx2);
  const listViewportBoundsPx = cloneBoundingBox(geometry.viewportBoundsPx!)!;
  listViewportBoundsPx.w = listWidthPx;
  const listChildAreaBoundsPx = cloneBoundingBox(listViewportBoundsPx)!;
  listChildAreaBoundsPx.h = listChildAreaHeightPx;
  const blockSizePx = {
    w: listViewportBoundsPx.w / (displayItem_pageWithChildren.tableColumns[0].widthGr / GRID_SIZE),
    h: 0  // TODO (LOW): better to calculate this, but it's not needed for anything.
  };

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    focusedChildItemMaybe,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
           (isEmbeddedInteractive ? VisualElementFlags.EmbededInteractiveRoot : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    childAreaBoundsPx: zeroBoundingBoxTopLeft(geometry.viewportBoundsPx!),
    listViewportBoundsPx,
    listChildAreaBoundsPx,
    blockSizePx,
    hitboxes,
    parentPath,
  };

  const selectedVeid = store.perItem.getSelectedListPageItem(
    VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren)
  );

  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    if (isComposite(displayItem)) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    }

    const blockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, listWidthBl, parentIsPopup, true, false);

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.LineItem |
             (VeFns.compareVeids(selectedVeid, VeFns.veidFromItems(displayItem, linkItemMaybe)) == 0
                ? (isFocusPage ? VisualElementFlags.FocusPageSelected | VisualElementFlags.Selected : VisualElementFlags.Selected)
                : VisualElementFlags.None),
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      boundsPx: listItemGeometry.boundsPx,
      hitboxes: listItemGeometry.hitboxes,
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: idx,
      blockSizePx,
    };
    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
    const listItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
    listVeChildren.push(listItemVisualElementSignal);

    if (isExpression(childItem)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(listItemVisualElementSignal.get()));
    }
  }
  pageWithChildrenVisualElementSpec.childrenVes = listVeChildren;

  if (selectedVeid != EMPTY_VEID) {
    const boundsPx = {
      x: listWidthBl * LINE_HEIGHT_PX * scale,
      y: 0,
      w: geometry.viewportBoundsPx!.w - (listWidthBl * LINE_HEIGHT_PX) * scale,
      h: geometry.viewportBoundsPx!.h
    };
    const selectedIsRoot = arrangeFlagIsRoot(flags) && isPage(itemState.get(selectedVeid.itemId)!);
    const canShiftLeft = selectedIsRoot;
    pageWithChildrenVisualElementSpec.selectedVes =
      arrangeSelectedListItem(store, selectedVeid, boundsPx, pageWithChildrenVePath, canShiftLeft, selectedIsRoot);
  }

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store);
    }
  }

  return pageWithChildrenVisualElementSpec;
}


export const LIST_PAGE_MAIN_ITEM_LINK_ITEM = newUid();

export function arrangeSelectedListItem(
    store: StoreContextModel,
    veid: Veid,
    boundsPx: BoundingBox,
    currentPath: VisualElementPath,
    canShiftLeft: boolean,
    isRoot: boolean): VisualElementSignal | null {

  const item = itemState.get(veid.itemId)!;
  const actualLinkItemMaybe = veid.linkIdMaybe == null ? null : asLinkItem(itemState.get(veid.linkIdMaybe)!);
  const canonicalItem = VeFns.canonicalItemFromVeid(veid)!;

  const paddedBoundsPx = {
    x: boundsPx.x + LINE_HEIGHT_PX,
    y: boundsPx.y + LINE_HEIGHT_PX,
    w: boundsPx.w - 2 * LINE_HEIGHT_PX,
    h: boundsPx.h - 2 * LINE_HEIGHT_PX,
  };

  if (paddedBoundsPx.w < LINE_HEIGHT_PX / 2 || paddedBoundsPx.h < LINE_HEIGHT_PX / 2) {
    return null;
  }

  let li = LinkFns.create(item.ownerId, canonicalItem.parentId, RelationshipToParent.Child, veid.itemId, newOrdering());
  li.id = LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  if (isXSizableItem(item)) { li.spatialWidthGr = asXSizableItem(item).spatialWidthGr; }
  if (isYSizableItem(item)) { li.spatialHeightGr = asYSizableItem(item).spatialHeightGr; }
  li.spatialPositionGr = { x: 0.0, y: 0.0 };

  let cellGeometry: ItemGeometry;

  if (isPage(item)) {
    let hitboxes: Array<Hitbox> = [];
    if (canShiftLeft) {
      hitboxes = [
        HitboxFns.create(HitboxFlags.ShiftLeft, { x: 0, y: 0, h: boundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      ];
    }
    cellGeometry = {
      boundsPx: boundsPx,
      hitboxes,
      viewportBoundsPx: boundsPx,
      blockSizePx: NATURAL_BLOCK_SIZE_PX,
    };
  } else {
    cellGeometry = ItemFns.calcGeometry_InCell(li, paddedBoundsPx, canShiftLeft, false, false, false, false, false, false);
  }

  const result = arrangeItem(
    store, currentPath, ArrangeAlgorithm.List, li, actualLinkItemMaybe, cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull | (isRoot ? ArrangeItemFlags.IsListPageMainRoot : ArrangeItemFlags.None));
  return result;
}


export function arrange_dock_list_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    actualLinkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const hitboxes = geometry.hitboxes;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
            (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
            VisualElementFlags.EmbededInteractiveRoot |
            (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
            (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: flags,
    boundsPx: geometry.boundsPx,
    viewportBoundsPx: geometry.viewportBoundsPx!,
    childAreaBoundsPx: zeroBoundingBoxTopLeft(geometry.viewportBoundsPx!),
    listViewportBoundsPx: geometry.viewportBoundsPx!,
    listChildAreaBoundsPx: zeroBoundingBoxTopLeft(geometry.viewportBoundsPx!),
    hitboxes,
    parentPath,
  };


  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx=0; idx<displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    if (isComposite(displayItem)) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    }

    const blockSizePx = NATURAL_BLOCK_SIZE_PX;
    const widthBl = geometry.boundsPx.w / blockSizePx.w;
    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, false, false, false);

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.LineItem,
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      boundsPx: listItemGeometry.boundsPx,
      hitboxes: listItemGeometry.hitboxes,
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: idx,
      blockSizePx,
    };
    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);
    const listItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(listItemVeSpec, childPath);
    listVeChildren.push(listItemVisualElementSignal);
  }
  pageWithChildrenVisualElementSpec.childrenVes = listVeChildren;

  return pageWithChildrenVisualElementSpec;
}