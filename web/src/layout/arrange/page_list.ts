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

import { GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, MIN_NON_ROOT_LIST_PAGE_SCALE, NATURAL_BLOCK_SIZE_PX, RESIZE_BOX_SIZE_PX } from "../../constants";
import { CursorEventState, MouseAction, MouseActionState } from "../../input/state";
import { PageFlags } from "../../items/base/flags-item";
import { ItemType } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";
import { isComposite } from "../../items/composite-item";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, PageItem, isPage } from "../../items/page-item";
import { isSearch } from "../../items/search-item";
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
import { EMPTY_VEID, VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeFlagIsRoot, arrangeItem, arrangeItemPath, getCommonVisualElementFlags } from "./item";
import { arrangeCellPopupPath } from "./popup";
import { getMovingTreeItemInParentMaybe, getVePropertiesForItem } from "./util";


function listPageScrollOffsetPx(
  store: StoreContextModel,
  pageVeid: Veid,
  listChildAreaBoundsPx: BoundingBox,
  listViewportBoundsPx: BoundingBox,
): { x: number, y: number } {
  return {
    x: Math.max(0, listChildAreaBoundsPx.w - listViewportBoundsPx.w) * store.perItem.getPageScrollXProp(pageVeid),
    y: Math.max(0, listChildAreaBoundsPx.h - listViewportBoundsPx.h) * store.perItem.getPageScrollYProp(pageVeid),
  };
}


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
  const listPageActualVeid = VeFns.veidFromItems(displayItem_pageWithChildren, actualLinkItemMaybe_pageWithChildren);
  const currentPopupSpec = store.history.currentPopupSpec();
  const isBackgroundRenderOfPopupPage =
    currentPopupSpec != null &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    VeFns.compareVeids(currentPopupSpec.actualVeid, listPageActualVeid) == 0;

  const focusVeid = VeFns.veidFromPath(store.history.getFocusPath());
  const focusPath = store.history.getFocusPath();
  const pages = store.topTitledPages.get();
  const activeMovingVe = MouseActionState.isAction(MouseAction.Moving)
    ? MouseActionState.getActiveVisualElement()
    : null;
  const activeMovingChildId = activeMovingVe
    ? activeMovingVe.actualLinkItemMaybe?.id ?? activeMovingVe.displayItem.id
    : null;
  const movingItemInThisPage = (() => {
    const activeMovingChildItem = activeMovingChildId
      ? itemState.get(activeMovingChildId)
      : null;
    if (activeMovingChildItem && activeMovingChildItem.parentId == displayItem_pageWithChildren.id) {
      return activeMovingChildItem;
    }
    return getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);
  })();
  const activeMovingOriginalOrdering = activeMovingChildId
    ? MouseActionState.getMoveRollback()?.find(entry => entry.id == activeMovingChildId)?.ordering ?? null
    : null;
  let selectedVeid = PageFns.resolveListPageSelectedItem(
    displayItem_pageWithChildren,
    store.perItem.getSelectedListPageItem(listPageActualVeid),
    movingItemInThisPage?.id ?? null,
    movingItemInThisPage && activeMovingOriginalOrdering
      ? new Uint8Array(activeMovingOriginalOrdering)
      : null,
  );
  if (activeMovingVe && VeFns.compareVeids(selectedVeid, VeFns.actualVeidFromVe(activeMovingVe)) == 0) {
    selectedVeid = PageFns.resolveListPageSelectedItem(
      displayItem_pageWithChildren,
      selectedVeid,
      activeMovingChildId,
      activeMovingOriginalOrdering ? new Uint8Array(activeMovingOriginalOrdering) : null,
    );
  }
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
  if (store.history.currentPopupSpec() == null &&
    selectedVeid != EMPTY_VEID && selectedVeid.itemId !== "") {
    const selectedItem = itemState.get(selectedVeid.itemId);
    if (selectedItem && isPage(selectedItem) && VeFns.itemIdFromPath(focusPath) === selectedVeid.itemId) {
      focusedChildItemMaybe = selectedItem;
    }
  }

  if (!focusedChildItemMaybe && store.history.currentPopupSpec() == null && pageIdx >= 0) {
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

  const isPopupRoot = !!(flags & ArrangeItemFlags.IsPopupRoot);
  const parentIsPopup = !!(flags & ArrangeItemFlags.ParentIsPopup);
  const insidePopup = isPopupRoot || parentIsPopup;
  const isNestedListPage = !!(flags & ArrangeItemFlags.IsListPageMainRoot);

  const isFull = geometry.boundsPx.h == store.desktopMainAreaBoundsPx().h;
  const proportionalListScale = geometry.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;
  const listScale = (isFull || insidePopup) ? 1.0 : Math.max(MIN_NON_ROOT_LIST_PAGE_SCALE, proportionalListScale);

  if (isFull) {
    VesCache.titles.pushTopTitledPage(pageWithChildrenVePath);
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

  // Snap the scaled list width so translucent/nested separators land on whole pixels.
  const listWidthPx = Math.round(LINE_HEIGHT_PX * listWidthBl * listScale);

  let resizeBoundsPx = {
    x: listWidthPx - RESIZE_BOX_SIZE_PX,
    y: 0,
    w: RESIZE_BOX_SIZE_PX,
    h: geometry.viewportBoundsPx!.h
  }
  // Add horizontal resize for root pages, popup pages, and nested list pages
  if (isFull || insidePopup || isNestedListPage) {
    hitboxes.push(HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx));
  }

  let movingItem = null;
  movingItem = movingItemInThisPage;

  const isEmbeddedInteractive =
    !!(displayItem_pageWithChildren.flags & PageFlags.EmbeddedInteractive) &&
    (VeFns.pathDepth(parentPath) >= 2) &&
    !(flags & ArrangeItemFlags.IsTopRoot) &&
    !(flags & ArrangeItemFlags.IsPopupRoot) &&
    !(flags & ArrangeItemFlags.IsListPageMainRoot);

  const listViewportBoundsPx = cloneBoundingBox(geometry.viewportBoundsPx!)!;
  listViewportBoundsPx.w = listWidthPx;
  const listChildAreaBoundsPx = cloneBoundingBox(listViewportBoundsPx)!;
  listChildAreaBoundsPx.h = geometry.viewportBoundsPx!.h;
  const blockSizePx = {
    w: listViewportBoundsPx.w / (displayItem_pageWithChildren.tableColumns[0].widthGr / GRID_SIZE),
    h: 0  // TODO (LOW): better to calculate this, but it's not needed for anything.
  };

  const pageSpec: VisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    actualLinkItemMaybe: actualLinkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
      getCommonVisualElementFlags(flags) |
      (isEmbeddedInteractive ? VisualElementFlags.EmbeddedInteractiveRoot : VisualElementFlags.None) |
      (flags & ArrangeItemFlags.IsPopupRoot && store.history.getFocusItem().id == pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
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

  let skippedCount = 0;
  let listChildPaths: Array<VisualElementPath> = [];
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId);
    if (!childItem) {
      console.warn("Skipping missing child item while arranging list page.", {
        pageId: displayItem_pageWithChildren.id,
        childId,
      });
      skippedCount += 1;
      continue;
    }
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

    const blockSizePx = { w: LINE_HEIGHT_PX * listScale, h: LINE_HEIGHT_PX * listScale };

    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx - skippedCount, 0, listWidthBl, insidePopup, true, false, false);

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
    VesCache.arrange.createOrRecycleVisualElementSignal(listItemVeSpec, listItemRelationships, childPath);
    listChildPaths.push(childPath);
  }

  listChildAreaBoundsPx.h = Math.max(
    (listChildPaths.length * LINE_HEIGHT_PX + LIST_PAGE_TOP_PADDING_PX) * listScale,
    geometry.viewportBoundsPx!.h,
  );

  if (movingItemInThisPage && !isBackgroundRenderOfPopupPage) {
    const actualMovingItemLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const scrollVeid = flags & ArrangeItemFlags.IsPopupRoot
      ? currentPopupSpec!.actualVeid
      : listPageActualVeid;
    const scrollOffsetPx = listPageScrollOffsetPx(store, scrollVeid, listChildAreaBoundsPx, listViewportBoundsPx);
    const currentPageVe = VesCache.current.readNode(pageWithChildrenVePath);
    const cellBoundsPx = (() => {
      if (currentPageVe != null) {
        const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, currentPageVe);
        return {
          x: mouseDesktopPosPx.x - viewportBoundsPx.x + scrollOffsetPx.x,
          y: mouseDesktopPosPx.y - viewportBoundsPx.y + scrollOffsetPx.y,
          w: dimensionsBl.w * LINE_HEIGHT_PX * listScale,
          h: dimensionsBl.h * LINE_HEIGHT_PX * listScale,
        };
      }

      if (flags & ArrangeItemFlags.IsPopupRoot) {
        const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
        return {
          x: mouseDesktopPosPx.x - geometry.viewportBoundsPx!.x - adjX + scrollOffsetPx.x,
          y: mouseDesktopPosPx.y - geometry.viewportBoundsPx!.y + scrollOffsetPx.y,
          w: dimensionsBl.w * LINE_HEIGHT_PX * listScale,
          h: dimensionsBl.h * LINE_HEIGHT_PX * listScale,
        };
      }

      const popupTitleHeightMaybePx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
      // TODO (MEDIUM): adjX is a hack, the calculations should be such that an adjustment here is not necessary.
      const adjX = flags & ArrangeItemFlags.IsTopRoot ? 0 : store.getCurrentDockWidthPx();
      return {
        x: mouseDesktopPosPx.x - geometry.boundsPx.x - adjX + scrollOffsetPx.x,
        y: mouseDesktopPosPx.y - geometry.boundsPx.y - popupTitleHeightMaybePx + scrollOffsetPx.y,
        w: dimensionsBl.w * LINE_HEIGHT_PX * listScale,
        h: dimensionsBl.h * LINE_HEIGHT_PX * listScale,
      };
    })();

    const clickOffsetProp = MouseActionState.getClickOffsetProp()!;
    cellBoundsPx.x -= clickOffsetProp.x * cellBoundsPx.w;
    cellBoundsPx.y -= clickOffsetProp.y * cellBoundsPx.h;
    const cellGeometry = ItemFns.calcGeometry_InCell(movingItemInThisPage, cellBoundsPx, false, insidePopup, false, false, false, false, false, false, store.smallScreenMode());
    listChildPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItemInThisPage, actualMovingItemLinkItemMaybe, cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull |
      ArrangeItemFlags.IsMoving |
      (insidePopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None)));
  }

  pageRelationships.childrenPaths = listChildPaths;

  if (selectedVeid.itemId != "") {
    const boundsPx = {
      x: listWidthPx,
      y: 0,
      w: Math.max(0, geometry.viewportBoundsPx!.w - listWidthPx),
      h: geometry.viewportBoundsPx!.h
    };
    const selectedIsPage = isPage(itemState.get(selectedVeid.itemId)!);
    const canShiftLeft = arrangeFlagIsRoot(flags) && selectedIsPage;
    pageRelationships.selectedPath = arrangeSelectedListItemPath(store, selectedVeid, boundsPx, pageWithChildrenVePath, canShiftLeft, selectedIsPage, insidePopup);
  }

  if (flags & ArrangeItemFlags.IsTopRoot) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageRelationships.popupPath = arrangeCellPopupPath(store);
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
  isRoot: boolean,
  insidePopup: boolean): VisualElementSignal | null {

  const item = itemState.get(veid.itemId);
  if (!item) {
    return null;
  }
  const actualLinkItemMaybe = veid.linkIdMaybe == null ? null : itemState.get(veid.linkIdMaybe);
  if (veid.linkIdMaybe != null && (!actualLinkItemMaybe || !isLink(actualLinkItemMaybe))) {
    return null;
  }
  const treeItem = VeFns.treeItemFromVeid(veid);
  if (!treeItem) {
    return null;
  }

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

  if (isPage(item) || isSearch(item)) {
    let hitboxes: Array<Hitbox> = [];
    if (isPage(item) && canShiftLeft) {
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
    store, currentPath, ArrangeAlgorithm.List, li, actualLinkItemMaybe as LinkItem | null, cellGeometry,
    ArrangeItemFlags.RenderChildrenAsFull |
    (isRoot ? ArrangeItemFlags.IsListPageMainRoot : ArrangeItemFlags.None) |
    (insidePopup ? ArrangeItemFlags.ParentIsPopup : ArrangeItemFlags.None));
  return result;
}

export function arrangeSelectedListItemPath(
  store: StoreContextModel,
  veid: Veid,
  boundsPx: BoundingBox,
  currentPath: VisualElementPath,
  canShiftLeft: boolean,
  isRoot: boolean,
  insidePopup: boolean): VisualElementPath | null {

  const selectedVes = arrangeSelectedListItem(store, veid, boundsPx, currentPath, canShiftLeft, isRoot, insidePopup);
  return selectedVes ? VeFns.veToPath(selectedVes.get()) : null;
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
      getCommonVisualElementFlags(flags) |
      VisualElementFlags.EmbeddedInteractiveRoot,
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
  const activeMovingVe = MouseActionState.isAction(MouseAction.Moving)
    ? MouseActionState.getActiveVisualElement()
    : null;
  const activeMovingChildId = activeMovingVe
    ? activeMovingVe.actualLinkItemMaybe?.id ?? activeMovingVe.displayItem.id
    : null;
  const movingItemInThisPage = (() => {
    const activeMovingChildItem = activeMovingChildId
      ? itemState.get(activeMovingChildId)
      : null;
    if (activeMovingChildItem && activeMovingChildItem.parentId == displayItem_pageWithChildren.id) {
      return activeMovingChildItem;
    }
    return getMovingTreeItemInParentMaybe(displayItem_pageWithChildren.id);
  })();

  let listChildPaths: Array<VisualElementPath> = [];
  let skippedCount = 0;
  for (let idx = 0; idx < displayItem_pageWithChildren.computed_children.length; ++idx) {
    const childId = displayItem_pageWithChildren.computed_children[idx];
    const childItem = itemState.get(childId);
    if (!childItem) {
      console.warn("Skipping missing child item while arranging dock list page.", {
        pageId: displayItem_pageWithChildren.id,
        childId,
      });
      skippedCount += 1;
      continue;
    }
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);

    if (movingItemInThisPage && childItem.id == movingItemInThisPage.id) {
      skippedCount += 1;
      continue;
    }

    if (isComposite(displayItem)) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem, linkItemMaybe));
    }

    const blockSizePx = NATURAL_BLOCK_SIZE_PX;
    const widthBl = geometry.boundsPx.w / blockSizePx.w;
    const listItemGeometry = ItemFns.calcGeometry_ListItem(childItem, blockSizePx, idx - skippedCount, 0, widthBl, false, false, false, false);

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
      row: idx - skippedCount,
      blockSizePx,
    };
    const listItemRelationships: VisualElementRelationships = {};
    VesCache.arrange.createOrRecycleVisualElementSignal(listItemVeSpec, listItemRelationships, childPath);
    listChildPaths.push(childPath);
  }

  if (movingItemInThisPage) {
    const actualMovingItemLinkItemMaybe = isLink(movingItemInThisPage) ? asLinkItem(movingItemInThisPage) : null;
    const dimensionsBl = ItemFns.calcSpatialDimensionsBl(movingItemInThisPage);
    const mouseDesktopPosPx = CursorEventState.getLatestDesktopPx(store);
    const titleHeightPx = geometry.boundsPx.h - geometry.viewportBoundsPx!.h;
    const cellBoundsPx = {
      x: mouseDesktopPosPx.x - geometry.boundsPx.x,
      y: mouseDesktopPosPx.y - geometry.boundsPx.y - titleHeightPx,
      w: dimensionsBl.w * LINE_HEIGHT_PX,
      h: dimensionsBl.h * LINE_HEIGHT_PX,
    };

    const clickOffsetProp = MouseActionState.getClickOffsetProp() ?? { x: 0, y: 0 };
    cellBoundsPx.x -= clickOffsetProp.x * cellBoundsPx.w;
    cellBoundsPx.y -= clickOffsetProp.y * cellBoundsPx.h;
    const cellGeometry = ItemFns.calcGeometry_InCell(movingItemInThisPage, cellBoundsPx, false, false, false, false, false, false, false, false, store.smallScreenMode());
    listChildPaths.push(arrangeItemPath(
      store, pageWithChildrenVePath, ArrangeAlgorithm.Grid, movingItemInThisPage, actualMovingItemLinkItemMaybe, cellGeometry,
      ArrangeItemFlags.RenderChildrenAsFull |
      ArrangeItemFlags.IsMoving));
  }

  pageRelationships.childrenPaths = listChildPaths;

  return { spec: pageSpec, relationships: pageRelationships };
}
