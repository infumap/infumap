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

import { JSX } from "solid-js";
import { createContext, useContext } from "solid-js";
import { panic } from "../util/lang";
import { Uid } from "../util/uid";
import { BoundingBox, Dimensions } from "../util/geometry";
import { LEFT_TOOLBAR_WIDTH_PX, TOP_TOOLBAR_HEIGHT_PX } from "../constants";
import { NONE_VISUAL_ELEMENT, VisualElement, Veid, VisualElementPath, VeFns } from "../layout/visual-element";
import { createNumberSignal, createInfuSignal, NumberSignal, InfuSignal } from "../util/signals";
import { GeneralStoreContextModel, makeGeneralStore } from "./StoreProvider_General";
import { makeUserStore, UserStoreContextModel } from "./StoreProvider_User";
import { makeHistoryStore, HistoryStoreContextModel, PopupType } from "./StoreProvider_History";
import { OverlayStoreContextModel, makeOverlayStore } from "./StoreProvider_Overlay";

export interface StoreContextModel {

  desktopBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  topLevelVisualElement: InfuSignal<VisualElement>,

  currentVisiblePassword: InfuSignal<Uid | null>,

  clear: () => void,

  getToolbarFocus: () => Veid,

  itemIsMoving: InfuSignal<boolean>,

  getSelectedListPageItem: (veid: Veid) => VisualElementPath,
  setSelectedListPageItem: (veid: Veid, path: VisualElementPath) => void,

  getTableScrollYPos: (veid: Veid) => number,
  setTableScrollYPos: (veid: Veid, pos: number) => void,

  getPageScrollXProp: (veid: Veid) => number,
  setPageScrollXProp: (veid: Veid, path: number) => void,

  getPageScrollYProp: (veid: Veid) => number,
  setPageScrollYProp: (veid: Veid, path: number) => void,

  overlay: OverlayStoreContextModel,
  history: HistoryStoreContextModel,
  general: GeneralStoreContextModel,
  user: UserStoreContextModel,
}


export interface StoreContextProps {
  children: JSX.Element
}

const StoreContext = createContext<StoreContextModel>();


export function StoreProvider(props: StoreContextProps) {
  const desktopSizePx = createInfuSignal<Dimensions>(currentDesktopSize());

  const topLevelVisualElement = createInfuSignal<VisualElement>(NONE_VISUAL_ELEMENT);

  const currentVisiblePassword = createInfuSignal<Uid | null>(null);


  // TODO (LOW): Unsure if lots of these signals, after lots of navigation, will create a perf issue. possibly
  // want to keep the number under control on page changes (delete those with value 0).
  const tableScrollPositions = new Map<string, NumberSignal>();
  const pageScrollXPxs = new Map<string, NumberSignal>();
  const pageScrollYPxs = new Map<string, NumberSignal>();

  const selectedItems = new Map<string, InfuSignal<VisualElementPath>>();


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
      selectedItems.set(key, createInfuSignal<VisualElementPath>(""));
    }
    return selectedItems.get(key)!.get();
  };

  const setSelectedListPageItem = (veid: Veid, path: VisualElementPath): void => {
    const key = veid.itemId + (veid.linkIdMaybe == null ? "" : "[" + veid.linkIdMaybe + "]");
    if (!selectedItems.get(key)) {
      selectedItems.set(key, createInfuSignal<VisualElementPath>(path));
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
    desktopSizePx.set(currentDesktopSize());
  }

  const desktopBoundsPx = () => {
    const dimensionsPx = desktopSizePx.get();
    return { x: 0.0, y: 0.0, w: dimensionsPx.w, h: dimensionsPx.h }
  }


  const overlay = makeOverlayStore();
  const history = makeHistoryStore();

  const clear = (): void => {
    currentVisiblePassword.set(null);
    tableScrollPositions.clear();
    pageScrollXPxs.clear();
    pageScrollYPxs.clear();
    selectedItems.clear();
    topLevelVisualElement.set(NONE_VISUAL_ELEMENT);
    history.clear();
    overlay.clear();
  };


  const getToolbarFocus = (): Veid => {
    if (overlay.noteEditOverlayInfo.get() != null) {
      return VeFns.veidFromPath(overlay.noteEditOverlayInfo.get()!.itemPath);
    }
    if (overlay.tableEditOverlayInfo.get() != null) {
      return VeFns.veidFromPath(overlay.tableEditOverlayInfo.get()!.itemPath);
    }
    if (history.currentPopupSpec() != null) {
      if (history.currentPopupSpec()!.type == PopupType.Page) {
        return VeFns.veidFromPath(history.currentPopupSpec()!.vePath);
      }
    }
    return history.currentPage()!;
  };


  const value: StoreContextModel = {
    desktopBoundsPx, resetDesktopSizePx,

    topLevelVisualElement,

    getTableScrollYPos, setTableScrollYPos,
    getSelectedListPageItem, setSelectedListPageItem,
    getPageScrollXProp, setPageScrollXProp,
    getPageScrollYProp, setPageScrollYProp,

    clear,

    getToolbarFocus,

    currentVisiblePassword,

    itemIsMoving: createInfuSignal<boolean>(false),

    overlay,
    history,
    general: makeGeneralStore(),
    user: makeUserStore(),
  };

  return (
    <StoreContext.Provider value={value}>
      {props.children}
    </StoreContext.Provider>
  );
}


export function useStore(): StoreContextModel {
  return useContext(StoreContext) ?? panic("no store context");
}
