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
import { VeFns, VisualElementPath } from "./visual-element";

export function findInVisualElements(store: StoreContextModel, findText: string): Array<VisualElementPath> {
  if (!findText || findText.trim() === "") {
    return [];
  }

  const matches: Array<VisualElementPath> = [];
  const searchLower = findText.toLowerCase();

  const addMatchIfFound = (path: VisualElementPath) => {
    const ves = VesCache.get(path);
    if (!ves) return;

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

    if (ve.attachmentsVes) {
      for (const attachmentVes of ve.attachmentsVes) {
        traverseVe(attachmentVes.get());
      }
    }

    if (ve.popupVes) {
      traverseVe(ve.popupVes.get());
    }

    if (ve.selectedVes) {
      traverseVe(ve.selectedVes.get());
    }

    if (ve.dockVes) {
      traverseVe(ve.dockVes.get());
    }
  };

  const umbrellaVe = store.umbrellaVisualElement.get();
  traverseVe(umbrellaVe);

  return matches;
}

export function findInTableDirectChildren(tableItem: any, findText: string): Array<{itemId: Uid, rowIndex: number}> {
  if (!findText || findText.trim() === "") {
    return [];
  }

  const matches: Array<{itemId: Uid, rowIndex: number}> = [];
  const searchLower = findText.toLowerCase();

  for (let i = 0; i < tableItem.computed_children.length; i++) {
    const childId = tableItem.computed_children[i];
    const child = itemState.get(childId);

    if (child && isTitledItem(child)) {
      const title = asTitledItem(child).title;
      if (title.toLowerCase().includes(searchLower)) {
        matches.push({itemId: childId, rowIndex: i});
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
    console.warn("Match path not found in VesCache:", matchPath);
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
    store.find.currentMatchIndex.set(-1);
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
