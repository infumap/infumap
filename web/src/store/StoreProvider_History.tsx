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


export interface PopupSpec {
  actualVeid: Veid,
  vePath: VisualElementPath | null,
};

interface PageBreadcrumb {
  pageVeid: Veid,
  focusPath: VisualElementPath | null,
  popupBreadcrumbs: Array<PopupSpec>,
}


export interface HistoryStoreContextModel {
  setHistoryToSinglePage: (currentPage: Veid) => void,
  pushPageVeid: (veid: Veid) => void,
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

  const setHistoryToSinglePage = (pageVeid: Veid): void => {
    setBreadcrumbs([{
      pageVeid,
      parentPageChanged: true,
      popupBreadcrumbs: [],
      focusPath: VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID)
    }]);
  };

  const pushPageVeid = (pageVeid: Veid): void => {
    breadcrumbs().push({
      pageVeid,
      popupBreadcrumbs: [],
      focusPath: VeFns.addVeidToPath(pageVeid, UMBRELLA_PAGE_UID)
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
    return breadcrumbs()[breadcrumbs().length-1].pageVeid;
  };

  const parentPageBreadcrumb = (): PageBreadcrumb | null => {
    if (breadcrumbs().length < 2) { return null; }
    return breadcrumbs()[breadcrumbs().length-2];
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
    const parentBc = parentPageBreadcrumb();
    parentBc!.focusPath = path;
    setBreadcrumbs(breadcrumbs());
  };



  const pushPopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("pushPopup: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    breadcrumb.popupBreadcrumbs.push(popupSpec);
    breadcrumb.focusPath = popupSpec.vePath;
    setBreadcrumbs(breadcrumbs());
  };

  const replacePopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("replacePopup: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    breadcrumb.popupBreadcrumbs = [popupSpec];
    breadcrumb.focusPath = popupSpec.vePath;
    setBreadcrumbs(breadcrumbs());
  };

  const popPopup = (): void => {
    if (breadcrumbs().length == 0) { panic("popPopup: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    if (breadcrumb.popupBreadcrumbs.length == 0) { return; }
    const popupSpec = breadcrumb.popupBreadcrumbs.pop();
    if (breadcrumb.popupBreadcrumbs.length == 0) {
      const popupParentPath = VeFns.parentPath(popupSpec!.vePath!);
      breadcrumb.focusPath = popupParentPath;
    } else {
      breadcrumb.focusPath = breadcrumb.popupBreadcrumbs[breadcrumb.popupBreadcrumbs.length-1].vePath;
    }
    setBreadcrumbs(breadcrumbs());
  };

  const popAllPopups = (): void => {
    if (breadcrumbs().length == 0) { panic("popAllPopups: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    breadcrumb.popupBreadcrumbs = [];
    breadcrumb.focusPath = VeFns.addVeidToPath(breadcrumb.pageVeid, UMBRELLA_PAGE_UID);
    setBreadcrumbs(breadcrumbs());
  };

  const currentPopupSpec = (): PopupSpec | null => {
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) { return null; }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
  };

  const currentPopupSpecVeid = (): Veid | null => {
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) { return null; }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    const currentSpec = lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
    return currentSpec.actualVeid;
  };


  const setFocus = (focusPath: VisualElementPath): void => {
    if (breadcrumbs().length < 1) { panic("cannot set focus item when there is no current page."); }
    VeFns.validatePath(focusPath);

    breadcrumbs()[breadcrumbs().length-1].focusPath = focusPath;
    setBreadcrumbs(breadcrumbs());
  };

  const getFocusItem = (): Item => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
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
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    if (breadcrumb.focusPath != null) {
      return breadcrumb.focusPath;
    }
    panic("TODO (HIGH): focusPath fallback should never be hit");
  };

  const getFocusPathMaybe = (): VisualElementPath | null => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    return breadcrumb.focusPath;
  };

  const getFocusIsCurrentPage = (): boolean => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
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
