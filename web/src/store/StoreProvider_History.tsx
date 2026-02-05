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
import { UMBRELLA_PAGE_UID } from "../util/uid";
import { isImage, asImageItem } from "../items/image-item";
import { isPage, asPageItem } from "../items/page-item";
import { isTable } from "../items/table-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";


export interface PopupSpec {
  actualVeid: Veid,
  vePath: VisualElementPath | null,
  // For attachment popups: flag indicating this popup was opened from an attachment
  isFromAttachment?: boolean,
  // For attachment popups: source attachment position in parent page coordinates (Gr units)
  sourcePositionGr?: { x: number, y: number } | null,
  // For attachment popups: pending position for movement (not persisted, cleared on popup close)
  pendingPositionGr?: { x: number, y: number } | null,
};

interface PageBreadcrumb {
  pageVeid: Veid,
  focusPath: VisualElementPath | null,
  popupBreadcrumbs: Array<PopupSpec>,
}


export interface HistoryStoreContextModel {
  setHistoryToSinglePage: (currentPage: Veid, focusPath?: VisualElementPath) => void,
  pushPageVeid: (veid: Veid, focusPath?: VisualElementPath) => void,
  popPageVeid: () => boolean,
  currentPageVeid: () => Veid | null,
  currentPagePath: () => string | null,
  peekPrevPageVeid: () => Veid | null,

  pushPopup: (popupSpec: PopupSpec) => void,
  replacePopup: (popupSpec: PopupSpec) => void,
  popPopup: () => void,
  popAllPopups: () => void,
  currentPopupSpec: () => PopupSpec | null,
  currentPopupSpecVeid: () => Veid | null,

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

  const setHistoryToSinglePage = (pageVeid: Veid, focusPath?: VisualElementPath): void => {
    const actualFocusPath = focusPath ?? VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID);

    setBreadcrumbs([{
      pageVeid,
      parentPageChanged: true,
      popupBreadcrumbs: [],
      focusPath: actualFocusPath
    }]);
  };

  const pushPageVeid = (pageVeid: Veid, focusPath?: VisualElementPath): void => {
    const actualFocusPath = focusPath ?? VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID);

    breadcrumbs().push({
      pageVeid,
      popupBreadcrumbs: [],
      focusPath: actualFocusPath
    });
    setBreadcrumbs(breadcrumbs());
  };

  const popPageVeid = (): boolean => {
    if (breadcrumbs().length <= 1) { return false; }
    breadcrumbs().pop();
    setBreadcrumbs(breadcrumbs());
    return true;
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
    breadcrumb.popupBreadcrumbs.push(popupSpec);
    breadcrumb.focusPath = popupSpec.vePath;
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
    breadcrumb.popupBreadcrumbs = [popupSpec];
    breadcrumb.focusPath = popupSpec.vePath;
    setBreadcrumbs(breadcrumbs());
  };

  const popPopup = (): void => {
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

    if (breadcrumb.popupBreadcrumbs.length == 0) {
      if (!popupSpec!.vePath) {
        console.error("MALFORMED PATH DETECTION: popPopup vePath is null/undefined");
        console.error("  popupSpec:", popupSpec);
        console.error("  Stack trace:");
        console.trace();
        panic("popPopup: vePath is null");
      }

      // Keep focus on the page that was popped up (not its parent)
      // This ensures the page retains focus when closing its popup.
      // EXCEPTION: If the popped item is inside a Table (and is not a Page), focus the Table (parent).
      // This allows keyboard navigation to resume on the table immediately.
      let focusParent = false;
      if (popupItem) {
        if (popupSpec!.vePath) {
          const parentPath = VeFns.parentPath(popupSpec!.vePath);
          if (parentPath) {
            const parentVeid = VeFns.veidFromPath(parentPath);
            if (parentVeid.itemId) {
              const parentItem = itemState.get(parentVeid.itemId);
              if (parentItem) {
                if (isTable(parentItem)) {
                  focusParent = true;
                  breadcrumb.focusPath = parentPath;
                } else if (popupItem.relationshipToParent === RelationshipToParent.Attachment && parentItem.parentId) {
                  // Check if grandparent is a table (case for attachments in a table row)
                  const grandParentPath = VeFns.parentPath(parentPath);
                  if (grandParentPath) {
                    const grandParentVeid = VeFns.veidFromPath(grandParentPath);
                    if (grandParentVeid.itemId) {
                      const grandParentItem = itemState.get(grandParentVeid.itemId);
                      if (grandParentItem && isTable(grandParentItem)) {
                        focusParent = true;
                        breadcrumb.focusPath = grandParentPath;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (!focusParent) {
        breadcrumb.focusPath = popupSpec!.vePath;
      }
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
    return breadcrumb.focusPath;
  };

  const getFocusIsCurrentPage = (): boolean => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length - 1];
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
    setBreadcrumbs([]);
  };

  const debugLog = (): void => {
    console.log(breadcrumbs());
  }


  return ({
    setHistoryToSinglePage,
    pushPageVeid,
    popPageVeid,
    currentPageVeid,
    currentPagePath,
    peekPrevPageVeid,

    pushPopup,
    replacePopup,
    popPopup,
    popAllPopups,
    currentPopupSpec,
    currentPopupSpecVeid,

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
