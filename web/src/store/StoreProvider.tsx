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
import { NATURAL_BLOCK_SIZE_PX, TOP_TOOLBAR_HEIGHT_PX } from "../constants";
import { NONE_VISUAL_ELEMENT, VisualElement, Veid, VeFns } from "../layout/visual-element";
import { createInfuSignal, InfuSignal } from "../util/signals";
import { GeneralStoreContextModel, makeGeneralStore } from "./StoreProvider_General";
import { makeUserStore, UserStoreContextModel } from "./StoreProvider_User";
import { makeHistoryStore, HistoryStoreContextModel, PopupType } from "./StoreProvider_History";
import { OverlayStoreContextModel, makeOverlayStore } from "./StoreProvider_Overlay";
import { PerItemStoreContextModel, makePerItemStore } from "./StoreProvider_PerItem";


export interface StoreContextModel {
  desktopBoundsPx: () => BoundingBox,
  desktopMainAreaBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,

  topLevelVisualElement: InfuSignal<VisualElement>,

  currentVisiblePassword: InfuSignal<Uid | null>,

  clear: () => void,

  getRememberedDockWidthPx: () => number,
  getCurrentDockWidthPx: () => number,
  setDockWidthPx: (widthPx: number) => void,

  topToolbarVisible: InfuSignal<boolean>,
  topToolbarHeight: () => number,

  dockVisible: InfuSignal<boolean>,

  anItemIsMoving: InfuSignal<boolean>,

  touchToolbar: () => void,  
  touchToolbarDependency: () => void,

  perItem: PerItemStoreContextModel,
  overlay: OverlayStoreContextModel,
  history: HistoryStoreContextModel,
  general: GeneralStoreContextModel,
  user: UserStoreContextModel,
}


export interface StoreContextProps {
  children: JSX.Element
}

const StoreContext = createContext<StoreContextModel>();

const INITIAL_DOCK_WIDTH_BL = 7;

export function StoreProvider(props: StoreContextProps) {
  const userStore = makeUserStore();

  const topToolbarVisible = createInfuSignal<boolean>(true);
  const topToolbarHeight = () => topToolbarVisible.get() ? TOP_TOOLBAR_HEIGHT_PX : 0;

  function currentDesktopSize(): Dimensions {
    let rootElement = document.getElementById("rootDiv") ?? panic("no rootDiv");
    return {
      w: rootElement.clientWidth,
      h: rootElement.clientHeight - topToolbarHeight(),
    };
  }

  const desktopSizePx = createInfuSignal<Dimensions>(currentDesktopSize());

  const topLevelVisualElement = createInfuSignal<VisualElement>(NONE_VISUAL_ELEMENT);

  const currentVisiblePassword = createInfuSignal<Uid | null>(null);

  const dockWidthPx = createInfuSignal<number>(INITIAL_DOCK_WIDTH_BL * NATURAL_BLOCK_SIZE_PX.w);

  const getCurrentDockWidthPx = (): number => {
    const wPx = getRememberedDockWidthPx();
    if (!dockVisible.get()) { return 0; }
    return wPx;
  }

  const getRememberedDockWidthPx = (): number => {
    if (userStore.getUserMaybe() == null) { return 0; }
    return dockWidthPx.get();
  }
  const setDockWidthPx = (widthPx: number) => {
    dockWidthPx.set(widthPx);
  }

  const dockVisible = createInfuSignal<boolean>(true);

  const resetDesktopSizePx = () => {
    desktopSizePx.set(currentDesktopSize());
  }

  const desktopBoundsPx = () => {
    const dimensionsPx = desktopSizePx.get();
    return { x: 0.0, y: 0.0, w: dimensionsPx.w, h: dimensionsPx.h }
  }

  const desktopMainAreaBoundsPx = () => {
    const result = desktopBoundsPx();
    if (dockVisible.get()) {
      result.x = getRememberedDockWidthPx();
      result.w = result.w - getRememberedDockWidthPx();
    }
    return result;
  }

  const perItem = makePerItemStore();
  const overlay = makeOverlayStore();
  const history = makeHistoryStore();

  const clear = (): void => {
    currentVisiblePassword.set(null);
    topLevelVisualElement.set(NONE_VISUAL_ELEMENT);
    history.clear();
    overlay.clear();
    perItem.clear();
    dockWidthPx.set(INITIAL_DOCK_WIDTH_BL * NATURAL_BLOCK_SIZE_PX.w);
  };


  let touchToolbarSignal = createInfuSignal<boolean>(false);
  const touchToolbar = () => { touchToolbarSignal.set(false); }
  const touchToolbarDependency = () => { if (touchToolbarSignal.get()) { panic("toolbar rerender dependency signal should never be true."); } }


  const value: StoreContextModel = {
    desktopBoundsPx,
    resetDesktopSizePx,
    desktopMainAreaBoundsPx,
    getRememberedDockWidthPx,
    getCurrentDockWidthPx,
    setDockWidthPx,
    dockVisible,
    topToolbarVisible,
    topToolbarHeight,

    topLevelVisualElement,

    clear,

    touchToolbar,
    touchToolbarDependency,

    currentVisiblePassword,

    anItemIsMoving: createInfuSignal<boolean>(false),

    perItem,
    overlay,
    history,
    general: makeGeneralStore(),
    user: userStore,
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
