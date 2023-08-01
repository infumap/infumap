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

import { Accessor, createSignal, JSX, Setter } from "solid-js";
import { createContext, useContext } from "solid-js";
import { panic } from "../util/lang";
import { Item } from "../items/base/item";
import { Uid } from "../util/uid";
import { BoundingBox, Dimensions, Vector } from "../util/geometry";
import { MAIN_TOOLBAR_WIDTH_PX } from "../constants";
import { NONE_VISUAL_ELEMENT, VisualElement, Veid, VisualElementPath } from "../layout/visual-element";
import { createNumberSignal, createVisualElementPathSignal, NumberSignal, VisualElementPathSignal, VisualElementSignal } from "../util/signals";
import { HitInfo } from "../mouse/hitInfo";


export interface DesktopStoreContextModel {
  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  topLevelVisualElement: Accessor<VisualElement>,
  setTopLevelVisualElement: Setter<VisualElement>,
  topLevelVisualElementSignal: () => VisualElementSignal,

  editDialogInfo: Accessor<EditDialogInfo | null>,
  setEditDialogInfo: Setter<EditDialogInfo | null>,

  contextMenuInfo: Accessor<ContextMenuInfo | null>,
  setContextMenuInfo: Setter<ContextMenuInfo | null>,

  getTableScrollYPos: (veid: Veid) => number,
  setTableScrollYPos: (veid: Veid, pos: number) => void,

  getSelectedItem: (veid: Veid) => VisualElementPath,
  setSelectedItem: (veid: Veid, path: VisualElementPath) => void,

  getPageScrollXPx: (veid: Veid) => number,
  setPageScrollXPx: (veid: Veid, path: number) => void,

  getPageScrollYPx: (veid: Veid) => number,
  setPageScrollYPx: (veid: Veid, path: number) => void,

  clearBreadcrumbs: () => void,
  pushPage: (veid: Veid) => void,
  popPage: () => void,
  currentPage: () => Veid | null,
  pushPopup: (popupSpec: PopupSpec) => void,
  replacePopup: (popupSpec: PopupSpec) => void,
  popPopup: () => void,
  popAllPopups: () => void,
  currentPopupSpec: () => PopupSpec | null,
  currentPopupSpecVePath: () => VisualElementPath | null,
}

export interface ContextMenuInfo {
  posPx: Vector,
  hitInfo: HitInfo
}

export interface EditDialogInfo {
  desktopBoundsPx: BoundingBox,
  item: Item
}

export enum PopupType {
  Page,
  Attachment
}

export interface PopupSpec {
  type: PopupType,
  vePath: VisualElementPath
};

interface PageBreadcrumb {
  pageVeid: Veid,
  popupBreadcrumbs: Array<PopupSpec>,
}


export interface DesktopStoreContextProps {
  children: JSX.Element
}

const DesktopStoreContext = createContext<DesktopStoreContextModel>();


export function DesktopStoreProvider(props: DesktopStoreContextProps) {
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [editDialogInfo, setEditDialogInfo] = createSignal<EditDialogInfo | null>(null, { equals: false });
  const [contextMenuInfo, setContextMenuInfo] = createSignal<ContextMenuInfo | null>(null, { equals: false });
  const [topLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement>(NONE_VISUAL_ELEMENT, { equals: false });

  const topLevelVisualElementSignal = (): VisualElementSignal => { return { get: topLevelVisualElement, set: setTopLevelVisualElement }; }

  const tableScrollPositions = new Map<string, NumberSignal>();
  const pageScrollXPxs = new Map<string, NumberSignal>();
  const pageScrollYPxs = new Map<string, NumberSignal>();
  const selectedItems = new Map<string, VisualElementPathSignal>();

  const [breadcrumbs, setBreadcrumbs] = createSignal<Array<PageBreadcrumb>>([], { equals: false });

  const getTableScrollYPos = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(0.0));
    }
    return tableScrollPositions.get(key)!.get();
  };

  const setTableScrollYPos = (veid: Veid, pos: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!tableScrollPositions.get(key)) {
      tableScrollPositions.set(key, createNumberSignal(pos));
      return;
    }
    tableScrollPositions.get(key)!.set(pos);
  };

  const getPageScrollXPx = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollXPxs.get(key)!.get();
  };

  const setPageScrollXPx = (veid: Veid, px: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(px));
      return;
    }
    pageScrollXPxs.get(key)!.set(px);
  };

  const getPageScrollYPx = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(0.0));
    }
    return pageScrollYPxs.get(key)!.get();
  };

  const setPageScrollYPx = (veid: Veid, px: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(px));
      return;
    }
    pageScrollYPxs.get(key)!.set(px);
  };

  const getSelectedItem = (veid: Veid): VisualElementPath => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createVisualElementPathSignal(""));
    }
    return selectedItems.get(key)!.get();
  };

  const setSelectedItem = (veid: Veid, path: VisualElementPath): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createVisualElementPathSignal(path));
      return;
    }
    selectedItems.get(key)!.set(path);
  };

  function currentDesktopSize(): Dimensions {
    let rootElement = document.getElementById("root") ?? panic();
    return { w: rootElement.clientWidth - MAIN_TOOLBAR_WIDTH_PX, h: rootElement.clientHeight };
  }

  const resetDesktopSizePx = () => { setDesktopSizePx(currentDesktopSize()); }
  const desktopBoundsPx = () => {
    const dimensionsPx = desktopSizePx();
    return { x: 0.0, y: 0.0, w: dimensionsPx.w, h: dimensionsPx.h }
  }


  const clearBreadcrumbs = (): void => {
    setBreadcrumbs([]);
  };


  const pushPage = (veid: Veid): void => {
    breadcrumbs().push({ pageVeid: veid, popupBreadcrumbs: [] });
    setBreadcrumbs(breadcrumbs());
  };

  const popPage = (): void => {
    if (breadcrumbs().length <= 1) {
      return;
    }
    breadcrumbs().pop();
    setBreadcrumbs(breadcrumbs());
  };

  const currentPage = (): Veid | null => {
    if (breadcrumbs().length == 0) {
      return null;
    }
    return breadcrumbs()[breadcrumbs().length-1].pageVeid;
  };


  const pushPopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic(); }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.push(popupSpec);
    setBreadcrumbs(breadcrumbs());
  };

  const replacePopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic(); }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs = [popupSpec];
    setBreadcrumbs(breadcrumbs());
  };

  const popPopup = (): void => {
    if (breadcrumbs().length == 0) { panic(); }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) {
      return;
    }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.pop();
    setBreadcrumbs(breadcrumbs());
  };

  const popAllPopups = (): void => {
    if (breadcrumbs().length == 0) { panic(); }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs = [];
    setBreadcrumbs(breadcrumbs());
  };

  const currentPopupSpec = (): PopupSpec | null => {
    if (breadcrumbs().length == 0) { panic(); }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) {
      return null;
    }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
  };

  const currentPopupSpecVePath = (): VisualElementPath | null => {
    if (breadcrumbs().length == 0) { panic(); }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) {
      return null;
    }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    const currentSpec = lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
    return currentSpec.vePath;
  };

  const value: DesktopStoreContextModel = {
    desktopBoundsPx, resetDesktopSizePx,
    topLevelVisualElement, setTopLevelVisualElement,
    topLevelVisualElementSignal,
    editDialogInfo, setEditDialogInfo,
    contextMenuInfo, setContextMenuInfo,
    getTableScrollYPos, setTableScrollYPos,
    getSelectedItem, setSelectedItem,
    getPageScrollXPx, setPageScrollXPx,
    getPageScrollYPx, setPageScrollYPx,

    clearBreadcrumbs,
    pushPage,
    popPage,
    currentPage,
    pushPopup,
    replacePopup,
    popPopup,
    popAllPopups,
    currentPopupSpec,
    currentPopupSpecVePath,
  };

  return (
    <DesktopStoreContext.Provider value={value}>
      {props.children}
    </DesktopStoreContext.Provider>
  );
}


export function useDesktopStore() : DesktopStoreContextModel {
  return useContext(DesktopStoreContext) ?? panic();
}


/**
 * Find all visual elements with the specified item and linkIdMaybe ids.
 */
export const findVisualElements = (desktopStore: DesktopStoreContextModel, itemId: Uid, linkIdMaybe: Uid | null): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.topLevelVisualElement();
  if (rootVe.displayItem.id == itemId) {
    if ((linkIdMaybe == null && rootVe.linkItemMaybe == null) ||
        (rootVe.linkItemMaybe != null && rootVe.linkItemMaybe!.id == linkIdMaybe)) {
      result.push({ get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement });
    }
  }
  result = result.concat(findVisualElementInChildAndAttachments(desktopStore, rootVe, itemId, linkIdMaybe));
  return result;
}

const findVisualElementInChildAndAttachments = (desktopStore: DesktopStoreContextModel, ve: VisualElement, itemId: Uid, linkItemIdMaybe: Uid | null): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().displayItem.id == itemId) {
      if ((linkItemIdMaybe == null && childVes.get().linkItemMaybe == null) ||
          (childVes.get().linkItemMaybe != null && childVes.get().linkItemMaybe!.id == linkItemIdMaybe)) {
        result.push(childVes);
      }
    }
    result = result.concat(findVisualElementInChildAndAttachments(desktopStore, childVes.get(), itemId, linkItemIdMaybe));
  });
  ve.attachments.forEach(attachmentVes => {
    if (attachmentVes.get().displayItem.id == itemId) {
      if ((linkItemIdMaybe == null && attachmentVes.get().linkItemMaybe == null) ||
          (attachmentVes.get().linkItemMaybe != null && attachmentVes.get().linkItemMaybe!.id == linkItemIdMaybe)) {
        result.push(attachmentVes);
      }
    }
    result = result.concat(findVisualElementInChildAndAttachments(desktopStore, attachmentVes.get(), itemId, linkItemIdMaybe));
  });
  return result;
}

/**
 * Find all visual elements with the specified item id.
 */
export const visualElementsWithItemId = (desktopStore: DesktopStoreContextModel, itemId: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  const rootVe = desktopStore.topLevelVisualElement();
  if (rootVe.displayItem.id == itemId) {
    result.push({ get: desktopStore.topLevelVisualElement, set: desktopStore.setTopLevelVisualElement });
  }
  result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, rootVe, itemId));
  return result;
}


const childAndAttachmentVisualElementsWithId = (desktopStore: DesktopStoreContextModel, ve: VisualElement, itemId: Uid): Array<VisualElementSignal> => {
  let result: Array<VisualElementSignal> = [];
  ve.children.forEach(childVes => {
    if (childVes.get().displayItem.id == itemId) {
      result.push(childVes);
    }
    result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, childVes.get(), itemId));
  });
  ve.attachments.forEach(attachmentVes => {
    if (attachmentVes.get().displayItem.id == itemId) {
      result.push(attachmentVes);
    }
    result = result.concat(childAndAttachmentVisualElementsWithId(desktopStore, attachmentVes.get(), itemId));
  });
  return result;
}
