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

import { TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL } from "../constants";
import { itemCanEdit } from "../items/base/capabilities-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PageFlags, TableFlags } from "../items/base/flags-item";
import { ImageFns, isImage } from "../items/image-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { arrangeNow, arrangeVirtual } from "../layout/arrange";
import { findClosest, FindDirection, findDirectionFromKeyCode } from "../layout/find";
import { navigateToContainingPageOfItem, navigateToSearches, switchToPage } from "../layout/navigation";
import { EMPTY_VEID, VeFns, VisualElement, VisualElementFlags, veFlagIsRoot } from "../layout/visual-element";


import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { calculateCalendarWindow } from "../util/calendar-layout";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState, MouseActionState } from "./state";
import { newItemInContext } from "./create";
import { isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { serverOrRemote } from "../server";
import { ItemType } from "../items/base/item";
import { HitInfoFns } from "./hit";
import { UMBRELLA_PAGE_UID } from "../util/uid";
import { asContainerItem } from "../items/base/container-item";
import { MOUSE_RIGHT, mouseDownHandler } from "./mouse_down";
import { isComposite } from "../items/composite-item";
import { FileFns, isFile } from "../items/file-item";
import { NoteFns, isNote } from "../items/note-item";
import { PasswordFns, isPassword } from "../items/password-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { getVePropertiesForItem } from "../layout/arrange/util";
import { isPlaceholder } from "../items/placeholder-item";
import { isSearch } from "../items/search-item";
import type { SearchResult } from "../server";


/**
 * Whether or not the value of KeyboardEvent.code corresponds to one of the arrow keys.
 */
export function isArrowKey(key: string) {
  if (key == "ArrowDown") { return true; }
  if (key == "ArrowUp") { return true; }
  if (key == "ArrowLeft") { return true; }
  if (key == "ArrowRight") { return true; }
  return false;
}

function isShiftKey(code: string): boolean {
  return code == "ShiftLeft" || code == "ShiftRight";
}

let shiftNavigationGesture = {
  pending: false,
  cancelled: false,
};

function beginShiftNavigationGesture(ev: KeyboardEvent): void {
  if (ev.repeat) { return; }

  // Treat a bare Shift tap as the keyboard equivalent of right-click/back-up,
  // but cancel it as soon as Shift becomes part of another gesture.
  shiftNavigationGesture = {
    pending: true,
    cancelled: ev.ctrlKey || ev.metaKey || ev.altKey || !MouseActionState.empty(),
  };
}

function consumeShiftNavigationGesture(): boolean {
  const shouldNavigate = shiftNavigationGesture.pending && !shiftNavigationGesture.cancelled;
  shiftNavigationGesture = { pending: false, cancelled: false };
  return shouldNavigate;
}

export function cancelShiftNavigationGesture(): void {
  if (!shiftNavigationGesture.pending) { return; }
  shiftNavigationGesture.cancelled = true;
}

interface ActiveSearchWorkspace {
  searchItemId: string,
  searchVePath: string,
  resultsCount: number,
  results: Array<SearchResult>,
  resultChildVes: Array<VisualElement>,
  resultsPageVe: VisualElement | null,
}

function pathIsSameOrDescendant(path: string, ancestorPath: string): boolean {
  let currentPath: string | null = path;
  while (currentPath) {
    if (currentPath == ancestorPath) {
      return true;
    }
    currentPath = VeFns.parentPath(currentPath);
    if (currentPath == "") {
      break;
    }
  }
  return false;
}

function getActiveSearchWorkspace(store: StoreContextModel): ActiveSearchWorkspace | null {
  if (store.overlay.anOverlayIsVisible()) { return null; }
  if (store.history.currentPopupSpec()) { return null; }

  const listPagePath = store.history.currentPagePath();
  const listPageVeid = store.history.currentPageVeid();
  if (!listPageVeid || !listPagePath) { return null; }

  const listPageItem = itemState.get(listPageVeid.itemId);
  if (!listPageItem || !isPage(listPageItem) || asPageItem(listPageItem).arrangeAlgorithm != ArrangeAlgorithm.List) {
    return null;
  }

  const selectedVeid = store.perItem.getSelectedListPageItem(listPageVeid);
  if (!selectedVeid.itemId) {
    return null;
  }

  const selectedItem = itemState.get(selectedVeid.itemId);
  if (!selectedItem || !isSearch(selectedItem)) {
    return null;
  }

  const selectedVeSignal = VesCache.render.getSelected(listPagePath)();
  const selectedVe = selectedVeSignal?.get() ?? null;
  if (!selectedVe || !isSearch(selectedVe.displayItem)) {
    return null;
  }
  const focusPath = store.history.getFocusPathMaybe();
  const searchVePath = VeFns.veToPath(selectedVe);
  if (!focusPath || !pathIsSameOrDescendant(focusPath, searchVePath)) {
    return null;
  }

  const searchItemId = selectedVe.displayItem.id;
  const results = store.perItem.getSearchResults(searchItemId) ?? [];
  const resultsPageVeSignal = VesCache.render.getChildren(VeFns.veToPath(selectedVe))()[0];
  const resultsPageVe = resultsPageVeSignal?.get() ?? null;
  const resultChildVes = resultsPageVe
    ? VesCache.render.getChildren(VeFns.veToPath(resultsPageVe))().map(sig => sig.get())
    : [];

  return {
    searchItemId,
    searchVePath,
    resultsCount: results.length,
    results,
    resultChildVes,
    resultsPageVe,
  };
}

function clampSearchResultIndex(index: number, numResults: number): number {
  if (numResults <= 0) { return -1; }
  if (index < 0) { return -1; }
  return Math.max(0, Math.min(index, numResults - 1));
}

function getSearchWorkspaceColumnCount(workspace: ActiveSearchWorkspace): number {
  if (!workspace.resultsPageVe || !isPage(workspace.resultsPageVe.displayItem)) {
    return 1;
  }
  const resultsPage = asPageItem(workspace.resultsPageVe.displayItem);
  if (resultsPage.arrangeAlgorithm != ArrangeAlgorithm.Grid) {
    return 1;
  }
  return Math.max(1, resultsPage.gridNumberOfColumns);
}

function searchWorkspaceUsesGridLayout(workspace: ActiveSearchWorkspace): boolean {
  return getSearchWorkspaceColumnCount(workspace) > 1;
}

function getEffectiveFocusedSearchResultIndex(store: StoreContextModel, workspace: ActiveSearchWorkspace): number {
  const storedFocusedRow = clampSearchResultIndex(
    store.perItem.getSearchFocusedResultIndex(workspace.searchItemId),
    workspace.resultsCount,
  );
  if (storedFocusedRow >= 0) {
    return storedFocusedRow;
  }

  const focusPath = store.history.getFocusPathMaybe();
  if (!focusPath) {
    return -1;
  }

  for (let i = 0; i < workspace.resultChildVes.length; i++) {
    const childVe = workspace.resultChildVes[i];
    if (pathIsSameOrDescendant(focusPath, VeFns.veToPath(childVe))) {
      return i;
    }
  }

  return -1;
}

function scrollSearchResultIndexIntoView(store: StoreContextModel, workspace: ActiveSearchWorkspace, resultIndex: number): void {
  const resultsPageVe = workspace.resultsPageVe;
  if (!resultsPageVe || !resultsPageVe.viewportBoundsPx || !resultsPageVe.childAreaBoundsPx || !resultsPageVe.cellSizePx || resultIndex < 0) {
    return;
  }

  const veid = VeFns.actualVeidFromVe(resultsPageVe);
  const maxScrollPx = Math.max(0, resultsPageVe.childAreaBoundsPx.h - resultsPageVe.viewportBoundsPx.h);
  if (maxScrollPx <= 0) {
    store.perItem.setPageScrollYProp(veid, 0);
    return;
  }

  const currentProp = store.perItem.getPageScrollYProp(veid);
  const currentScrollPx = currentProp * maxScrollPx;
  const rowIndex = Math.floor(resultIndex / getSearchWorkspaceColumnCount(workspace));
  const rowTopPx = rowIndex * resultsPageVe.cellSizePx.h;
  const rowBottomPx = rowTopPx + resultsPageVe.cellSizePx.h;
  const viewportTopPx = currentScrollPx;
  const viewportBottomPx = currentScrollPx + resultsPageVe.viewportBoundsPx.h;

  let nextScrollPx = currentScrollPx;
  if (rowTopPx < viewportTopPx) {
    nextScrollPx = rowTopPx;
  } else if (rowBottomPx > viewportBottomPx) {
    nextScrollPx = rowBottomPx - resultsPageVe.viewportBoundsPx.h;
  }

  const nextProp = Math.max(0, Math.min(1, nextScrollPx / maxScrollPx));
  if (Math.abs(nextProp - currentProp) > 0.0001) {
    store.perItem.setPageScrollYProp(veid, nextProp);
  }
}

function nextSearchGridResultIndex(
  workspace: ActiveSearchWorkspace,
  baseIndex: number,
  keyCode: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): number | null {
  if (baseIndex < 0 || baseIndex >= workspace.resultsCount) {
    return null;
  }

  const numCols = getSearchWorkspaceColumnCount(workspace);
  const currentRow = Math.floor(baseIndex / numCols);
  const currentCol = baseIndex % numCols;
  const numRows = Math.ceil(workspace.resultsCount / numCols);

  const resultIndexForRowAndCol = (row: number, col: number): number => {
    const rowStart = row * numCols;
    const rowEnd = Math.min(rowStart + numCols - 1, workspace.resultsCount - 1);
    return Math.min(rowStart + col, rowEnd);
  };

  if (keyCode == "ArrowLeft") {
    if (currentCol == 0) { return null; }
    return baseIndex - 1;
  }
  if (keyCode == "ArrowRight") {
    const rowEnd = Math.min((currentRow + 1) * numCols - 1, workspace.resultsCount - 1);
    if (baseIndex >= rowEnd) { return null; }
    return baseIndex + 1;
  }
  if (keyCode == "ArrowUp") {
    if (currentRow == 0) { return null; }
    return resultIndexForRowAndCol(currentRow - 1, currentCol);
  }
  if (keyCode == "ArrowDown") {
    if (currentRow >= numRows - 1) { return null; }
    return resultIndexForRowAndCol(currentRow + 1, currentCol);
  }
  return null;
}

function handleSearchWorkspaceArrowMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  const workspace = getActiveSearchWorkspace(store);
  if (!workspace) { return false; }
  const focusPath = store.history.getFocusPathMaybe();
  const clearSearchWorkspaceSelection = () => {
    store.perItem.setSearchSelectedResultIndex(workspace.searchItemId, -1);
    store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
    store.history.setFocus(workspace.searchVePath);
    arrangeNow(store, "key-search-clear-selection");
  };

  const selectedRow = clampSearchResultIndex(
    store.perItem.getSearchSelectedResultIndex(workspace.searchItemId),
    workspace.resultsCount,
  );
  const focusedRow = getEffectiveFocusedSearchResultIndex(store, workspace);
  const selectSearchWorkspaceResult = (resultIndex: number) => {
    store.perItem.setSearchSelectedResultIndex(workspace.searchItemId, resultIndex);
    store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
    store.history.setFocus(workspace.searchVePath);
    scrollSearchResultIndexIntoView(store, workspace, resultIndex);
    arrangeNow(store, "key-search-select-result");
  };

  if (searchWorkspaceUsesGridLayout(workspace)) {
    const baseIndex = focusedRow >= 0 ? focusedRow : selectedRow;
    const currentPagePath = store.history.currentPagePath();

    if (ev.code == "ArrowLeft") {
      const atLeftEdge = baseIndex < 0 || baseIndex % getSearchWorkspaceColumnCount(workspace) == 0;
      if (atLeftEdge) {
        if (!currentPagePath) { return false; }
        store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
        store.history.setFocus(currentPagePath);
        arrangeNow(store, "key-search-grid-to-list");
        return true;
      }
    }

    if (ev.code != "ArrowLeft" && ev.code != "ArrowRight" && ev.code != "ArrowUp" && ev.code != "ArrowDown") {
      return false;
    }
    if (baseIndex < 0) {
      if (ev.code == "ArrowDown" && focusPath == workspace.searchVePath && workspace.resultsCount > 0) {
        selectSearchWorkspaceResult(0);
        return true;
      }
      return false;
    }

    const nextIndex = nextSearchGridResultIndex(workspace, baseIndex, ev.code);
    if (nextIndex == null) {
      if (ev.code == "ArrowUp" && baseIndex == 0) {
        clearSearchWorkspaceSelection();
      }
      return true;
    }

    store.perItem.setSearchSelectedResultIndex(workspace.searchItemId, nextIndex);
    store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, focusedRow >= 0 ? nextIndex : -1);
    if (focusedRow >= 0) {
      const targetVe = workspace.resultChildVes[nextIndex];
      if (targetVe) {
        store.history.setFocus(VeFns.veToPath(targetVe));
      }
    }
    scrollSearchResultIndexIntoView(store, workspace, nextIndex);
    arrangeNow(store, "key-search-grid-nav");
    return true;
  }

  if (ev.code == "ArrowLeft") {
    if (focusPath != workspace.searchVePath) { return false; }
    const currentPagePath = store.history.currentPagePath();
    if (!currentPagePath) { return false; }
    store.history.setFocus(currentPagePath);
    arrangeNow(store, "key-search-to-list");
    return true;
  }

  if (ev.code == "ArrowRight") {
    if (focusedRow < 0) { return false; }
    store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
    store.history.setFocus(workspace.searchVePath);
    arrangeNow(store, "key-search-item-to-row");
    return true;
  }

  if (ev.code != "ArrowUp" && ev.code != "ArrowDown") {
    return false;
  }

  const baseRow = focusedRow >= 0 ? focusedRow : selectedRow;
  if (baseRow < 0) {
    if (ev.code == "ArrowDown" && focusPath == workspace.searchVePath && workspace.resultsCount > 0) {
      selectSearchWorkspaceResult(0);
      return true;
    }
    return false;
  }

  const nextRowCandidate = baseRow + (ev.code == "ArrowUp" ? -1 : 1);
  if (nextRowCandidate < 0 || nextRowCandidate >= workspace.resultsCount) {
    if (ev.code == "ArrowUp" && baseRow == 0) {
      clearSearchWorkspaceSelection();
    }
    return true;
  }
  const nextRow = nextRowCandidate;

  store.perItem.setSearchSelectedResultIndex(workspace.searchItemId, nextRow);
  store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, focusedRow >= 0 ? nextRow : -1);
  if (focusedRow >= 0) {
    const targetVe = workspace.resultChildVes[nextRow];
    if (targetVe) {
      store.history.setFocus(VeFns.veToPath(targetVe));
    }
  }
  scrollSearchResultIndexIntoView(store, workspace, nextRow);
  arrangeNow(store, "key-search-row-nav");
  return true;
}

function handleSearchWorkspaceTabMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  const workspace = getActiveSearchWorkspace(store);
  if (!workspace) { return false; }

  const selectedRow = clampSearchResultIndex(
    store.perItem.getSearchSelectedResultIndex(workspace.searchItemId),
    workspace.resultsCount,
  );
  const focusedRow = getEffectiveFocusedSearchResultIndex(store, workspace);

  if (!ev.shiftKey) {
    if (selectedRow < 0 || focusedRow >= 0) { return false; }
    store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, selectedRow);
    const targetVe = workspace.resultChildVes[selectedRow];
    if (targetVe) {
      store.history.setFocus(VeFns.veToPath(targetVe));
    }
    arrangeNow(store, "key-search-row-to-item");
    return true;
  }

  if (focusedRow < 0) { return false; }
  store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
  store.history.setFocus(workspace.searchVePath);
  arrangeNow(store, "key-search-item-to-row");
  return true;
}

function handleSearchWorkspaceEnterMaybe(store: StoreContextModel): boolean {
  const workspace = getActiveSearchWorkspace(store);
  if (!workspace) { return false; }

  const focusedRow = getEffectiveFocusedSearchResultIndex(store, workspace);
  if (focusedRow >= 0) {
    const focusedVe = workspace.resultChildVes[focusedRow];
    if (!focusedVe) { return true; }
    const boundsPx = VeFns.veBoundsRelativeToDesktopPx(store, focusedVe);
    ItemFns.handleOpenPopupClick(focusedVe, store, false, {
      x: boundsPx.x + boundsPx.w / 2,
      y: boundsPx.y + boundsPx.h / 2,
    });
    return true;
  }

  const selectedRow = clampSearchResultIndex(
    store.perItem.getSearchSelectedResultIndex(workspace.searchItemId),
    workspace.resultsCount,
  );
  if (selectedRow < 0 && store.history.getFocusPathMaybe() == workspace.searchVePath) {
    store.overlay.autoFocusSearchInput.set(true);
    arrangeNow(store, "key-search-enter-edit");
    return true;
  }
  if (selectedRow < 0) { return false; }

  const resultItemId = workspace.results[selectedRow]?.path[workspace.results[selectedRow].path.length - 1]?.id;
  if (resultItemId) {
    void navigateToContainingPageOfItem(store, resultItemId);
  }
  return true;
}

function handleSearchWorkspaceEscapeMaybe(store: StoreContextModel): boolean {
  const workspace = getActiveSearchWorkspace(store);
  if (!workspace) { return false; }

  const selectedRow = clampSearchResultIndex(
    store.perItem.getSearchSelectedResultIndex(workspace.searchItemId),
    workspace.resultsCount,
  );
  const focusedRow = getEffectiveFocusedSearchResultIndex(store, workspace);
  if (focusedRow < 0 && selectedRow < 0) { return false; }

  store.perItem.setSearchSelectedResultIndex(workspace.searchItemId, -1);
  store.perItem.setSearchFocusedResultIndex(workspace.searchItemId, -1);
  store.history.setFocus(workspace.searchVePath);
  arrangeNow(store, "key-search-clear-selection");
  return true;
}


/**
 * Top level handler for keydown events.
 */
export function keyDownHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  if (isShiftKey(ev.code)) {
    beginShiftNavigationGesture(ev);
    return;
  }

  cancelShiftNavigationGesture();

  // Item-local editors may already have handled this key (for example Escape to
  // exit edit mode while preserving item focus). In that case, don't let the
  // document-level handler reinterpret the same key as navigation.
  if (ev.defaultPrevented) { return; }

  // IMPORTANT: keep these in sync with the code below.

  const recognizedKeys = [
    "Slash", "Backslash", "Escape", "Enter", "Space", "F2",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "KeyN", "KeyP", "KeyT", "KeyR", "KeyW", "KeyL", "KeyE", "KeyF",
  ];

  if (document.activeElement!.id.includes('toolbarTitleDiv')) {
    if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.isContentEditable) {
      return;
    }
    const focusItem = store.history.getFocusItem();
    if (!itemCanEdit(focusItem)) {
      return;
    }
    const titleText = (document.activeElement! as HTMLElement).innerText;
    if (ev.code == "Enter" || ev.code == "Escape") {
      (document.activeElement! as HTMLElement).blur();
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      asPageItem(focusItem).title = titleText;
      if (focusItem.relationshipToParent == RelationshipToParent.Child) {
        const parentItem = itemState.get(focusItem.parentId);
        if (parentItem && isTable(parentItem) && asTableItem(parentItem).orderChildrenBy != "") {
          itemState.sortChildren(focusItem.parentId);
        }
      }
      arrangeNow(store, "key-toolbar-title-commit");
      serverOrRemote.updateItem(focusItem, store.general.networkStatus);
      ev.preventDefault();
    }
    return;
  }

  if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
    if (ev.code == "Escape") {
      ev.preventDefault();
      store.overlay.setTextEditInfo(store.history, null, true);
      arrangeNow(store, "key-escape-cancel-edit");
      return;
    }

    // TODO (HIGH)
    // event is fired before content is updated.
    return;
  }

  if (ev.code == "Tab" && handleSearchWorkspaceTabMaybe(store, ev)) {
    ev.preventDefault();
    return;
  }

  if (isArrowKey(ev.code) && handleSearchWorkspaceArrowMaybe(store, ev)) {
    ev.preventDefault();
    return;
  }

  if (ev.code == "Enter" && handleSearchWorkspaceEnterMaybe(store)) {
    ev.preventDefault();
    return;
  }

  // input box is in toolbar.
  if (isLink(store.history.getFocusItem())) { return; }

  if (store.overlay.anOverlayIsVisible()) { return; }

  if (!recognizedKeys.find(a => a == ev.code)) { return; }

  const hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);

  if (ev.code == "Slash") {
    ev.preventDefault();
    store.overlay.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(store), hitInfo });
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
  }

  else if (ev.code == "Backslash") {
    return;
  }

  else if (ev.code == "Escape") {
    ev.preventDefault();
    // Exit text edit mode while keeping focus on the item
    if (store.overlay.textEditInfo()) {
      store.overlay.setTextEditInfo(store.history, null, true);
      arrangeNow(store, "key-escape-exit-edit");
      return;
    }
    if (handleSearchWorkspaceEscapeMaybe(store)) {
      return;
    }
    const popupSpec = store.history.currentPopupSpec();
    if (popupSpec) {
      const hasPopupParent = store.history.hasPopupParent();
      store.history.popPopup();
      // Escape should keep focus on the item whose popup was closed. Right click
      // uses its own back/up path and can still move focus elsewhere.
      if (!hasPopupParent && popupSpec.vePath) {
        store.history.setFocus(popupSpec.vePath);
      }
      const topRootVes = VesCache.render.getChildren(VeFns.veToPath(store.umbrellaVisualElement.get()))()[0];
      VesCache.mutate.clearPopup(VeFns.veToPath(topRootVes.get()));
      topRootVes.set(topRootVes.get());
      arrangeNow(store, "key-escape-close-popup");
      return;
    }

    const focusPath = store.history.getFocusPathMaybe();
    const focusVe = focusPath ? VesCache.current.readNode(focusPath) : null;
    if (focusVe && veFlagIsRoot(focusVe.flags)) {
      void mouseDownHandler(store, MOUSE_RIGHT);
      return;
    }

    focusParentMaybe(store);
  }

  else if (isArrowKey(ev.code)) {
    arrowKeyHandler(store, ev);
  }

  else if (ev.code == "Enter") {
    if (ev.metaKey) {
      if (!store.dockVisible.get() && !store.topToolbarVisible.get()) {
        store.dockVisible.set(true);
        store.topToolbarVisible.set(true);
      } else {
        store.dockVisible.set(false);
        store.topToolbarVisible.set(false);
      }
      arrangeNow(store, "key-toggle-dock-toolbar");
      return;
    }

    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe && !store.overlay.textEditInfo()) {
      if (isPage(focusVe.displayItem) &&
        !!(asPageItem(focusVe.displayItem).flags & PageFlags.EmbeddedInteractive) &&
        ev.shiftKey) {
        ev.preventDefault();
        switchToPage(store, VeFns.actualVeidFromVe(focusVe), true, false, false);
        return;
      }

      if (handleFocusedListPageArrowRightMaybe(store)) {
        ev.preventDefault();
        return;
      }

      if (openPopupForFocusedItemMaybe(store, focusVe, false)) {
        ev.preventDefault();
        return;
      }

      if (!isPage(focusVe.displayItem) && focusFirstChildMaybe(store, focusPath, focusVe)) {
        ev.preventDefault();
        return;
      }

      if (isPage(focusVe.displayItem)) {
        const pageItem = asPageItem(focusVe.displayItem);
        if ((veFlagIsRoot(focusVe.flags) || !!(pageItem.flags & PageFlags.EmbeddedInteractive)) &&
          focusFirstChildMaybe(store, focusPath, focusVe)) {
          ev.preventDefault();
          return;
        }
      }
    }

    // If an opaque/translucent page has focus (no popup showing), open the popup
    if (focusVe && isPage(focusVe.displayItem) && !store.history.currentPopupSpec()) {
      const pageItem = asPageItem(focusVe.displayItem);
      if (!(pageItem.flags & PageFlags.EmbeddedInteractive)) {
        ev.preventDefault();
        if (!veFlagIsRoot(focusVe.flags)) {
          // Non-root page: open popup
          PageFns.handleOpenPopupClick(focusVe, store, false);
          return;
        }
      }
    }

    const spec = store.history.currentPopupSpec();
    if (spec && itemState.get(spec.actualVeid.itemId)!.itemType == ItemType.Page) {
      switchToPage(store, store.history.currentPopupSpec()!.actualVeid, true, false, false);
    }
  }

  else if (ev.code == "Space") {
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe && !store.overlay.textEditInfo() && openPopupForFocusedItemMaybe(store, focusVe, true)) {
      ev.preventDefault();
      return;
    }
  }

  else if (ev.code == "F2") {
    ev.preventDefault();
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe) {
      editFocusedItemMaybe(store, focusVe);
    }
  }

  else if (ev.code == "KeyN") {
    ev.preventDefault();
    newItemInContext(store, "note", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyP") {
    ev.preventDefault();
    newItemInContext(store, "page", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyT") {
    ev.preventDefault();
    newItemInContext(store, "table", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyR") {
    ev.preventDefault();
    newItemInContext(store, "rating", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyW") {
    ev.preventDefault();
    newItemInContext(store, "password", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyL") {
    ev.preventDefault();
    newItemInContext(store, "link", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyE") {
    ev.preventDefault();
    return;
  }

  else if (ev.code == "KeyF") {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      if (ev.shiftKey) {
        void navigateToSearches(store);
      } else {
        store.overlay.findOverlayVisible.set(true);
      }
    }
    return;
  }

  else {
    panic(`Unexpected key code: ${ev.code}`);
  }
}

function focusParentMaybe(store: StoreContextModel): boolean {
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath);
  if (!focusVe) { return false; }

  const parentPath = VeFns.parentPath(focusPath);
  if (!parentPath || parentPath === UMBRELLA_PAGE_UID || parentPath === "") { return false; }

  if (focusVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
    store.history.setFocus(parentPath);
    arrangeNow(store, "key-focus-parent-embedded-interactive");
    return true;
  }

  if (veFlagIsRoot(focusVe.flags)) { return false; }

  store.history.setFocus(parentPath);
  arrangeNow(store, "key-focus-parent");
  return true;
}

function focusFirstChildMaybe(store: StoreContextModel, focusPath: string, focusVe: VisualElement): boolean {
  const focusItem = focusVe.displayItem;

  if (isPage(focusItem)) {
    const pageItem = asPageItem(focusItem);
    if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.List) {
      const pageVeid = VeFns.actualVeidFromVe(focusVe);
      PageFns.setDefaultListPageSelectedItemMaybe(store, pageVeid);
      let selectedVeid = store.perItem.getSelectedListPageItem(pageVeid);
      if (selectedVeid == EMPTY_VEID && pageItem.computed_children.length > 0) {
        selectedVeid = VeFns.veidFromId(pageItem.computed_children[0]);
      }
      if (selectedVeid != EMPTY_VEID && selectedVeid.itemId !== "") {
        store.history.setFocus(VeFns.addVeidToPath(selectedVeid, focusPath));
        arrangeNow(store, "key-enter-focus-list-child");
        return true;
      }
      return false;
    }

    if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const topLeftChild = VesCache.current.readIndexedChildren(focusPath)
        .filter(child =>
          !!child.boundsPx &&
          !(child.flags & VisualElementFlags.Attachment) &&
          !(child.flags & VisualElementFlags.Popup) &&
          !(child.flags & VisualElementFlags.LineItem))
        .sort((a, b) => {
          const aDistanceSq = a.boundsPx!.x * a.boundsPx!.x + a.boundsPx!.y * a.boundsPx!.y;
          const bDistanceSq = b.boundsPx!.x * b.boundsPx!.x + b.boundsPx!.y * b.boundsPx!.y;
          if (aDistanceSq !== bDistanceSq) { return aDistanceSq - bDistanceSq; }
          if (a.boundsPx!.y !== b.boundsPx!.y) { return a.boundsPx!.y - b.boundsPx!.y; }
          if (a.boundsPx!.x !== b.boundsPx!.x) { return a.boundsPx!.x - b.boundsPx!.x; }
          return VeFns.veToPath(a).localeCompare(VeFns.veToPath(b));
        })[0];

      if (topLeftChild) {
        store.history.setFocus(VeFns.veToPath(topLeftChild));
        arrangeNow(store, "key-enter-focus-spatial-top-left-child");
        return true;
      }
      return false;
    }

    if (pageItem.computed_children.length > 0) {
      store.history.setFocus(VeFns.addVeidToPath(VeFns.veidFromId(pageItem.computed_children[0]), focusPath));
      arrangeNow(store, "key-enter-focus-page-child");
      return true;
    }
    return false;
  }

  if (isTable(focusItem) || isComposite(focusItem)) {
    const containerItem = asContainerItem(focusItem);
    if (containerItem.computed_children.length > 0) {
      store.history.setFocus(VeFns.addVeidToPath(VeFns.veidFromId(containerItem.computed_children[0]), focusPath));
      arrangeNow(store, "key-enter-focus-container-child");
      return true;
    }
  }

  return false;
}

function handleFocusedListPageArrowRightMaybe(store: StoreContextModel): boolean {
  const focusPagePath = store.history.getFocusPath();
  const focusPageVe = VesCache.current.readNode(focusPagePath);
  if (!focusPageVe || !isPage(focusPageVe.displayItem) || !veFlagIsRoot(focusPageVe.flags)) {
    return false;
  }

  const focusPage = asPageItem(focusPageVe.displayItem);
  if (focusPage.arrangeAlgorithm != ArrangeAlgorithm.List) {
    return false;
  }

  const focusPageVeid = VeFns.veidFromVe(focusPageVe);
  const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
  const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
  const selectedItem = itemState.get(selectedVeid.itemId);
  if (selectedItem && isSearch(selectedItem)) {
    const selectedVeSignal = VesCache.render.getSelected(focusPagePath)();
    const selectedVe = selectedVeSignal?.get() ?? null;
    if (selectedVe) {
      store.perItem.setSearchFocusedResultIndex(selectedItem.id, -1);
      store.overlay.autoFocusSearchInput.set(false);
      store.history.setFocus(VeFns.veToPath(selectedVe));
      arrangeNow(store, "key-list-page-focus-search");
    }
    return true;
  }
  if (!isPage(selectedItem)) {
    return true;
  }

  const ttpVePaths = store.topTitledPages.get();
  const ttpVeids = [];
  for (let i = 0; i < ttpVePaths.length; ++i) { ttpVeids.push(VeFns.veidFromPath(ttpVePaths[i])); }
  for (let i = 0; i < ttpVeids.length; ++i) {
    const veid = ttpVeids[i];
    if (veid.itemId == focusPageVeid.itemId &&
      veid.linkIdMaybe == focusPageVeid.linkIdMaybe) {
      const nextIdx = i + 1;
      if (nextIdx < ttpVeids.length) {
        const nextFocusVeid = ttpVeids[nextIdx];
        const nextFocusPath = VeFns.addVeidToPath(nextFocusVeid, focusPagePath);
        store.history.setFocus(nextFocusPath);

        {
          const nextFocusPagePath = store.history.getFocusPath();
          const nextFocusPageVe = VesCache.current.readNode(nextFocusPagePath)!;
          const nextFocusPageActualVeid = VeFns.veidFromItems(nextFocusPageVe.displayItem, nextFocusPageVe.actualLinkItemMaybe);
          const nextSelectedVeid = store.perItem.getSelectedListPageItem(nextFocusPageActualVeid);
          if (nextSelectedVeid == EMPTY_VEID) {
            PageFns.setDefaultListPageSelectedItemMaybe(store, nextFocusPageActualVeid);
          }
        }

        arrangeNow(store, "key-list-page-focus-child-page");
      }
    }
  }

  return true;
}

function openPopupForFocusedItemMaybe(store: StoreContextModel, focusVe: VisualElement, includeTables: boolean): boolean {
  const openUsingPopupHotspot = () => {
    const boundsPx = VeFns.veBoundsRelativeToDesktopPx(store, focusVe);
    const hotspotWidthPx = Math.min(focusVe.blockSizePx?.w ?? focusVe.boundsPx.w, boundsPx.w);
    const hotspotHeightPx = Math.min(focusVe.blockSizePx?.h ?? focusVe.boundsPx.h, boundsPx.h);
    ItemFns.handleOpenPopupClick(focusVe, store, false, {
      x: boundsPx.x + hotspotWidthPx / 2,
      y: boundsPx.y + hotspotHeightPx / 2,
    });
  };

  if (isNote(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (isFile(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (isPassword(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (includeTables && isTable(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  return false;
}

function editFocusedItemMaybe(store: StoreContextModel, focusVe: VisualElement): boolean {
  if (isPage(focusVe.displayItem)) {
    PageFns.handleEditTitleClick(focusVe, store);
    return true;
  }
  if (isTable(focusVe.displayItem)) {
    TableFns.handleClick(focusVe, null, store, true);
    return true;
  }
  if (isNote(focusVe.displayItem)) {
    NoteFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isFile(focusVe.displayItem)) {
    FileFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isPassword(focusVe.displayItem)) {
    PasswordFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isImage(focusVe.displayItem)) {
    ImageFns.handleEditClick(focusVe, store);
    return true;
  }
  return false;
}

function getTableHorizontalNavigationTarget(currentPath: string, direction: FindDirection): string | null {
  if (direction != FindDirection.Left && direction != FindDirection.Right) { return null; }

  const currentVe = VesCache.current.readNode(currentPath);
  if (!currentVe || !(currentVe.flags & VisualElementFlags.InsideTable)) { return null; }

  const isAttachment = !!(currentVe.flags & VisualElementFlags.Attachment);
  const currentCol = currentVe.col;
  if (currentCol == null) { return null; }

  if (!isAttachment && currentCol === 0 && direction === FindDirection.Right) {
    const rowAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(currentVe));
    for (const attachmentVe of rowAttachmentsVes) {
      if (attachmentVe.col === 1) {
        return VeFns.veToPath(attachmentVe);
      }
    }
    return null;
  }

  if (!isAttachment || !currentVe.parentPath) { return null; }

  const rowVe = VesCache.current.readNode(currentVe.parentPath);
  if (!rowVe) { return null; }

  if (direction === FindDirection.Left) {
    if (currentCol === 1) {
      return VeFns.veToPath(rowVe);
    }

    if (currentCol > 1) {
      const rowAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(rowVe));
      for (const attachmentVe of rowAttachmentsVes) {
        if (attachmentVe.col === currentCol - 1) {
          return VeFns.veToPath(attachmentVe);
        }
      }
    }

    return null;
  }

  const rowAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(rowVe));
  for (const attachmentVe of rowAttachmentsVes) {
    if (attachmentVe.col === currentCol + 1) {
      return VeFns.veToPath(attachmentVe);
    }
  }

  return null;
}

function handleTableItemFocusHorizontalNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  const targetPath = getTableHorizontalNavigationTarget(currentPath, direction);
  if (!targetPath) { return false; }

  store.history.setFocus(targetPath);
  arrangeNow(store, "key-table-focus-horizontal-nav");
  return true;
}

export async function keyUpHandler(store: StoreContextModel, ev: KeyboardEvent): Promise<void> {
  if (!isShiftKey(ev.code)) { return; }
  if (ev.shiftKey) { return; }
  if (!consumeShiftNavigationGesture()) { return; }

  ev.preventDefault();
  await mouseDownHandler(store, MOUSE_RIGHT);
}


/**
 * Handler for arrow key down events.
 */
function arrowKeyHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  ev.preventDefault(); // TODO (MEDIUM): allow default in some circumstances where it is appropriate for a table to scroll.

  // When a translucent page has focus, skip list page selection and grid/justified scroll handling.
  // Arrow keys should apply to the parent context (navigating to sibling items) instead.
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath);
  const focusedPageIsRoot = !!focusVe && isPage(focusVe.displayItem) && veFlagIsRoot(focusVe.flags);

  if (focusedPageIsRoot && handleArrowKeyCalendarPageMaybe(store, ev)) { return; }
  if (focusedPageIsRoot && handleArrowKeyListPageChangeMaybe(store, ev)) { return; }
  if (focusedPageIsRoot && handleArrowKeyGridOrJustifiedPageScrollMaybe(store, ev)) { return; }

  // Handle arrow keys when an item (including pages) has focus but no popup
  // This enables navigation from a focused (non-editable) item
  if (!store.history.currentPopupSpec()) {
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe) {
      // Navigate to closest item from current focus
      const direction = findDirectionFromKeyCode(ev.code);
      if (handleVirtualizedTableVerticalNavigationMaybe(store, focusPath, focusVe, direction)) { return; }
      if (handleTableItemFocusHorizontalNavigation(store, focusPath, direction)) { return; }
      const closest = findClosest(VesCache.current, focusPath, direction, true);
      if (closest != null) {
        // Just set focus to the new item - don't pop up pages
        store.history.setFocus(closest);
        arrangeNow(store, "key-arrow-focus-closest");
        return;
      }
      // If no visible sibling found and focus is on a page, try navigating in parent container
      if (isPage(focusVe.displayItem)) {
        const currentPageVeid = store.history.currentPageVeid();
        if (!currentPageVeid) return;

        // Strategy 1: Use navigation history if available (works for tables and normal navigation)
        const historyParentVeid = store.history.peekPrevPageVeid();
        if (historyParentVeid) {
          arrangeVirtual(store, historyParentVeid, "key-arrow-nav-parent-history");
          const parentFocusPath = store.history.getParentPageFocusPath();
          // Check if the path exists in the virtual cache (it might not if it includes a link ID from a popup)
          if (parentFocusPath && VesCache.virtual.readNode(parentFocusPath)) {
            const closestInParent = findClosest(VesCache.virtual, parentFocusPath, direction, false);
            if (closestInParent) {
              const closestVe = VesCache.virtual.readNode(closestInParent);
              if (closestVe && isPage(closestVe.displayItem)) {
                store.history.changeParentPageFocusPath(closestInParent);
                switchToPage(store, VeFns.veidFromPath(closestInParent), true, false, true);
                return;
              }
            }
          }
        }

        // Strategy 2: Use item hierarchy if history doesn't have a parent (works for popup entry)
        const currentPageItem = itemState.get(currentPageVeid.itemId);
        if (currentPageItem && currentPageItem.parentId) {
          // Find the actual parent page (might need to traverse up through tables, etc.)
          let parentId = currentPageItem.parentId;
          let parentItem = itemState.get(parentId);
          while (parentItem && !isPage(parentItem)) {
            parentId = parentItem.parentId;
            parentItem = parentId ? itemState.get(parentId) : null;
          }
          if (parentItem && isPage(parentItem)) {
            const parentVeid = { itemId: parentId, linkIdMaybe: null };
            arrangeVirtual(store, parentVeid, "key-arrow-nav-parent-hierarchy");
            // Find the current page's path in the virtual cache (handles tables and other containers)
            const virtualVesList = VesCache.virtual.findNodes(currentPageVeid);
            if (virtualVesList.length > 0) {
              const virtualVe = virtualVesList[0];
              const currentPagePath = VeFns.veToPath(virtualVe);
              const closestInParent = findClosest(VesCache.virtual, currentPagePath, direction, false);
              if (closestInParent) {
                const closestVe = VesCache.virtual.readNode(closestInParent);
                if (closestVe && isPage(closestVe.displayItem)) {
                  switchToPage(store, VeFns.veidFromPath(closestInParent), true, false, true);
                  return;
                }
              }

              // Strategy 3: Table attachment navigation (when findClosest failed)
              // If this is a table attachment, navigate up/down to attachments in other rows
              if ((virtualVe.flags & VisualElementFlags.InsideTable) &&
                (virtualVe.flags & VisualElementFlags.Attachment) &&
                virtualVe.col != null && virtualVe.row != null && virtualVe.parentPath) {
                if (direction == FindDirection.Up || direction == FindDirection.Down) {
                  // Navigate between attachments in different table rows
                  const rowVe = VesCache.virtual.readNode(virtualVe.parentPath);
                  if (rowVe && rowVe.parentPath) {
                    const tableVe = VesCache.virtual.readNode(rowVe.parentPath);
                    if (tableVe) {
                      // Get sibling rows (other rows in the table)
                      const siblingRows = VesCache.virtual.readSiblings(virtualVe.parentPath);

                      let targetPath: string | null = null;
                      let targetRow: number | null = null;
                      const columnIndex = virtualVe.col;
                      const currentRow = virtualVe.row;

                      for (const rowVe of siblingRows) {
                        if (rowVe.row == null) continue;

                        const childRow = rowVe.row;
                        let rowIsCandidate = false;

                        if (direction == FindDirection.Up) {
                          rowIsCandidate = childRow < currentRow && (targetRow == null || childRow > targetRow);
                        } else {
                          rowIsCandidate = childRow > currentRow && (targetRow == null || childRow < targetRow);
                        }

                        if (!rowIsCandidate) continue;

                        // Find attachments of this row using virtual indexed children.
                        const rowPath = VeFns.veToPath(rowVe);
                        const rowChildren = VesCache.virtual.readIndexedChildren(rowPath);
                        for (const attVe of rowChildren) {
                          if ((attVe.flags & VisualElementFlags.Attachment) && attVe.col === columnIndex) {
                            // Only consider pages
                            if (isPage(attVe.displayItem)) {
                              targetPath = VeFns.veToPath(attVe);
                              targetRow = childRow;
                              break;
                            }
                          }
                        }
                      }

                      if (targetPath) {
                        const targetVeid = VeFns.veidFromPath(targetPath);
                        switchToPage(store, targetVeid, true, false, true);
                        return;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return;
  }

  const currentPopupSpec = store.history.currentPopupSpec()!;
  const path = currentPopupSpec.vePath;
  if (path == null) { return; }
  const direction = findDirectionFromKeyCode(ev.code);
  if (handleTableAttachmentPopupNavigation(store, path, direction)) { return; }
  if (handleTableItemPopupHorizontalNavigation(store, path, direction)) { return; }
  // Handle scrolling of grid/justified page that contains the popup.
  // If at max scroll, this returns false and we continue to page switching logic.
  if (handlePopupGridOrJustifiedPageScrollMaybe(store, path, ev)) { return; }
  const closest = findClosest(VesCache.current, path, direction, true)!;
  if (closest != null) {
    const closestVeid = VeFns.veidFromPath(closest);
    const closestItem = itemState.get(closestVeid.itemId);
    if (!closestItem) { return; }

    // Check if destination item is a page/image (should become popup)
    const isPageOrImage = isPage(closestItem) || isImage(closestItem);
    // Check if destination item is actually an attachment (should become popup)
    const isActualAttachment = closestItem.relationshipToParent === RelationshipToParent.Attachment;

    if (isPageOrImage || isActualAttachment) {
      // Page/image or attachment items: use popup mechanism
      let sourceTopLeftGr: { x: number, y: number } | undefined = undefined;
      // Only calculate sourceTopLeftGr for non-page/non-image attachments
      // Pages and images have their own popup positioning (popupPositionGr) and should not use attachment positioning
      if (isActualAttachment && !isPageOrImage) {
        // Anchor popup placement to the item's top-left, not the exact click/hotspot position.
        const ve = VesCache.current.readNode(closest);
        if (ve) {
          const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, ve);
          const itemTopLeftPx = {
            x: veBoundsPx.x,
            y: veBoundsPx.y,
          };

          sourceTopLeftGr = VeFns.desktopPxToPopupTopLeftAnchorGr(store, itemTopLeftPx) ?? undefined;

          if (!sourceTopLeftGr) {
            // Fallback to the nearest page ancestor if the current-page VE is temporarily unavailable.
            const parentPath = VeFns.parentPath(closest);
            if (parentPath) {
              let pageVe = VesCache.current.readNode(parentPath);
              while (pageVe && !isPage(pageVe.displayItem)) {
                if (!pageVe.parentPath) { break; }
                pageVe = VesCache.current.readNode(pageVe.parentPath);
              }
              if (pageVe && isPage(pageVe.displayItem)) {
                sourceTopLeftGr = VeFns.desktopPxToPopupTopLeftAnchorGr(store, itemTopLeftPx, pageVe) ?? undefined;
              }
            }
          }
        }
      }

      // Only set isFromAttachment for non-page/non-image attachments
      // Pages and images should use their own popup positioning logic (popupPositionGr, etc.)
      const treatAsAttachment = isActualAttachment && !isPageOrImage;

      store.history.replacePopup({
        vePath: closest,
        actualVeid: closestVeid,
        isFromAttachment: treatAsAttachment ? true : undefined,
        sourceTopLeftGr,
      });
      arrangeNow(store, "key-arrow-replace-popup");
    } else {
      // Non-attachment child items: just set focus, pop the popup
      store.history.popPopup();
      store.history.setFocus(closest);
      arrangeNow(store, "key-arrow-close-popup-focus-item");
    }
  } else {
    // for grid and justified pages, use ordering to wrap around to next or prev line.
    if (direction == FindDirection.Left || direction == FindDirection.Right) {
      const parentPath = VeFns.parentPath(path);
      const parentVe = parentPath ? VesCache.current.readNode(parentPath) : null;
      if (!parentVe) { return; }
      const parentItem = parentVe.displayItem;
      if (isPage(parentItem)) {
        const arrangeAlgorithm = asPageItem(parentItem).arrangeAlgorithm;
        if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
          const itemVeid = VeFns.veidFromPath(path);
          const childId = itemVeid.linkIdMaybe ? itemVeid.linkIdMaybe : itemVeid.itemId;
          const pageChildren = asContainerItem(parentItem).computed_children;
          let idx = pageChildren.indexOf(childId);
          if (direction == FindDirection.Left) {
            if (idx <= 0) { return; }
            idx = idx - 1;
          }
          if (direction == FindDirection.Right) {
            if (idx >= pageChildren.length - 1) { return; }
            idx = idx + 1;
          }
          const newChildId = pageChildren[idx];
          let newChildVeid = VeFns.veidFromId(newChildId);
          const newPath = VeFns.addVeidToPath(newChildVeid, parentPath);
          store.history.replacePopup({
            vePath: newPath,
            actualVeid: newChildVeid,
          });
          arrangeNow(store, "key-arrow-replace-grid-popup");
        }
      }
    }
  }
}

function handleVirtualizedTableVerticalNavigationMaybe(
  store: StoreContextModel,
  focusPath: string,
  focusVe: VisualElement,
  direction: FindDirection
): boolean {
  if (direction != FindDirection.Up && direction != FindDirection.Down) { return false; }
  if (!(focusVe.flags & VisualElementFlags.InsideTable)) { return false; }
  if (focusVe.row == null) { return false; }

  const isAttachment = !!(focusVe.flags & VisualElementFlags.Attachment);
  const rowPath = isAttachment ? focusVe.parentPath : focusPath;
  if (!rowPath) { return false; }

  const rowVe = isAttachment ? VesCache.current.readNode(rowPath) : focusVe;
  if (!rowVe) { return false; }

  const tablePath = rowVe.parentPath;
  if (!tablePath) { return false; }

  const tableVe = VesCache.current.readNode(tablePath);
  if (!tableVe || !isTable(tableVe.displayItem) || !tableVe.blockSizePx) { return false; }

  const tableVeid = VeFns.veidFromVe(tableVe);
  const tableItem = asTableItem(tableVe.displayItem);
  const delta = direction == FindDirection.Up ? -1 : 1;

  let targetPath: string | null = null;
  let targetRow = focusVe.row;

  if (!isAttachment) {
    targetRow = focusVe.row + delta;
    if (targetRow < 0 || targetRow >= tableItem.computed_children.length) { return false; }

    const childItem = itemState.get(tableItem.computed_children[targetRow]);
    if (!childItem) { return false; }
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
    targetPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), tablePath);
  } else {
    if (focusVe.col == null || focusVe.col < 1) { return false; }
    const attachmentColPos = focusVe.col - 1;

    for (let rowIdx = focusVe.row + delta; rowIdx >= 0 && rowIdx < tableItem.computed_children.length; rowIdx += delta) {
      const childItem = itemState.get(tableItem.computed_children[rowIdx]);
      if (!childItem || !isAttachmentsItem(childItem)) { continue; }

      const attachments = asAttachmentsItem(childItem).computed_attachments;
      if (attachmentColPos >= attachments.length) { continue; }

      const { displayItem: rowDisplayItem, linkItemMaybe: rowLinkItemMaybe } = getVePropertiesForItem(store, childItem);
      const rowTargetPath = VeFns.addVeidToPath(VeFns.veidFromItems(rowDisplayItem, rowLinkItemMaybe), tablePath);

      const attachmentItem = itemState.get(attachments[attachmentColPos]);
      if (!attachmentItem) { continue; }

      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, attachmentItem);
      targetPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), rowTargetPath);
      targetRow = rowIdx;
      break;
    }
  }

  if (!targetPath) { return false; }

  const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
  const headerRowsBl = TABLE_TITLE_HEADER_HEIGHT_BL;
  const colHeaderRowsBl = (tableItem.flags & TableFlags.ShowColHeader) ? TABLE_COL_HEADER_HEIGHT_BL : 0;
  const numVisibleRows = Math.max(1, Math.floor(tableVe.boundsPx.h / tableVe.blockSizePx.h - headerRowsBl - colHeaderRowsBl));
  const firstVisibleRow = Math.floor(scrollYPos);
  const lastVisibleRow = firstVisibleRow + numVisibleRows - 1;

  let nextScrollYPos = scrollYPos;
  if (targetRow < firstVisibleRow) {
    nextScrollYPos = targetRow;
  } else if (targetRow > lastVisibleRow) {
    nextScrollYPos = targetRow - (numVisibleRows - 1);
  }

  const maxFirstVisibleRow = Math.max(0, tableItem.computed_children.length - numVisibleRows);
  nextScrollYPos = Math.max(0, Math.min(nextScrollYPos, maxFirstVisibleRow));

  if (nextScrollYPos !== scrollYPos) {
    store.perItem.setTableScrollYPos(tableVeid, nextScrollYPos);
    arrangeNow(store, "key-arrow-scroll-table-before-focus");
  }

  store.history.setFocus(targetPath);
  arrangeNow(store, "key-arrow-focus-table-virtual-row");
  return true;
}


function handleArrowKeyCalendarPageMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (store.history.currentPopupSpec()) { return false; }

  const focusItem = store.history.getFocusItem();
  if (!isPage(focusItem) || asPageItem(focusItem).arrangeAlgorithm != ArrangeAlgorithm.Calendar) {
    return false;
  }

  if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
    return true;
  }

  const focusPath = store.history.getFocusPath();
  const pageVe = VesCache.render.getNode(focusPath)?.get();
  const pageWidthPx = pageVe?.childAreaBoundsPx?.w ?? store.desktopMainAreaBoundsPx().w;
  const currentMonthIndex = store.perVe.getCalendarMonthIndex(focusPath);
  const calendarWindow = calculateCalendarWindow(pageWidthPx, currentMonthIndex);

  if (ev.code == "ArrowLeft") {
    store.perVe.setCalendarMonthIndex(focusPath, currentMonthIndex - calendarWindow.monthsPerPage);
    arrangeNow(store, "key-calendar-prev-window");
    return true;
  }

  if (ev.code == "ArrowRight") {
    store.perVe.setCalendarMonthIndex(focusPath, currentMonthIndex + calendarWindow.monthsPerPage);
    arrangeNow(store, "key-calendar-next-window");
    return true;
  }

  return false;
}


/**
 * If arrow keydown event is relevant for a focussed list page, handle it and return true, else return false.
 */
function handleArrowKeyListPageChangeMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  const focusItem = store.history.getFocusItem();

  // If the focus item is a grid or justified page, don't handle up/down arrows here.
  // Let the grid/justified scroll handler process them instead.
  if (isPage(focusItem)) {
    const focusArrangeAlgorithm = asPageItem(focusItem).arrangeAlgorithm;
    if ((focusArrangeAlgorithm == ArrangeAlgorithm.Grid || focusArrangeAlgorithm == ArrangeAlgorithm.Justified) &&
      (ev.code == "ArrowUp" || ev.code == "ArrowDown")) {
      return false;
    }
  }

  let handleListPageChange = isPage(focusItem) && asPageItem(focusItem).arrangeAlgorithm == ArrangeAlgorithm.List;
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath)!;
  const focusVeid = VeFns.veidFromVe(focusVe);
  for (let i = 1; i < store.topTitledPages.get().length; ++i) {
    const ttp = VeFns.veidFromPath(store.topTitledPages.get()[i]);
    if (ttp.itemId == focusVeid.itemId && ttp.linkIdMaybe == focusVeid.linkIdMaybe) {
      handleListPageChange = true;
      break;
    }
  }

  if (!handleListPageChange) { return false; }

  if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
    const focusPagePath = store.history.getFocusPath();
    const focusPageVe = VesCache.current.readNode(focusPagePath)!;
    const focusPageVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
    const selectedVeid = store.perItem.getSelectedListPageItem(focusPageVeid);
    if (selectedVeid == EMPTY_VEID) {
      PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageVeid);
      arrangeNow(store, "key-list-page-set-default-selection");
      return true;
    }
    const selectedItemPath = VeFns.addVeidToPath(selectedVeid, focusPagePath);
    const direction = findDirectionFromKeyCode(ev.code);
    const closest = findClosest(VesCache.current, selectedItemPath, direction, true);
    if (closest != null) {
      const closestVeid = VeFns.veidFromPath(closest);
      store.perItem.setSelectedListPageItem(focusPageVeid, closestVeid);
      arrangeNow(store, "key-list-page-move-selection");
    } else {
      // At boundary (topmost/bottommost item) - fall through to parent context navigation
      return false;
    }
  } else if (ev.code == "ArrowLeft") {
    const focusPagePath = store.history.getFocusPath();
    const newFocusPagePath = VeFns.parentPath(focusPagePath);
    if (newFocusPagePath == UMBRELLA_PAGE_UID) {
      return true;
    }
    store.history.setFocus(newFocusPagePath);
    arrangeNow(store, "key-list-page-focus-parent");
  } else if (ev.code == "ArrowRight") {
    return handleFocusedListPageArrowRightMaybe(store);
  }

  return true;
}

/**
 * If arrow keydown event is for scrolling a focussed grid or justified page, handle it and return true, else return false.
 * This works both when the grid/justified page is the root page, and when it's nested as a selected item within a list page.
 */
function handleArrowKeyGridOrJustifiedPageScrollMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (store.history.currentPopupSpec()) { return false; }
  if (ev.code != "ArrowUp" && ev.code != "ArrowDown") { return false; }

  const focusItem = store.history.getFocusItem();
  if (isPage(focusItem)) {
    const arrangeAlgorithm = asPageItem(focusItem).arrangeAlgorithm;
    if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
      const focusVe = VesCache.current.readNode(store.history.getFocusPath());
      if (focusVe && scrollGridOrJustifiedPageVe(store, focusVe, ev.code)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * If arrow keydown event is for scrolling a grid/justified page popup, handle it and return true.
 * Handles two cases:
 * 1. The popup item itself is a grid/justified page that needs scrolling
 * 2. The popup item is a child of a grid/justified page that needs scrolling
 * Returns false if scrolling was not handled (not a grid/justified page, or at max scroll bounds).
 */
function handlePopupGridOrJustifiedPageScrollMaybe(store: StoreContextModel, popupPath: string, ev: KeyboardEvent): boolean {
  if (ev.code != "ArrowUp" && ev.code != "ArrowDown") { return false; }

  // First, check if the popup item itself is a grid/justified page
  const popupVe = VesCache.current.readNode(popupPath);
  if (popupVe) {
    const popupItem = popupVe.displayItem;
    if (isPage(popupItem)) {
      const arrangeAlgorithm = asPageItem(popupItem).arrangeAlgorithm;
      if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        if (scrollGridOrJustifiedPageVe(store, popupVe, ev.code)) {
          return true;
        }
        // If scrolling returned false (at max bounds), continue to fall through to page switching
        return false;
      }
    }
  }

  // Otherwise, check if the popup's parent is a grid/justified page
  const parentPath = VeFns.parentPath(popupPath);
  if (!parentPath) { return false; }

  const parentVe = VesCache.current.readNode(parentPath);
  if (!parentVe) { return false; }

  const parentItem = parentVe.displayItem;
  if (!isPage(parentItem)) { return false; }

  const arrangeAlgorithm = asPageItem(parentItem).arrangeAlgorithm;
  if (arrangeAlgorithm != ArrangeAlgorithm.Grid && arrangeAlgorithm != ArrangeAlgorithm.Justified) {
    return false;
  }

  return scrollGridOrJustifiedPageVe(store, parentVe, ev.code);
}

/**
 * Helper function to scroll a grid or justified page given its visual element.
 * Returns true if scrolling was performed, false if already at max scroll or no scrolling needed.
 * When false is returned, arrow keys can fall through to page switching functionality.
 */
function scrollGridOrJustifiedPageVe(store: StoreContextModel, pageVe: VisualElement, keyCode: string): boolean {
  if (!pageVe.childAreaBoundsPx || !pageVe.viewportBoundsPx) { return false; }

  const contentHeight = pageVe.childAreaBoundsPx.h;
  const viewportHeight = pageVe.viewportBoundsPx.h;

  // If content fits within viewport, no scrolling needed - allow fall through to page switching
  if (contentHeight <= viewportHeight) { return false; }

  // Use the correct veid that matches how the rendering code reads scroll.
  // When the page is a selected item in a list page (ListPageRoot flag), the rendering
  // code uses getSelectedListPageItem to get the original item's veid.
  let pageVeid = VeFns.veidFromVe(pageVe);
  if (pageVe.flags & VisualElementFlags.ListPageRoot) {
    const parentVeid = VesCache.current.readNode(pageVe.parentPath!)
      ? VeFns.actualVeidFromPath(pageVe.parentPath!)
      : VeFns.veidFromPath(pageVe.parentPath!);
    pageVeid = store.perItem.getSelectedListPageItem(parentVeid);
  }

  const currentScrollProp = store.perItem.getPageScrollYProp(pageVeid);

  // If already at max scroll in the direction of the key, allow fall through to page switching
  if (keyCode == "ArrowUp" && currentScrollProp <= 0) { return false; }
  if (keyCode == "ArrowDown" && currentScrollProp >= 1) { return false; }

  const scrollableDistance = contentHeight - viewportHeight;
  const scrollStep = (viewportHeight * 0.2) / scrollableDistance;

  const newScrollProp = keyCode == "ArrowUp"
    ? Math.max(0, currentScrollProp - scrollStep)
    : Math.min(1, currentScrollProp + scrollStep);

  store.perItem.setPageScrollYProp(pageVeid, newScrollProp);
  arrangeNow(store, "key-scroll-grid-or-justified-page");

  return true;
}

/**
 * Rebuild popup anchor data so keyboard table-popup navigation matches mouse-open behavior.
 */
function buildTablePopupReplacementSpec(
  store: StoreContextModel,
  targetPath: string
): { vePath: string, actualVeid: { itemId: string, linkIdMaybe: string | null }, isFromAttachment?: boolean, sourceTopLeftGr?: { x: number, y: number } } | null {
  const targetVe = VesCache.current.readNode(targetPath);
  if (!targetVe) { return null; }

  const actualVeid = VeFns.veidFromPath(targetPath);
  const targetItem = targetVe.displayItem;
  if (isPage(targetItem) || isImage(targetItem)) {
    return { vePath: targetPath, actualVeid };
  }

  const boundsPx = VeFns.veBoundsRelativeToDesktopPx(store, targetVe);
  const itemTopLeftPx = { x: boundsPx.x, y: boundsPx.y };
  let sourceTopLeftGr = VeFns.desktopPxToPopupTopLeftAnchorGr(store, itemTopLeftPx) ?? undefined;

  if (!sourceTopLeftGr && targetVe.parentPath) {
    // Fallback to the nearest page ancestor if the current-page VE is temporarily unavailable.
    let pageVe = VesCache.current.readNode(targetVe.parentPath);
    while (pageVe && !isPage(pageVe.displayItem)) {
      if (!pageVe.parentPath) { break; }
      pageVe = VesCache.current.readNode(pageVe.parentPath);
    }
    if (pageVe && isPage(pageVe.displayItem)) {
      sourceTopLeftGr = VeFns.desktopPxToPopupTopLeftAnchorGr(store, itemTopLeftPx, pageVe) ?? undefined;
    }
  }

  return {
    vePath: targetPath,
    actualVeid,
    isFromAttachment: sourceTopLeftGr ? true : undefined,
    sourceTopLeftGr,
  };
}

/**
 * Handle up/down navigation between attachments in different table rows.
 */
function replacePopupOrFocusPlaceholder(store: StoreContextModel, targetPath: string, reason: string): boolean {
  const targetVe = VesCache.current.readNode(targetPath);
  if (!targetVe) { return false; }

  if (isPlaceholder(targetVe.displayItem)) {
    store.history.popPopup();
    store.history.setFocus(targetPath);
  } else {
    const popupSpec = buildTablePopupReplacementSpec(store, targetPath);
    if (!popupSpec) { return false; }
    store.history.replacePopup(popupSpec);
  }

  arrangeNow(store, reason);
  return true;
}

function handleTableAttachmentPopupNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  if (direction != FindDirection.Up && direction != FindDirection.Down) { return false; }

  const currentVe = VesCache.current.readNode(currentPath);
  if (!currentVe) { return false; }
  if (!(currentVe.flags & VisualElementFlags.InsideTable) || !(currentVe.flags & VisualElementFlags.Attachment)) {
    return false;
  }

  if (currentVe.col == null || currentVe.row == null || currentVe.parentPath == null) {
    return false;
  }

  const columnIndex = currentVe.col;
  const currentRow = currentVe.row;

  const rowVe = VesCache.current.readNode(currentVe.parentPath);
  if (!rowVe) { return false; }
  if (!rowVe.parentPath) { return false; }

  const tableVe = VesCache.current.readNode(rowVe.parentPath);
  if (!tableVe) { return false; }

  const childRows = VesCache.current.readIndexedChildren(VeFns.veToPath(tableVe));

  let targetPath: string | null = null;
  let targetRow: number | null = null;

  for (const childVe of childRows) {
    const atts = VesCache.current.readAttachments(VeFns.veToPath(childVe));
    if (childVe.row == null || !atts) { continue; }

    const childRow = childVe.row;
    let rowIsCandidate = false;

    if (direction == FindDirection.Up) {
      rowIsCandidate = childRow < currentRow && (targetRow == null || childRow > targetRow);
    } else {
      rowIsCandidate = childRow > currentRow && (targetRow == null || childRow < targetRow);
    }

    if (!rowIsCandidate) { continue; }

    const attachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(childVe));
    for (const attachmentVe of attachmentsVes) {
      if (!(attachmentVe.flags & VisualElementFlags.Attachment)) { continue; }
      if (attachmentVe.col != columnIndex) { continue; }

      targetPath = VeFns.veToPath(attachmentVe);
      targetRow = childRow;
      break;
    }
  }

  if (!targetPath) { return false; }

  return replacePopupOrFocusPlaceholder(store, targetPath, "key-table-attachment-popup-nav");
}

/**
 * Handle left/right navigation between table children and their attachments.
 * - On a table child (col=0), Right navigates to first attachment
 * - On an attachment (col>0), Left navigates to previous column (attachment or table child)
 * - On an attachment (col>0), Right navigates to next attachment if available
 */
function handleTableItemPopupHorizontalNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  const targetPath = getTableHorizontalNavigationTarget(currentPath, direction);
  if (!targetPath) { return false; }

  return replacePopupOrFocusPlaceholder(store, targetPath, "key-table-popup-horizontal-nav");
}
