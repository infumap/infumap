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

import { createSignal } from "solid-js";
import { VeFns, Veid, VisualElementPath } from "../layout/visual-element";
import { panic } from "../util/lang";
import { EMPTY_ITEM, Item, ItemType } from "../items/base/item";
import { itemState } from "./ItemState";
import { isUid, newUid, POPUP_LINK_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID, Uid } from "../util/uid";
import { isImage, asImageItem } from "../items/image-item";
import { isPage, asPageItem } from "../items/page-item";


export interface PopupSpec {
  actualVeid: Veid,
  vePath: VisualElementPath | null,
  restoreFocusPath?: VisualElementPath | null,
  // For attachment popups: flag indicating this popup was opened from an attachment
  isFromAttachment?: boolean,
  // For page/image attachment popups: source attachment center in parent page coordinates (Gr units)
  sourcePositionGr?: { x: number, y: number } | null,
  // For non-page attachment-style popups: desired popup top-left in current page coordinates (Gr units)
  sourceTopLeftGr?: { x: number, y: number } | null,
  // For attachment popups: pending position for movement (not persisted, cleared on popup close)
  pendingPositionGr?: { x: number, y: number } | null,
};

interface PageBreadcrumb {
  pageVeid: Veid,
  sourceItemId: Uid,
  focusPath: VisualElementPath | null,
  popupBreadcrumbs: Array<PopupSpec>,
}

interface BrowserEntryState {
  infumapHistory: {
    version: 1,
    entryId: Uid,
    position: number,
  },
}

interface BrowserEntry {
  position: number,
  breadcrumbs: Array<PageBreadcrumb>,
}

function browserEntryState(value: unknown): BrowserEntryState | null {
  if (value == null || typeof value !== "object" || !("infumapHistory" in value)) { return null; }
  const entry = value.infumapHistory;
  if (entry == null || typeof entry !== "object" ||
    !("version" in entry) || entry.version !== 1 ||
    !("entryId" in entry) || typeof entry.entryId !== "string" || !isUid(entry.entryId) ||
    !("position" in entry) || typeof entry.position !== "number" ||
    !Number.isSafeInteger(entry.position) || entry.position < 0) {
    return null;
  }
  return value as BrowserEntryState;
}

export type BrowserEntryWrite = "push" | "replace" | "restore";
export type BrowserEntryDirection = "back" | "forward" | "same";


export interface HistoryStoreContextModel {
  beginNavigationRequest: () => number,
  isNavigationRequestCurrent: (requestId: number) => boolean,
  initializeBrowserEntry: () => void,
  activateBrowserEntry: (state: unknown) => BrowserEntryDirection | null,
  restoreBrowserEntry: () => boolean,
  writeBrowserEntry: (url: string, mode: BrowserEntryWrite, hasPage?: boolean) => void,
  isCurrentBrowserEntryReady: () => boolean,
  setHistoryToSinglePage: (currentPage: Veid, focusPath?: VisualElementPath, sourceItemId?: Uid) => void,
  pushPageVeid: (veid: Veid, focusPath?: VisualElementPath, sourceItemId?: Uid) => void,
  replacePageVeid: (veid: Veid, focusPath?: VisualElementPath, sourceItemId?: Uid) => void,
  currentPageVeid: () => Veid | null,
  currentPagePath: () => string | null,
  peekPrevPageVeid: () => Veid | null,

  pushPopup: (popupSpec: PopupSpec) => void,
  replacePopup: (popupSpec: PopupSpec) => void,
  popPopup: (focusRootPage?: boolean) => void,
  popAllPopups: () => void,
  currentPopupSpec: () => PopupSpec | null,
  currentPopupSpecVeid: () => Veid | null,
  hasPopupParent: () => boolean,

  setFocus: (focusPath: VisualElementPath) => void,
  getFocusItem: () => Item,
  getFocusPath: () => VisualElementPath,
  getFocusPathMaybe: () => VisualElementPath | null,
  getFocusIsCurrentPage: () => boolean,
  getParentPageFocusPath: () => VisualElementPath | null,
  changeParentPageFocusPath: (path: VisualElementPath) => void,

  clear: () => void,

  debugLog: () => void,
}


export function makeHistoryStore(): HistoryStoreContextModel {
  const [breadcrumbs, setBreadcrumbs] = createSignal<Array<PageBreadcrumb>>([], { equals: false });
  const browserEntries = new Map<Uid, BrowserEntry>();
  let activeBrowserEntry: BrowserEntryState | null = null;
  let displayedBrowserEntryId: Uid | null = null;
  // Pending document opens use this to ignore results after another navigation starts.
  let navigationRequestId = 0;
  const beginNavigationRequest = (): number => ++navigationRequestId;
  const isNavigationRequestCurrent = (requestId: number): boolean => requestId == navigationRequestId;

  const initializeBrowserEntry = (): void => {
    activeBrowserEntry = browserEntryState(window.history.state);
    if (activeBrowserEntry == null) {
      activeBrowserEntry = { infumapHistory: { version: 1, entryId: newUid(), position: 0 } };
      window.history.replaceState(activeBrowserEntry, "");
    }
  };

  const activateBrowserEntry = (state: unknown): BrowserEntryDirection | null => {
    const previousPosition = activeBrowserEntry?.infumapHistory.position;
    activeBrowserEntry = browserEntryState(state);
    displayedBrowserEntryId = null;
    if (activeBrowserEntry == null) { return null; }
    const position = activeBrowserEntry.infumapHistory.position;
    if (previousPosition == null || position == previousPosition) { return "same"; }
    return position < previousPosition ? "back" : "forward";
  };

  const writeBrowserEntry = (url: string, mode: BrowserEntryWrite, hasPage: boolean = true): void => {
    if (mode == "push") {
      const position = activeBrowserEntry?.infumapHistory.position ?? -1;
      // A push after Back abandons the browser's Forward branch.
      for (const [id, entry] of browserEntries) {
        if (entry.position > position) { browserEntries.delete(id); }
      }
      activeBrowserEntry = { infumapHistory: { version: 1, entryId: newUid(), position: position + 1 } };
      window.history.pushState(activeBrowserEntry, "", url);
    } else {
      if (activeBrowserEntry == null) {
        if (mode == "restore") { throw new Error("Cannot restore a history entry without a valid ID."); }
        initializeBrowserEntry();
      }
      if (mode == "replace") { window.history.replaceState(activeBrowserEntry, "", url); }
    }
    const { entryId, position } = activeBrowserEntry!.infumapHistory;
    // Copy the chain, retaining each visit's mutable focus and popup context.
    // Later pushes/replacements must not change the saved chain's length.
    browserEntries.set(entryId, { position, breadcrumbs: hasPage ? breadcrumbs().slice() : [] });
    displayedBrowserEntryId = hasPage ? entryId : null;
  };

  const pathItemsAreAvailable = (path: VisualElementPath | null): boolean => {
    while (path && path != UMBRELLA_PAGE_UID) {
      const veid = VeFns.veidFromPath(path);
      if (!itemState.get(veid.itemId) ||
        (veid.linkIdMaybe && veid.linkIdMaybe != POPUP_LINK_UID && !itemState.get(veid.linkIdMaybe))) {
        return false;
      }
      path = VeFns.parentPath(path);
    }
    return true;
  };

  const restoreBrowserEntry = (): boolean => {
    const entryId = activeBrowserEntry?.infumapHistory.entryId;
    const entry = entryId == null ? null : browserEntries.get(entryId);
    const current = entry?.breadcrumbs[entry.breadcrumbs.length - 1];
    if (!entry || !current) { return false; }
    // Ancestors are used by keyboard navigation as well as the current page.
    // If they were evicted, the URL loader will rebuild a safe single-page chain.
    if (entry.breadcrumbs.some(breadcrumb =>
      !itemState.get(breadcrumb.sourceItemId) ||
      (breadcrumb.pageVeid.itemId != SOLO_ITEM_HOLDER_PAGE_UID && !isPage(itemState.get(breadcrumb.pageVeid.itemId))) ||
      (breadcrumb.pageVeid.linkIdMaybe && !itemState.get(breadcrumb.pageVeid.linkIdMaybe)))) {
      return false;
    }
    const sourceItem = itemState.get(current.sourceItemId);
    if (!sourceItem) { return false; }
    if (current.pageVeid.itemId == SOLO_ITEM_HOLDER_PAGE_UID) {
      itemState.addSoloItemHolderPage(sourceItem.ownerId);
      asPageItem(itemState.get(SOLO_ITEM_HOLDER_PAGE_UID)!).computed_children = [sourceItem.id];
    }
    if (!isPage(itemState.get(current.pageVeid.itemId)) ||
      (current.pageVeid.linkIdMaybe && !itemState.get(current.pageVeid.linkIdMaybe)) ||
      !pathItemsAreAvailable(current.focusPath) ||
      current.popupBreadcrumbs.some(popup =>
        !itemState.get(popup.actualVeid.itemId) ||
        (popup.actualVeid.linkIdMaybe && popup.actualVeid.linkIdMaybe != POPUP_LINK_UID && !itemState.get(popup.actualVeid.linkIdMaybe)) ||
        !pathItemsAreAvailable(popup.vePath))) {
      return false;
    }
    setBreadcrumbs(entry.breadcrumbs.slice());
    displayedBrowserEntryId = entryId!;
    return true;
  };

  const isCurrentBrowserEntryReady = (): boolean =>
    displayedBrowserEntryId != null && displayedBrowserEntryId == activeBrowserEntry?.infumapHistory.entryId;

  const setHistoryToSinglePage = (pageVeid: Veid, focusPath?: VisualElementPath, sourceItemId: Uid = pageVeid.itemId): void => {
    beginNavigationRequest();
    const actualFocusPath = focusPath ?? VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID);

    setBreadcrumbs([{
      pageVeid,
      sourceItemId,
      popupBreadcrumbs: [],
      focusPath: actualFocusPath
    }]);
  };

  const pushPageVeid = (pageVeid: Veid, focusPath?: VisualElementPath, sourceItemId: Uid = pageVeid.itemId): void => {
    beginNavigationRequest();
    const actualFocusPath = focusPath ?? VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID);

    breadcrumbs().push({
      pageVeid,
      sourceItemId,
      popupBreadcrumbs: [],
      focusPath: actualFocusPath
    });
    setBreadcrumbs(breadcrumbs());
  };

  const replacePageVeid = (pageVeid: Veid, focusPath?: VisualElementPath, sourceItemId: Uid = pageVeid.itemId): void => {
    beginNavigationRequest();
    const replacement = {
      pageVeid,
      sourceItemId,
      focusPath: focusPath ?? VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID),
      popupBreadcrumbs: [],
    };
    setBreadcrumbs([...breadcrumbs().slice(0, -1), replacement]);
  };

  const currentPageVeid = (): Veid | null => {
    if (breadcrumbs().length == 0) { return null; }
    return breadcrumbs()[breadcrumbs().length - 1].pageVeid;
  };

  const parentPageBreadcrumb = (): PageBreadcrumb | null => {
    if (breadcrumbs().length < 2) { return null; }
    return breadcrumbs()[breadcrumbs().length - 2];
  };

  const peekPrevPageVeid = (): Veid | null => {
    const parentBc = parentPageBreadcrumb();
    if (parentBc) { return parentBc.pageVeid; }
    return null;
  };

  const getParentPageFocusPath = (): VisualElementPath | null => {
    const parentBc = parentPageBreadcrumb();
    if (parentBc) { return parentBc.focusPath; }
    return null;
  };

  const changeParentPageFocusPath = (path: VisualElementPath) => {
    if (path && (path.startsWith("-") || path.includes("--"))) {
      console.error("MALFORMED PATH DETECTION: changeParentPageFocusPath received malformed path");
      console.error("  path:", path);
      console.error("  Stack trace:");
      console.trace();
      panic(`changeParentPageFocusPath: malformed path received: "${path}"`);
    }

    const parentBc = parentPageBreadcrumb();
    parentBc!.focusPath = path;
    setBreadcrumbs(breadcrumbs());
  };



  const pushPopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("pushPopup: no breadcrumbs."); }

    if (popupSpec.vePath && (popupSpec.vePath.startsWith("-") || popupSpec.vePath.includes("--"))) {
      console.error("MALFORMED PATH DETECTION: pushPopup received malformed vePath");
      console.error("  popupSpec:", popupSpec);
      console.error("  Stack trace:");
      console.trace();
      panic(`pushPopup: malformed vePath received: "${popupSpec.vePath}"`);
    }

    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    const popupSpecWithRestoreFocusPath: PopupSpec = {
      ...popupSpec,
      restoreFocusPath: popupSpec.restoreFocusPath ?? breadcrumb.focusPath,
    };
    breadcrumb.popupBreadcrumbs.push(popupSpecWithRestoreFocusPath);
    breadcrumb.focusPath = popupSpecWithRestoreFocusPath.vePath;
    setBreadcrumbs(breadcrumbs());
  };

  const replacePopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("replacePopup: no breadcrumbs."); }

    if (popupSpec.vePath && (popupSpec.vePath.startsWith("-") || popupSpec.vePath.includes("--"))) {
      console.error("MALFORMED PATH DETECTION: replacePopup received malformed vePath");
      console.error("  popupSpec:", popupSpec);
      console.error("  Stack trace:");
      console.trace();
      panic(`replacePopup: malformed vePath received: "${popupSpec.vePath}"`);
    }

    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    const popupSpecWithRestoreFocusPath: PopupSpec = {
      ...popupSpec,
      restoreFocusPath:
        popupSpec.restoreFocusPath ??
        breadcrumb.popupBreadcrumbs[breadcrumb.popupBreadcrumbs.length - 1]?.restoreFocusPath ??
        breadcrumb.focusPath,
    };
    breadcrumb.popupBreadcrumbs = [popupSpecWithRestoreFocusPath];
    breadcrumb.focusPath = popupSpecWithRestoreFocusPath.vePath;
    setBreadcrumbs(breadcrumbs());
  };

  const popPopup = (focusRootPage?: boolean): void => {
    if (breadcrumbs().length == 0) { panic("popPopup: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    if (breadcrumb.popupBreadcrumbs.length == 0) { return; }
    const popupSpec = breadcrumb.popupBreadcrumbs.pop();

    // Clear pending popup position fields from the popup item (not persisted changes are discarded)
    const popupItem = itemState.get(popupSpec!.actualVeid.itemId);
    if (popupItem) {
      if (isImage(popupItem)) {
        const imageItem = asImageItem(popupItem);
        imageItem.pendingPopupPositionGr = null;
        imageItem.pendingPopupWidthGr = null;
        imageItem.pendingCellPopupPositionNorm = null;
        imageItem.pendingCellPopupWidthNorm = null;
      } else if (isPage(popupItem)) {
        const pageItem = asPageItem(popupItem);
        pageItem.pendingPopupPositionGr = null;
        pageItem.pendingPopupWidthGr = null;
        pageItem.pendingCellPopupPositionNorm = null;
        pageItem.pendingCellPopupWidthNorm = null;
      }
    }

    if (focusRootPage) {
      breadcrumb.focusPath = VeFns.addVeidToPath(breadcrumb.pageVeid, UMBRELLA_PAGE_UID);
    } else if (breadcrumb.popupBreadcrumbs.length == 0) {
      if (!popupSpec!.restoreFocusPath && !popupSpec!.vePath) {
        console.error("MALFORMED PATH DETECTION: popPopup restoreFocusPath and vePath are null/undefined");
        console.error("  popupSpec:", popupSpec);
        console.error("  Stack trace:");
        console.trace();
        panic("popPopup: restoreFocusPath and vePath are null");
      }

      // Restore the focus that was active before this popup opened.
      breadcrumb.focusPath = popupSpec!.restoreFocusPath ?? popupSpec!.vePath;
    } else {
      const nextVePath = breadcrumb.popupBreadcrumbs[breadcrumb.popupBreadcrumbs.length - 1].vePath;

      if (nextVePath && (nextVePath.startsWith("-") || nextVePath.includes("--"))) {
        console.error("MALFORMED PATH DETECTION: popPopup next popup vePath is malformed");
        console.error("  nextVePath:", nextVePath);
        console.error("  breadcrumb:", breadcrumb);
        console.error("  Stack trace:");
        console.trace();
      }

      breadcrumb.focusPath = nextVePath;
    }
    setBreadcrumbs(breadcrumbs());
  };

  const popAllPopups = (): void => {
    if (breadcrumbs().length == 0) { panic("popAllPopups: no breadcrumbs."); }

    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];

    // Clear pending popup position fields from all popup items
    for (const popupSpec of breadcrumb.popupBreadcrumbs) {
      const popupItem = itemState.get(popupSpec.actualVeid.itemId);
      if (popupItem) {
        if (isImage(popupItem)) {
          const imageItem = asImageItem(popupItem);
          imageItem.pendingPopupPositionGr = null;
          imageItem.pendingPopupWidthGr = null;
          imageItem.pendingCellPopupPositionNorm = null;
          imageItem.pendingCellPopupWidthNorm = null;
        } else if (isPage(popupItem)) {
          const pageItem = asPageItem(popupItem);
          pageItem.pendingPopupPositionGr = null;
          pageItem.pendingPopupWidthGr = null;
          pageItem.pendingCellPopupPositionNorm = null;
          pageItem.pendingCellPopupWidthNorm = null;
        }
      }
    }

    const focusPath = VeFns.addVeidToPath(breadcrumb.pageVeid, UMBRELLA_PAGE_UID);

    breadcrumb.popupBreadcrumbs = [];
    breadcrumb.focusPath = focusPath;
    setBreadcrumbs(breadcrumbs());
  };

  const currentPopupSpec = (): PopupSpec | null => {
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length - 1].popupBreadcrumbs.length == 0) { return null; }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length - 1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length - 1];
  };

  const currentPopupSpecVeid = (): Veid | null => {
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length - 1].popupBreadcrumbs.length == 0) { return null; }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length - 1].popupBreadcrumbs;
    const currentSpec = lastBreadcrumbPopups[lastBreadcrumbPopups.length - 1];
    return currentSpec.actualVeid;
  };

  const hasPopupParent = (): boolean => {
    if (breadcrumbs().length == 0) { return false; }
    return breadcrumbs()[breadcrumbs().length - 1].popupBreadcrumbs.length > 1;
  };


  const setFocus = (focusPath: VisualElementPath): void => {
    if (breadcrumbs().length < 1) { panic("cannot set focus item when there is no current page."); }

    if (focusPath.startsWith("-") || focusPath === "" || focusPath.includes("--")) {
      console.error("MALFORMED PATH DETECTION: setFocus called with malformed path");
      console.error("  focusPath:", focusPath);
      console.error("  Stack trace:");
      console.trace();
      panic(`setFocus: Attempting to set malformed focus path: "${focusPath}"`);
    }

    VeFns.validatePath(focusPath);

    breadcrumbs()[breadcrumbs().length - 1].focusPath = focusPath;
    setBreadcrumbs(breadcrumbs());
  };

  const getFocusItem = (): Item => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    if (!breadcrumb) { return ((EMPTY_ITEM as any) as Item); } // happens on initialization. This is a bit of a hack, it would be better if the logic was tighter.
    if (breadcrumb.focusPath != null) {
      try {
        const veid = VeFns.veidFromPath(breadcrumb.focusPath!);
        const item = itemState.get(veid.itemId);
        if (item) { return item; }
      } catch (e) {
        console.error(e);
        panic(`getFocusItem: error parsing focus path: ${breadcrumb.focusPath}`);
      }
      panic(`getFocusItem: item not found for path: ${breadcrumb.focusPath}`);
    }
    if (currentPopupSpec() != null) {
      if (itemState.get(currentPopupSpec()!.actualVeid.itemId)!.itemType == ItemType.Page) {
        return itemState.get(currentPopupSpec()!.actualVeid.itemId)!;
      }
    }
    return itemState.get(currentPageVeid()!.itemId)!;
  };

  const getFocusPath = (): VisualElementPath => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    if (breadcrumb.focusPath != null) {
      return breadcrumb.focusPath;
    }
    panic("TODO (HIGH): focusPath fallback should never be hit");
  };

  const getFocusPathMaybe = (): VisualElementPath | null => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    if (!breadcrumb) {
      return null;
    }
    return breadcrumb.focusPath;
  };

  const getFocusIsCurrentPage = (): boolean => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
    if (!breadcrumb) {
      return true;
    }
    if (breadcrumb.focusPath != null) {
      return currentPagePath() == getFocusPath();
    }
    return true;
  };

  const currentPagePath = (): string | null => {
    if (currentPageVeid() == null) { return null; }
    return VeFns.addVeidToPath(currentPageVeid()!, UMBRELLA_PAGE_UID);
  };

  const clear = (): void => {
    beginNavigationRequest();
    browserEntries.clear();
    displayedBrowserEntryId = null;
    setBreadcrumbs([]);
  };

  const debugLog = (): void => {
    console.log(breadcrumbs());
  }


  return ({
    beginNavigationRequest,
    isNavigationRequestCurrent,
    initializeBrowserEntry,
    activateBrowserEntry,
    restoreBrowserEntry,
    writeBrowserEntry,
    isCurrentBrowserEntryReady,
    setHistoryToSinglePage,
    pushPageVeid,
    replacePageVeid,
    currentPageVeid,
    currentPagePath,
    peekPrevPageVeid,

    pushPopup,
    replacePopup,
    popPopup,
    popAllPopups,
    currentPopupSpec,
    currentPopupSpecVeid,
    hasPopupParent,

    setFocus,
    getFocusItem,
    getFocusPath,
    getFocusPathMaybe,
    getFocusIsCurrentPage,
    getParentPageFocusPath,
    changeParentPageFocusPath,

    clear,
    debugLog,
  });
}
