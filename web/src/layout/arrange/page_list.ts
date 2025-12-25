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
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { PageFlags } from "../../items/base/flags-item";
import { ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { isComposite } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { BoundingBox, cloneBoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { assert } from "../../util/lang";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { newUid } from "../../util/uid";
import { Hitbox, HitboxFlags, HitboxFns } from "../hitbox";
import { ItemGeometry } from "../item-geometry";
import { initiateLoadChildItemsMaybe } from "../load";
import { RelationshipToParent } from "../relationship-to-parent";
import { VesCache } from "../ves-cache";
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
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
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  if (flags & ArrangeItemFlags.IsDockRoot) {
    return arrange_dock_list_page(store, parentPath, displayItem_pageWithChildren, linkItemMaybe_pageWithChildren, actualLinkItemMaybe_pageWithChildren, geometry, flags);
  }

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren ? linkItemMaybe_pageWithChildren : actualLinkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const focusVeid = VeFns.veidFromPath(store.history.getFocusPath());
  const pages = store.topTitledPages.get();
  let isFocusPage = false;
  let pageIdx = -1;
  for (let i = 0; i < pages.length; ++i) {
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
    for (let i = 0; i < pages.length; ++i) {
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
  const isNestedListPage = !!(flags & ArrangeItemFlags.IsListPageMainRoot);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  const scale = isFull ? 1.0 : geometry.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;

  if (isFull) {
    VesCache.pushTopTitledPage(pageWithChildrenVePath);
  }

  const listWidthBl = displayItem_pageWithChildren.tableColumns[0].widthGr / GRID_SIZE;

  // Mark page as selection-highlighted when included in overlay selection
  const isSelectionHighlighted = (() => {
    const sel = store.overlay.selectedVeids.get();
    if (!sel || sel.length === 0) { return false; }
    const veid = VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren);
    for (let i = 0; i < sel.length; ++i) {
      if (sel[i].itemId === veid.itemId && sel[i].linkIdMaybe === veid.linkIdMaybe) { return true; }
    }
    return false;
  })();

  let resizeBoundsPx = {
    x: listWidthBl * LINE_HEIGHT_PX * scale - RESIZE_BOX_SIZE_PX,
    y: 0,
    w: RESIZE_BOX_SIZE_PX,
    h: geometry.viewportBoundsPx!.h
  }
  // Add horizontal resize for root pages, popup pages, and nested list pages
  if (isFull || parentIsPopup || isNestedListPage) {
    hitboxes.push(HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx));
  }

  let movingItem = null;
  let movingItemInThisPage = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItemInThisPage = VeFns.treeItemFromPath(MouseActionState.get().activeElementPath);
    movingItem = movingItemInThisPage;
    if (movingItemInThisPage!.parentId != displayItem_pageWithChildren.id) {
      movingItemInThisPage = null;
    }
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

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
      (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsDockRoot ? VisualElementFlags.DockItem : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.InsideCompositeOrDoc ? VisualElementFlags.InsideCompositeOrDoc : VisualElementFlags.None) |
      (isSelectionHighlighted ? VisualElementFlags.SelectionHighlighted : VisualElementFlags.None),
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

  const pageRelationships: VisualElementRelationships = {
    focusedChildItemMaybe,
  };

  const selectedVeid = store.perItem.getSelectedListPageItem(
    VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren)
  );

  let skippedCount = 0;
  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    if (movingItemInThisPage && childItem.id == movingItemInThisPage!.id) {
      skippedCount += 1;
      continue;
    }

    if (isComposite(displayItem)) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    }

    // Optional date filter via link override (client-only)
    if (linkItemMaybe_pageWithChildren?.filterDate) {
      const d = new Date(childItem.dateTime * 1000);
      const f = linkItemMaybe_pageWithChildren.filterDate;
      if (d.getFullYear() !== f.year || (d.getMonth() + 1) !== f.month || d.getDate() !== f.day) {
        skippedCount += 1;
        continue;
      }
    }

    const blockSizePx = { w: LINE_HEIGHT_PX * scale, h: LINE_HEIGHT_PX * scale };

    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx - skippedCount, 0, listWidthBl, parentIsPopup, true, false, false);

    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);

    const highlightedPath = store.find.highlightedPath.get();
    const isHighlighted = highlightedPath !== null && highlightedPath === childPath;

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.LineItem |
        (VeFns.compareVeids(selectedVeid, VeFns.veidFromItems(displayItem, linkItemMaybe)) == 0
          ? (isFocusPage ? VisualElementFlags.FocusPageSelected | VisualElementFlags.Selected : VisualElementFlags.Selected)
          : VisualElementFlags.None) |
        (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      boundsPx: listItemGeometry.boundsPx,
      hitboxes: listItemGeometry.hitboxes,
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: idx - skippedCount,
      blockSizePx,
    };
    const listItemRelationships: VisualElementRelationships = {};
    const listItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(listItemVeSpec, listItemRelationships, childPath);
    listVeChildren.push(listItemVisualElementSignal);

    if (isExpression(childItem)) {
      VesCache.markEvaluationRequired(VeFns.veToPath(listItemVisualElementSignal.get()));
    }
  }

  if (movingItemInThisPage) {
    const actualMovingItemLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;

    let scrollPropY;
    let scrollPropX;
    if (flags & ArrangeItemFlags.IsPopupRoot) {
      const popupSpec = store.history.currentPopupSpec();
      assert(itemState.get(popupSpec!.actualVeid.itemId)!.itemType == ItemType.Page, "popup spec does not have type page.");
      scrollPropY = store.perItem.getPageScrollYProp(popupSpec!.actualVeid);
      scrollPropX = store.perItem.getPageScrollXProp(popupSpec!.actualVeid);
    } else {
      scrollPropY = store.perItem.getPageScrollYProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
      scrollPropX = store.perItem.getPageScrollXProp(VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren));
    }

    const umbrellaVisualElement = store.umbrellaVisualElement.get();
    const umbrellaBoundsPx = umbrellaVisualElement.childAreaBoundsPx!;
    const desktopSizePx = store.desktopBoundsPx();
    const pageYScrollProp = store.perItem.getPageScrollYProp(store.history.currentPageVeid()!);
    const pageYScrollPx = pageYScrollProp * (umbrellaBoundsPx.h - desktopSizePx.h);

    const yOffsetPx = scrollPropY * (listChildAreaBoundsPx.h - geometry.boundsPx.h);
    const xOffsetPx = scrollPropX * (listChildAreaBoundsPx.w - geometry.boundsPx.w);
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
    // TODO (MEDIUM): adjX is a hack, the calculations should be such that an adjustment here is not necessary.
    const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
    const cellBoundsPx = {
      x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + xOffsetPx,
      y: mouseDesktopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + yOffsetPx + pageYScrollPx,
      w: dimensionsBl.w * LINE_HEIGHT_PX * scale,
      h: dimensionsBl.h * LINE_HEIGHT_PX * scale,
    };

    cellBoundsPx.x -= MouseActionState.get().clickOffsetProp!.x * cellBoundsPx.w;
    cellBoundsPx.y -= MouseActionState.get().clickOffsetProp!.y * cellBoundsPx.h;
    const cellGeometry = ItemFns.calcGeometry_InCell(movingItemInThisPage, cellBoundsPx, false, !!(flags & ArrangeItemFlags.ParentIsPopup), false, false, false, false, false, false, store.smallScreenMode());
    const ves = arrangeItem(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItemInThisPage, actualMovingItemLinkItemMaybe, cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull | (parentIsPopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
    listVeChildren.push(ves);
  }

  pageRelationships.childrenVes = listVeChildren;

  if (selectedVeid != EMPTY_VEID) {
    const boundsPx = {
      x: listWidthBl * LINE_HEIGHT_PX * scale,
      y: 0,
      w: geometry.viewportBoundsPx!.w - (listWidthBl * LINE_HEIGHT_PX) * scale,
      h: geometry.viewportBoundsPx!.h
    };
    const selectedIsRoot = arrangeFlagIsRoot(flags) && isPage(itemState.get(selectedVeid.itemId)!);
    const canShiftLeft = selectedIsRoot;
    pageRelationships.selectedVes =
      arrangeSelectedListItem(store, selectedVeid, boundsPx, pageWithChildrenVePath, canShiftLeft, selectedIsRoot);
  }

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupVes = arrangeCellPopup(store);
    }
  }

  return { spec: pageSpec, relationships: pageRelationships };
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
  const treeItem = VeFns.treeItemFromVeid(veid)!;

  const paddedBoundsPx = {
    x: boundsPx.x + LINE_HEIGHT_PX,
    y: boundsPx.y + LINE_HEIGHT_PX,
    w: boundsPx.w - 2 * LINE_HEIGHT_PX,
    h: boundsPx.h - 2 * LINE_HEIGHT_PX,
  };

  if (paddedBoundsPx.w < LINE_HEIGHT_PX / 2 || paddedBoundsPx.h < LINE_HEIGHT_PX / 2) {
    return null;
  }

  let li = LinkFns.create(item.ownerId, treeItem.parentId, RelationshipToParent.Child, veid.itemId, newOrdering());
  li.id = LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  li.creationDate = 0;
  li.lastModifiedDate = 0;
  li.dateTime = 0;
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
    cellGeometry = ItemFns.calcGeometry_InCell(li, paddedBoundsPx, canShiftLeft, false, false, false, false, false, false, false, store.smallScreenMode());
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
  flags: ArrangeItemFlags): { spec: VisualElementSpec, relationships: VisualElementRelationships } {

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const hitboxes = geometry.hitboxes;

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsTopRoot ? VisualElementFlags.TopLevelRoot : VisualElementFlags.None) |
      VisualElementFlags.EmbeddedInteractiveRoot |
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

  const pageRelationships: VisualElementRelationships = {};

  let listVeChildren: Array<VisualElementSignal> = [];
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childItem = itemState.get(displayItem_pageWithChildren.computed_children[idx])!;
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    if (isComposite(displayItem)) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    }

    const blockSizePx = NATURAL_BLOCK_SIZE_PX;
    const widthBl = geometry.boundsPx.w / blockSizePx.w;
    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx, 0, widthBl, false, false, false, false);

    const childPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), pageWithChildrenVePath);

    const highlightedPath = store.find.highlightedPath.get();
    const isHighlighted = highlightedPath !== null && highlightedPath === childPath;

    const listItemVeSpec: VisualElementSpec = {
      displayItem,
      linkItemMaybe,
      actualLinkItemMaybe: linkItemMaybe,
      flags: VisualElementFlags.LineItem |
        (isHighlighted ? VisualElementFlags.FindHighlighted : VisualElementFlags.None),
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
      boundsPx: listItemGeometry.boundsPx,
      hitboxes: listItemGeometry.hitboxes,
      parentPath: pageWithChildrenVePath,
      col: 0,
      row: idx,
      blockSizePx,
    };
    const listItemRelationships: VisualElementRelationships = {};
    const listItemVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(listItemVeSpec, listItemRelationships, childPath);
    listVeChildren.push(listItemVisualElementSignal);
  }
  pageRelationships.childrenVes = listVeChildren;

  return { spec: pageSpec, relationships: pageRelationships };
}