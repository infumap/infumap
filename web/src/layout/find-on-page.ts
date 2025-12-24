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

import { GRID_SIZE } from "../constants";
import { TableFlags } from "../items/base/flags-item";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { asTableItem, isTable } from "../items/table-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";
import { fullArrange } from "./arrange";
import { VesCache } from "./ves-cache";
import { VeFns, VisualElementPath, isVeTranslucentPage } from "./visual-element";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { asPageItem, isPage, ArrangeAlgorithm } from "../items/page-item";
import { LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX } from "../constants";
import { isPositionalItem, asPositionalItem } from "../items/base/positional-item";
import { isXSizableItem, asXSizableItem } from "../items/base/x-sizeable-item";

function isVeInsideTranslucentPage(currentVePath: VisualElementPath): boolean {
  let path = currentVePath;
  path = VeFns.parentPath(currentVePath);
  if (!path) { return false; }
  const ves = VesCache.get(path);
  if (!ves) { return false; }
  const ve = ves.get();
  if (isPage(ve.displayItem) && isVeTranslucentPage(ve)) {
    return true;
  }
  return false;
}

export function findInVisualElements(store: StoreContextModel, findText: string): Array<VisualElementPath> {
  if (!findText || findText.trim() === "") {
    return [];
  }

  const matches: Array<VisualElementPath> = [];
  const searchLower = findText.toLowerCase();

  const addMatchIfFound = (path: VisualElementPath) => {
    const ves = VesCache.get(path);
    if (!ves) return;
    if (isVeInsideTranslucentPage(path)) { return; }

    const ve = ves.get();

    if (ve.displayItem && isTitledItem(ve.displayItem)) {
      const title = asTitledItem(ve.displayItem).title;
      if (title.toLowerCase().includes(searchLower)) {
        matches.push(path);
      }
    }

    if (ve.evaluatedTitle && ve.evaluatedTitle.toLowerCase().includes(searchLower)) {
      matches.push(path);
    }
  };

  const traverseVe = (ve: any) => {
    const path = VeFns.veToPath(ve);
    addMatchIfFound(path);

    if (ve.childrenVes) {
      for (const childVes of ve.childrenVes) {
        traverseVe(childVes.get());
      }
    }

    const attachmentsVes = VesCache.getAttachmentsVes(VeFns.veToPath(ve))();
    if (attachmentsVes) {
      for (const attachmentVes of attachmentsVes) {
        traverseVe(attachmentVes.get());
      }
    }

    const popupVes = VesCache.getPopupVes(VeFns.veToPath(ve))();
    if (popupVes) {
      traverseVe(popupVes.get());
    }

    // traverse selectedVes
    const selectedVes = VesCache.getSelectedVes(VeFns.veToPath(ve))();
    if (selectedVes) {
      traverseVe(selectedVes.get());
    }

    const dockVes = VesCache.getDockVes(VeFns.veToPath(ve))();
    if (dockVes) {
      traverseVe(dockVes.get());
    }
  };

  const umbrellaVe = store.umbrellaVisualElement.get();
  traverseVe(umbrellaVe);

  return matches;
}

export function findInTableDirectChildren(tableItem: any, findText: string): Array<{ itemId: Uid, rowIndex: number }> {
  if (!findText || findText.trim() === "") {
    return [];
  }

  const matches: Array<{ itemId: Uid, rowIndex: number }> = [];
  const searchLower = findText.toLowerCase();

  for (let i = 0; i < tableItem.computed_children.length; i++) {
    const childId = tableItem.computed_children[i];
    const child = itemState.get(childId);

    if (child && isTitledItem(child)) {
      const title = asTitledItem(child).title;
      if (title.toLowerCase().includes(searchLower)) {
        matches.push({ itemId: childId, rowIndex: i });
      }
    }
  }

  return matches;
}

export function clearAllHighlights(store: StoreContextModel) {
  store.find.highlightedPath.set(null);
}

export function navigateToMatch(store: StoreContextModel, matchPath: VisualElementPath, matchIndex: number) {
  store.find.highlightedPath.set(matchPath);
  store.find.currentMatchIndex.set(matchIndex);

  const ves = VesCache.get(matchPath);
  if (!ves) {
    const veid = VeFns.veidFromPath(matchPath);
    const item = itemState.get(veid.itemId);
    if (!item) {
      console.warn("Match item not found in itemState:", veid.itemId);
      fullArrange(store);
      return;
    }

    const parentItem = itemState.get(item.parentId);
    if (!parentItem) {
      console.warn("Parent item not found:", item.parentId);
      fullArrange(store);
      return;
    }

    let parentPath = VeFns.parentPath(matchPath);
    let parentVes = null;
    while (parentPath && !parentVes) {
      parentVes = VesCache.get(parentPath);
      if (!parentVes) {
        parentPath = VeFns.parentPath(parentPath);
      }
    }

    if (!parentVes) {
      console.warn("No parent VES found in path");
      fullArrange(store);
      return;
    }

    const parentVe = parentVes.get();

    if (isTable(parentVe.displayItem)) {
      const tableItem = asTableItem(parentVe.displayItem);
      const tableVeid = VeFns.veidFromVe(parentVe);

      let rowIndex = -1;
      const children = tableItem.computed_children;
      for (let i = 0; i < children.length; i++) {
        if (children[i] === item.id) {
          rowIndex = i;
          break;
        }
      }

      if (rowIndex === -1) {
        console.warn("Item not found in table children");
        fullArrange(store);
        return;
      }

      const sizeBl = parentVe.linkItemMaybe
        ? { h: parentVe.linkItemMaybe.spatialHeightGr / GRID_SIZE }
        : { h: tableItem.spatialHeightGr / GRID_SIZE };
      const showColHeader = !!(tableItem.flags & TableFlags.ShowColHeader);
      const numVisibleRows = sizeBl.h - 1 - (showColHeader ? 1 : 0);

      const newScrollPos = Math.max(0, rowIndex - Math.floor(numVisibleRows / 2));
      store.perItem.setTableScrollYPos(tableVeid, newScrollPos);
    }
    else if (isPage(parentVe.displayItem)) {
      const pageItem = asPageItem(parentVe.displayItem);
      const pageVeid = VeFns.veidFromVe(parentVe);

      if (isContainer(parentItem)) {
        const containerItem = asContainerItem(parentItem);

        let itemIndex = -1;
        for (let i = 0; i < containerItem.computed_children.length; i++) {
          if (containerItem.computed_children[i] === item.id) {
            itemIndex = i;
            break;
          }
        }

        if (itemIndex === -1) {
          console.warn("Item not found in parent children");
          fullArrange(store);
          return;
        }

        if (pageItem.arrangeAlgorithm === ArrangeAlgorithm.List) {
          const itemYPx = itemIndex * LINE_HEIGHT_PX + LIST_PAGE_TOP_PADDING_PX;
          const viewportHeight = parentVe.viewportBoundsPx?.h || parentVe.boundsPx.h;
          const childAreaHeight = parentVe.childAreaBoundsPx?.h || viewportHeight;

          if (childAreaHeight > viewportHeight) {
            const centerOffset = viewportHeight / 2 - LINE_HEIGHT_PX / 2;
            const targetScrollY = Math.max(0, itemYPx - centerOffset);
            const scrollProp = targetScrollY / (childAreaHeight - viewportHeight);
            store.perItem.setPageScrollYProp(pageVeid, Math.min(1, scrollProp));
          }
        }
        else if (pageItem.arrangeAlgorithm === ArrangeAlgorithm.Grid) {
          const cols = pageItem.gridNumberOfColumns;
          const row = Math.floor(itemIndex / cols);
          const col = itemIndex % cols;

          const cellHeight = parentVe.cellSizePx?.h || LINE_HEIGHT_PX;
          const cellWidth = parentVe.cellSizePx?.w || LINE_HEIGHT_PX;

          const itemYPx = row * cellHeight;
          const itemXPx = col * cellWidth;

          const viewportHeight = parentVe.viewportBoundsPx?.h || parentVe.boundsPx.h;
          const viewportWidth = parentVe.viewportBoundsPx?.w || parentVe.boundsPx.w;
          const childAreaHeight = parentVe.childAreaBoundsPx?.h || viewportHeight;
          const childAreaWidth = parentVe.childAreaBoundsPx?.w || viewportWidth;

          if (childAreaHeight > viewportHeight) {
            const centerOffsetY = viewportHeight / 2 - cellHeight / 2;
            const targetScrollY = Math.max(0, itemYPx - centerOffsetY);
            const scrollPropY = targetScrollY / (childAreaHeight - viewportHeight);
            store.perItem.setPageScrollYProp(pageVeid, Math.min(1, scrollPropY));
          }

          if (childAreaWidth > viewportWidth) {
            const centerOffsetX = viewportWidth / 2 - cellWidth / 2;
            const targetScrollX = Math.max(0, itemXPx - centerOffsetX);
            const scrollPropX = targetScrollX / (childAreaWidth - viewportWidth);
            store.perItem.setPageScrollXProp(pageVeid, Math.min(1, scrollPropX));
          }
        }
        else if (isPositionalItem(item)) {
          const positionalItem = asPositionalItem(item);
          const itemX = positionalItem.spatialPositionGr.x / GRID_SIZE;
          const itemY = positionalItem.spatialPositionGr.y / GRID_SIZE;
          const itemWidth = isXSizableItem(item) ? asXSizableItem(item).spatialWidthGr / GRID_SIZE : 1;
          const itemHeight = itemWidth; // Approximate height

          const viewportHeight = parentVe.viewportBoundsPx?.h || parentVe.boundsPx.h;
          const viewportWidth = parentVe.viewportBoundsPx?.w || parentVe.boundsPx.w;
          const childAreaHeight = parentVe.childAreaBoundsPx?.h || viewportHeight;
          const childAreaWidth = parentVe.childAreaBoundsPx?.w || viewportWidth;

          const blockSizePx = {
            w: childAreaWidth / (pageItem.innerSpatialWidthGr / GRID_SIZE),
            h: childAreaHeight / (pageItem.innerSpatialWidthGr / GRID_SIZE * (childAreaHeight / childAreaWidth))
          };

          const itemYPx = itemY * blockSizePx.h;
          const itemXPx = itemX * blockSizePx.w;

          if (childAreaHeight > viewportHeight) {
            const centerOffsetY = viewportHeight / 2 - itemHeight * blockSizePx.h / 2;
            const targetScrollY = Math.max(0, itemYPx - centerOffsetY);
            const scrollPropY = targetScrollY / (childAreaHeight - viewportHeight);
            store.perItem.setPageScrollYProp(pageVeid, Math.min(1, scrollPropY));
          }

          if (childAreaWidth > viewportWidth) {
            const centerOffsetX = viewportWidth / 2 - itemWidth * blockSizePx.w / 2;
            const targetScrollX = Math.max(0, itemXPx - centerOffsetX);
            const scrollPropX = targetScrollX / (childAreaWidth - viewportWidth);
            store.perItem.setPageScrollXProp(pageVeid, Math.min(1, scrollPropX));
          }
        }
      }
    }

    fullArrange(store);
    return;
  }

  const ve = ves.get();

  if (ve.parentPath) {
    const parentVes = VesCache.get(ve.parentPath);
    const parentVe = parentVes?.get();

    if (parentVe && isTable(parentVe.displayItem)) {
      const rowNumber = ve.row;
      if (rowNumber === null || rowNumber === undefined) {
        console.warn("Row number not found for table item");
        fullArrange(store);
        return;
      }

      const tableItem = asTableItem(parentVe.displayItem);
      const tableVeid = VeFns.veidFromVe(parentVe);
      const sizeBl = parentVe.linkItemMaybe
        ? { h: parentVe.linkItemMaybe.spatialHeightGr / GRID_SIZE }
        : { h: tableItem.spatialHeightGr / GRID_SIZE };
      const showColHeader = !!(tableItem.flags & TableFlags.ShowColHeader);
      const numVisibleRows = sizeBl.h - 1 - (showColHeader ? 1 : 0);

      const currentScrollPos = store.perItem.getTableScrollYPos(tableVeid);
      if (rowNumber < currentScrollPos || rowNumber >= currentScrollPos + numVisibleRows) {
        const newScrollPos = Math.max(0, rowNumber - Math.floor(numVisibleRows / 2));
        store.perItem.setTableScrollYPos(tableVeid, newScrollPos);
      }
    }
  }

  fullArrange(store);
}

export function performFind(store: StoreContextModel, findText: string) {
  if (!findText || findText.trim() === "") {
    clearAllHighlights(store);
    store.find.findMatches.set([]);
    store.find.currentMatchIndex.set(-1);
    fullArrange(store);
    return;
  }

  const vesMatches = findInVisualElements(store, findText);

  const tableMatches: Array<VisualElementPath> = [];

  const checkTableForMatches = (ve: any, path: VisualElementPath) => {
    if (isTable(ve.displayItem)) {
      const tableItem = asTableItem(ve.displayItem);
      const matches = findInTableDirectChildren(tableItem, findText);

      for (const match of matches) {
        const childVeid = { itemId: match.itemId, linkIdMaybe: null };
        const childPath = VeFns.addVeidToPath(childVeid, path);

        if (!vesMatches.includes(childPath)) {
          tableMatches.push(childPath);
        }
      }
    }
  };

  const traverseForTables = (ve: any) => {
    const path = VeFns.veToPath(ve);
    checkTableForMatches(ve, path);

    if (ve.childrenVes) {
      for (const childVes of ve.childrenVes) {
        traverseForTables(childVes.get());
      }
    }

  };

  const umbrellaVe = store.umbrellaVisualElement.get();
  traverseForTables(umbrellaVe);

  const allMatches = [...vesMatches, ...tableMatches];

  store.find.findMatches.set(allMatches);
  store.find.currentFindText.set(findText);

  if (allMatches.length > 0) {
    store.find.currentMatchIndex.set(0);
    navigateToMatch(store, allMatches[0], 0);
  } else {
    clearAllHighlights(store);
    store.find.currentMatchIndex.set(-1);
    fullArrange(store);
  }
}

export function navigateToNextMatch(store: StoreContextModel) {
  const matches = store.find.findMatches.get();
  const currentIndex = store.find.currentMatchIndex.get();

  if (matches.length === 0) {
    return;
  }

  let nextIndex = currentIndex + 1;
  if (nextIndex >= matches.length) { nextIndex = 0; }

  navigateToMatch(store, matches[nextIndex], nextIndex);
}

export function navigateToPreviousMatch(store: StoreContextModel) {
  const matches = store.find.findMatches.get();
  const currentIndex = store.find.currentMatchIndex.get();

  if (matches.length === 0) {
    return;
  }

  let prevIndex = currentIndex - 1;
  if (prevIndex < 0) { prevIndex = matches.length - 1; }

  navigateToMatch(store, matches[prevIndex], prevIndex);
}

export function closeFindOverlay(store: StoreContextModel) {
  clearAllHighlights(store);
  store.find.clear();
  store.overlay.findOverlayVisible.set(false);
  fullArrange(store);
}
