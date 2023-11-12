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
import { LEFT_TOOLBAR_WIDTH_PX, TOP_TOOLBAR_HEIGHT_PX } from "../constants";
import { NONE_VISUAL_ELEMENT, VisualElement, Veid, VisualElementPath, VeFns } from "../layout/visual-element";
import { createNumberSignal, createVisualElementPathSignal, NumberSignal, VisualElementPathSignal, VisualElementSignal } from "../util/signals";
import { HitInfo } from "../input/hit";


export interface DesktopStoreContextModel {
  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  topLevelVisualElement: Accessor<VisualElement>,
  setTopLevelVisualElement: Setter<VisualElement>,
  topLevelVisualElementSignal: () => VisualElementSignal,

  editDialogInfo: Accessor<EditDialogInfo | null>,
  setEditDialogInfo: Setter<EditDialogInfo | null>,

  editUserSettingsInfo: Accessor<EditUserSettingsInfo | null>,
  setEditUserSettingsInfo: Setter<EditUserSettingsInfo | null>,

  contextMenuInfo: Accessor<ContextMenuInfo | null>,
  setContextMenuInfo: Setter<ContextMenuInfo | null>,

  textEditOverlayInfo: Accessor<EditOverlayInfo | null>,
  setTextEditOverlayInfo: Setter<EditOverlayInfo | null>,

  pageSettingsOverlayInfo: Accessor<EditOverlayInfo | null>,
  setPageSettingsOverlayInfo: Setter<EditOverlayInfo | null>,

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

  pushPage: (veid: Veid) => void,
  popPage: () => boolean,
  currentPage: () => Veid | null,
  pushPopup: (popupSpec: PopupSpec) => void,
  replacePopup: (popupSpec: PopupSpec) => void,
  popPopup: () => void,
  popAllPopups: () => void,
  currentPopupSpec: () => PopupSpec | null,
  currentPopupSpecVePath: () => VisualElementPath | null,
  setHistoryToSinglePage: (currentPage: Veid) => void,

  currentVisiblePassword: Accessor<Uid | null>,
  setCurrentVisiblePassword: Setter<Uid | null>,

  clear: () => void,
  setPanicked: (panicked: boolean) => void,
  getPanicked: () => boolean,

  getInputFocus: () => Veid | null,
}

export interface EditOverlayInfo {
  itemPath: VisualElementPath
}

export interface ContextMenuInfo {
  posPx: Vector,
  hitInfo: HitInfo
}

export interface EditDialogInfo {
  desktopBoundsPx: BoundingBox,
  item: Item
}

export interface EditUserSettingsInfo {
  desktopBoundsPx: BoundingBox,
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
  const [getPanicked, setPanicked] = createSignal<boolean>(false, { equals: false });
  const [itemIsMoving, setItemIsMoving] = createSignal<boolean>(false, { equals: false });
  const [desktopSizePx, setDesktopSizePx] = createSignal<Dimensions>(currentDesktopSize(), { equals: false });
  const [editDialogInfo, setEditDialogInfo] = createSignal<EditDialogInfo | null>(null, { equals: false });
  const [editUserSettingsInfo, setEditUserSettingsInfo] = createSignal<EditUserSettingsInfo | null>(null, { equals: false });
  const [contextMenuInfo, setContextMenuInfo] = createSignal<ContextMenuInfo | null>(null, { equals: false });
  const [textEditOverlayInfo, setTextEditOverlayInfo] = createSignal<EditOverlayInfo | null>(null, { equals: false });
  const [pageSettingsOverlayInfo, setPageSettingsOverlayInfo] = createSignal<EditOverlayInfo | null>(null, { equals: false });
  const [searchOverlayVisible, setSearchOverlayVisible] = createSignal<boolean>(false, { equals: false });
  const [topLevelVisualElement, setTopLevelVisualElement] = createSignal<VisualElement>(NONE_VISUAL_ELEMENT, { equals: false });

  const topLevelVisualElementSignal = (): VisualElementSignal => { return { get: topLevelVisualElement, set: setTopLevelVisualElement }; }

  const [currentVisiblePassword, setCurrentVisiblePassword] = createSignal<Uid | null>(null, { equals: false });

  // TODO (LOW): Unsure if lots of these signals, after lots of navigation, will create a perf issue. possibly want to keep the number under control on page changes (delete those with value 0).
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
      pageScrollXPxs.set(key, createNumberSignal(0.0));
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
      pageScrollYPxs.set(key, createNumberSignal(0.0));
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
    let rootElement = document.getElementById("rootDiv") ?? panic("no rootDiv");
    return {
      w: rootElement.clientWidth - LEFT_TOOLBAR_WIDTH_PX,
      h: rootElement.clientHeight - TOP_TOOLBAR_HEIGHT_PX,
    };
  }

  const resetDesktopSizePx = () => {
    setDesktopSizePx(currentDesktopSize());
  }

  const desktopBoundsPx = () => {
    const dimensionsPx = desktopSizePx();
    return { x: 0.0, y: 0.0, w: dimensionsPx.w, h: dimensionsPx.h }
  }


  const clear = (): void => {
    setEditDialogInfo(null);
    setEditUserSettingsInfo(null);
    setContextMenuInfo(null);
    setTextEditOverlayInfo(null);
    setSearchOverlayVisible(false);
    setBreadcrumbs([]);
    setCurrentVisiblePassword(null);
    tableScrollPositions.clear();
    pageScrollXPxs.clear();
    pageScrollYPxs.clear();
    selectedItems.clear();
    topLevelVisualElementSignal().set(NONE_VISUAL_ELEMENT);
  };


  const pushPage = (veid: Veid): void => {
    breadcrumbs().push({ pageVeid: veid, popupBreadcrumbs: [] });
    setBreadcrumbs(breadcrumbs());
  };

  const popPage = (): boolean => {
    if (breadcrumbs().length <= 1) {
      return false;
    }
    breadcrumbs().pop();
    setBreadcrumbs(breadcrumbs());
    return true;
  };

  const currentPage = (): Veid | null => {
    if (breadcrumbs().length == 0) {
      return null;
    }
    return breadcrumbs()[breadcrumbs().length-1].pageVeid;
  };


  const pushPopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("pushPopup: no breadcrumbs."); }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.push(popupSpec);
    setBreadcrumbs(breadcrumbs());
  };

  const replacePopup = (popupSpec: PopupSpec): void => {
    if (breadcrumbs().length == 0) { panic("replacePopup: no breadcrumbs."); }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs = [popupSpec];
    setBreadcrumbs(breadcrumbs());
  };

  const popPopup = (): void => {
    if (breadcrumbs().length == 0) { panic("popPopup: no breadcrumbs."); }
    if (breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.length == 0) {
      return;
    }
    breadcrumbs()[breadcrumbs().length-1].popupBreadcrumbs.pop();
    setBreadcrumbs(breadcrumbs());
  };

  const popAllPopups = (): void => {
    if (breadcrumbs().length == 0) { panic("popAllPopups: no breadcrumbs."); }
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

  const setHistoryToSinglePage = (pageVeid: Veid): void => {
    setBreadcrumbs([{ pageVeid: pageVeid, popupBreadcrumbs: [] }]);
  };

  const getInputFocus = () => {
    if (textEditOverlayInfo() != null) {
      console.log("here");
      return VeFns.veidFromPath(textEditOverlayInfo()!.itemPath);
    }
    if (currentPopupSpec() != null) {
      if (currentPopupSpec()!.type == PopupType.Page) {
        return VeFns.veidFromPath(currentPopupSpec()!.vePath);
      }
    }
    return null;
  };

  const value: DesktopStoreContextModel = {
    itemIsMoving, setItemIsMoving,
    desktopBoundsPx, resetDesktopSizePx,
    topLevelVisualElement, setTopLevelVisualElement,
    topLevelVisualElementSignal,
    editDialogInfo, setEditDialogInfo,
    editUserSettingsInfo, setEditUserSettingsInfo,
    contextMenuInfo, setContextMenuInfo,
    textEditOverlayInfo, setTextEditOverlayInfo,
    pageSettingsOverlayInfo, setPageSettingsOverlayInfo,
    searchOverlayVisible, setSearchOverlayVisible,
    getTableScrollYPos, setTableScrollYPos,
    getSelectedListPageItem, setSelectedListPageItem,
    getPageScrollXProp, setPageScrollXProp,
    getPageScrollYProp, setPageScrollYProp,
    currentVisiblePassword, setCurrentVisiblePassword,

    pushPage,
    popPage,
    currentPage,
    pushPopup,
    replacePopup,
    popPopup,
    popAllPopups,
    currentPopupSpec,
    currentPopupSpecVePath,
    setHistoryToSinglePage,

    clear,
    setPanicked,
    getPanicked,

    getInputFocus,
  };

  return (
    <DesktopStoreContext.Provider value={value}>
      {props.children}
    </DesktopStoreContext.Provider>
  );
}


export function useDesktopStore(): DesktopStoreContextModel {
  return useContext(DesktopStoreContext) ?? panic("no desktop context");
}
