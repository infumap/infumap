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
import { Item } from "../items/base/item";
import { itemState } from "./ItemState";


export enum PopupType {
  Page,
  Attachment,
  Image
}

export interface PopupSpec {
  type: PopupType,
  actualVeid: Veid,
  vePath: VisualElementPath | null,
};

interface PageBreadcrumb {
  pageVeid: Veid,
  focusPath: VisualElementPath | null,
  popupBreadcrumbs: Array<PopupSpec>,
}


export interface HistoryStoreContextModel {
  pushPage: (veid: Veid) => void,
  popPage: () => boolean,
  currentPage: () => Veid | null,
  parentPage: () => Veid | null,
  pushPopup: (popupSpec: PopupSpec) => void,
  replacePopup: (popupSpec: PopupSpec) => void,
  popPopup: () => void,
  popAllPopups: () => void,
  currentPopupSpec: () => PopupSpec | null,
  currentPopupSpecVeid: () => Veid | null,
  setHistoryToSinglePage: (currentPage: Veid) => void,
  clear: () => void,
  setFocus: (focusPath: VisualElementPath | null) => void,
  getFocusItem: () => Item,
  getFocusPath: () => VisualElementPath,
  getParentPageFocusPath: () => VisualElementPath | null,
  changeParentPageFocusPath: (path: VisualElementPath) => void,
}


export function makeHistoryStore(): HistoryStoreContextModel {
  const [breadcrumbs, setBreadcrumbs] = createSignal<Array<PageBreadcrumb>>([], { equals: false });

  const pushPage = (pageVeid: Veid): void => {
    breadcrumbs().push({
      pageVeid,
      popupBreadcrumbs: [],
      focusPath: VeFns.addVeidToPath(pageVeid, "")
    });
    setBreadcrumbs(breadcrumbs());
  };

  const popPage = (): boolean => {
    if (breadcrumbs().length <= 1) { return false; }
    breadcrumbs().pop();
    setBreadcrumbs(breadcrumbs());
    return true;
  };

  const currentPage = (): Veid | null => {
    if (breadcrumbs().length == 0) { return null; }
    return breadcrumbs()[breadcrumbs().length-1].pageVeid;
  };

  const parentPageBreadcrumb = (): PageBreadcrumb | null => {
    if (breadcrumbs().length < 2) { return null; }
    return breadcrumbs()[breadcrumbs().length-2];
  };

  const parentPage = (): Veid | null => {
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

  const setHistoryToSinglePage = (pageVeid: Veid): void => {
    setBreadcrumbs([{
      pageVeid,
      parentPageChanged: true,
      popupBreadcrumbs: [],
      focusPath: VeFns.addVeidToPath(pageVeid, "")
    }]);
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
    breadcrumb.popupBreadcrumbs.pop();
    if (breadcrumb.popupBreadcrumbs.length == 0) {
      breadcrumb.focusPath = VeFns.addVeidToPath(breadcrumb.pageVeid, "");
    } else {
      breadcrumb.focusPath = breadcrumb.popupBreadcrumbs[breadcrumb.popupBreadcrumbs.length-1].vePath;
    }
    setBreadcrumbs(breadcrumbs());
  };

  const popAllPopups = (): void => {
    if (breadcrumbs().length == 0) { panic("popAllPopups: no breadcrumbs."); }
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    breadcrumb.popupBreadcrumbs = [];
    breadcrumb.focusPath = VeFns.addVeidToPath(breadcrumb.pageVeid, "");
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


  const setFocus = (focusPath: VisualElementPath | null): void => {
    if (breadcrumbs().length < 1) { panic("cannot set focus item when there is no current page."); }
    breadcrumbs()[breadcrumbs().length-1].focusPath = focusPath;
    setBreadcrumbs(breadcrumbs());
  };

  const getFocusItem = (): Item => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    if (breadcrumb.focusPath != null) {
      if (VeFns.veidFromPath(breadcrumb.focusPath!).linkIdMaybe != null) {
        return itemState.get(VeFns.veidFromPath(breadcrumb.focusPath!).linkIdMaybe!)!;
      }
      return itemState.get(VeFns.veidFromPath(breadcrumb.focusPath!).itemId)!;
    }
    if (currentPopupSpec() != null) {
      if (currentPopupSpec()!.type == PopupType.Page) {
        return itemState.get(currentPopupSpec()!.actualVeid.itemId)!;
      }
    }
    return itemState.get(currentPage()!.itemId)!;
  };

  const getFocusPath = (): VisualElementPath => {
    const breadcrumb = breadcrumbs()[breadcrumbs().length-1];
    if (breadcrumb.focusPath != null) {
      return breadcrumb.focusPath;
    }
    panic("TODO (HIGH): focusPath fallback should never be hit");
  };


  const clear = (): void => {
    setBreadcrumbs([]);
  };


  return ({
    pushPage,
    popPage,
    currentPage,
    parentPage,
    setHistoryToSinglePage,

    pushPopup,
    replacePopup,
    popPopup,
    popAllPopups,
    currentPopupSpec,
    currentPopupSpecVeid,

    setFocus,
    getFocusItem,
    getFocusPath,
    getParentPageFocusPath,
    changeParentPageFocusPath,

    clear,
  });
}
