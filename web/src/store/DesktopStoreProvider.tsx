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
import { HitInfo } from "../mouse/hit";


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

  textEditOverlayInfo: Accessor<EditOverlayInfo | null>,
  setTextEditOverlayInfo: Setter<EditOverlayInfo | null>,

  searchOverlayVisible: Accessor<boolean>,
  setSearchOverlayVisible: Setter<boolean>,

  itemIsMoving: Accessor<boolean>,
  setItemIsMoving: Setter<boolean>,

  getTableScrollYPos: (veid: Veid) => number,
  setTableScrollYPos: (veid: Veid, pos: number) => void,

  getSelectedListPageItem: (veid: Veid) => VisualElementPath,
  setSelectedListPageItem: (veid: Veid, path: VisualElementPath) => void,

  getPageScrollXProp: (veid: Veid) => number,
  setPageScrollXProp: (veid: Veid, path: number) => void,

  getPageScrollYProp: (veid: Veid) => number,
  setPageScrollYProp: (veid: Veid, path: number) => void,

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

  currentVisiblePassword: Accessor<Uid | null>,
  setCurrentVisiblePassword: Setter<Uid | null>,
}

export interface EditOverlayInfo {
  noteItemPath: VisualElementPath
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
  Attachment,
  Image
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
  const [itemIsMoving, setItemIsMoving] = createSignal<boolean>(false, { equals: false });
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [editDialogInfo, setEditDialogInfo] = createSignal<EditDialogInfo | null>(null, { equals: false });
  const [contextMenuInfo, setContextMenuInfo] = createSignal<ContextMenuInfo | null>(null, { equals: false });
  const [textEditOverlayInfo, setTextEditOverlayInfo] = createSignal<EditOverlayInfo | null>(null, { equals: false });
  const [searchOverlayVisible, setSearchOverlayVisible] = createSignal<boolean>(false, { equals: false });
  const [topLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement>(NONE_VISUAL_ELEMENT, { equals: false });

  const topLevelVisualElementSignal = (): VisualElementSignal => { return { get: topLevelVisualElement, set: setTopLevelVisualElement }; }

  const [currentVisiblePassword, setCurrentVisiblePassword] = createSignal<Uid | null>(null, { equals: false });

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

  const getPageScrollXProp = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      return 0.0;
    }
    return pageScrollXPxs.get(key)!.get();
  };

  const setPageScrollXProp = (veid: Veid, px: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollXPxs.get(key)) {
      pageScrollXPxs.set(key, createNumberSignal(px));
      return;
    }
    pageScrollXPxs.get(key)!.set(px);
  };

  const getPageScrollYProp = (veid: Veid): number => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      return 0.0;
    }
    return pageScrollYPxs.get(key)!.get();
  };

  const setPageScrollYProp = (veid: Veid, px: number): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!pageScrollYPxs.get(key)) {
      pageScrollYPxs.set(key, createNumberSignal(px));
      return;
    }
    pageScrollYPxs.get(key)!.set(px);
  };

  const getSelectedListPageItem = (veid: Veid): VisualElementPath => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createVisualElementPathSignal(""));
    }
    return selectedItems.get(key)!.get();
  };

  const setSelectedListPageItem = (veid: Veid, path: VisualElementPath): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createVisualElementPathSignal(path));
      return;
    }
    selectedItems.get(key)!.set(path);
  };

  function currentDesktopSize(): Dimensions {
    let rootElement = document.getElementById("rootDiv") ?? panic();
    return { w: rootElement.clientWidth - MAIN_TOOLBAR_WIDTH_PX, h: rootElement.clientHeight };
  }

  const resetDesktopSizePx = () => {
    setDesktopSizePx(currentDesktopSize());
  }

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
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) {
      return null;
    }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    return lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
  };

  const currentPopupSpecVePath = (): VisualElementPath | null => {
    if (breadcrumbs().length == 0) { return null; }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) { return null; }
    const lastBreadcrumbPopups = breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs;
    const currentSpec = lastBreadcrumbPopups[lastBreadcrumbPopups.length-1];
    return currentSpec.vePath;
  };

  const value: DesktopStoreContextModel = {
    itemIsMoving, setItemIsMoving,
    desktopBoundsPx, resetDesktopSizePx,
    topLevelVisualElement, setTopLevelVisualElement,
    topLevelVisualElementSignal,
    editDialogInfo, setEditDialogInfo,
    contextMenuInfo, setContextMenuInfo,
    textEditOverlayInfo, setTextEditOverlayInfo,
    searchOverlayVisible, setSearchOverlayVisible,
    getTableScrollYPos, setTableScrollYPos,
    getSelectedListPageItem, setSelectedListPageItem,
    getPageScrollXProp, setPageScrollXProp,
    getPageScrollYProp, setPageScrollYProp,
    currentVisiblePassword, setCurrentVisiblePassword,

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
