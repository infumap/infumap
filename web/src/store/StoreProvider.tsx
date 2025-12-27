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
import { NONE_VISUAL_ELEMENT, VisualElement, VisualElementPath } from "../layout/visual-element";
import { createInfuSignal, InfuSignal } from "../util/signals";
import { GeneralStoreContextModel, makeGeneralStore } from "./StoreProvider_General";
import { makeUserStore, UserStoreContextModel } from "./StoreProvider_User";
import { makeHistoryStore, HistoryStoreContextModel } from "./StoreProvider_History";
import { OverlayStoreContextModel, makeOverlayStore } from "./StoreProvider_Overlay";
import { PerItemStoreContextModel, makePerItemStore } from "./StoreProvider_PerItem";
import { PerVeStoreContextModel, makePerVeStore } from "./StoreProvider_PerVe";
import { FindStoreContextModel, makeFindStore } from "./StoreProvider_Find";
import { setGlobalRequestTracker } from "../server";


export interface StoreContextModel {
  desktopBoundsPx: () => BoundingBox,
  desktopMainAreaBoundsPx: () => BoundingBox,
  resetDesktopSizePx: () => void,
  smallScreenMode: () => boolean,

  currentUrlPath: InfuSignal<string>,

  umbrellaVisualElement: InfuSignal<VisualElement>,

  topTitledPages: InfuSignal<Array<VisualElementPath>>,

  currentVisiblePassword: InfuSignal<Uid | null>,

  clear: () => void,

  getRememberedDockWidthPx: () => number,
  getCurrentDockWidthPx: () => number,
  setDockWidthPx: (widthPx: number) => void,

  topToolbarVisible: InfuSignal<boolean>,
  topToolbarHeightPx: () => number,

  dockVisible: InfuSignal<boolean>,

  anItemIsResizing: InfuSignal<boolean>,
  anItemIsMoving: InfuSignal<boolean>,
  mouseOverTableHeaderColumnNumber: InfuSignal<number | null>,

  touchToolbar: () => void,
  touchToolbarDependency: () => void,

  perVe: PerVeStoreContextModel,
  perItem: PerItemStoreContextModel,
  overlay: OverlayStoreContextModel,
  history: HistoryStoreContextModel,
  general: GeneralStoreContextModel,
  user: UserStoreContextModel,
  find: FindStoreContextModel,
}


export interface StoreContextProps {
  children: JSX.Element
}

const StoreContext = createContext<StoreContextModel>();

const INITIAL_DOCK_WIDTH_BL = 7;

export function StoreProvider(props: StoreContextProps) {
  const userStore = makeUserStore();

  const currentUrlPath = createInfuSignal<string>('');

  const topToolbarVisible = createInfuSignal<boolean>(true);
  const topToolbarHeightPx = () => topToolbarVisible.get() && !smallScreenMode() ? TOP_TOOLBAR_HEIGHT_PX : 0;

  const browserClientSizePx = createInfuSignal<Dimensions>({ w: (document.getElementById("rootDiv") ?? panic("no rootDiv")).clientWidth, h: (document.getElementById("rootDiv") ?? panic("no rootDiv")).clientHeight });

  const umbrellaVisualElement = createInfuSignal<VisualElement>(NONE_VISUAL_ELEMENT);

  const topTitledPages = createInfuSignal<Array<VisualElementPath>>([]);

  const currentVisiblePassword = createInfuSignal<Uid | null>(null);

  const dockWidthPx = createInfuSignal<number>(INITIAL_DOCK_WIDTH_BL * NATURAL_BLOCK_SIZE_PX.w);

  const smallScreenMode = (): boolean =>
    browserClientSizePx.get().w < 765 || browserClientSizePx.get().h < 420;

  const getCurrentDockWidthPx = (): number => {
    const wPx = getRememberedDockWidthPx();
    if (!dockVisible.get()) { return 0; }
    if (smallScreenMode()) { return 0; }
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
    browserClientSizePx.set({ w: (document.getElementById("rootDiv") ?? panic("no rootDiv")).clientWidth, h: (document.getElementById("rootDiv") ?? panic("no rootDiv")).clientHeight });
  }

  const desktopBoundsPx = () => {
    let r = browserClientSizePx.get();
    return ({
      x: 0,
      y: 0,
      w: r.w,
      h: r.h - topToolbarHeightPx()
    });
  }

  const desktopMainAreaBoundsPx = () => {
    const result = desktopBoundsPx();
    if (dockVisible.get() && !smallScreenMode()) {
      result.x = getRememberedDockWidthPx();
      result.w = result.w - getRememberedDockWidthPx();
    }
    return result;
  }

  const perVe = makePerVeStore();
  const perItem = makePerItemStore();
  const overlay = makeOverlayStore();
  const history = makeHistoryStore();
  const find = makeFindStore();

  const clear = (): void => {
    currentVisiblePassword.set(null);
    umbrellaVisualElement.set(NONE_VISUAL_ELEMENT);
    history.clear();
    overlay.clear();
    perItem.clear();
    perVe.clear();
    find.clear();
    dockWidthPx.set(INITIAL_DOCK_WIDTH_BL * NATURAL_BLOCK_SIZE_PX.w);
  };


  let touchToolbarSignal = createInfuSignal<boolean>(false);
  const touchToolbar = () => { touchToolbarSignal.set(false); }
  const touchToolbarDependency = () => { if (touchToolbarSignal.get()) { panic("toolbar rerender dependency signal should never be true."); } }


  const value: StoreContextModel = {
    desktopBoundsPx,
    smallScreenMode,
    resetDesktopSizePx,
    desktopMainAreaBoundsPx,
    getRememberedDockWidthPx,
    getCurrentDockWidthPx,
    setDockWidthPx,
    dockVisible,
    topToolbarVisible,
    topToolbarHeightPx,

    currentUrlPath,

    umbrellaVisualElement,
    topTitledPages,

    clear,

    touchToolbar,
    touchToolbarDependency,

    currentVisiblePassword,

    anItemIsResizing: createInfuSignal<boolean>(false),
    anItemIsMoving: createInfuSignal<boolean>(false),
    mouseOverTableHeaderColumnNumber: createInfuSignal<number | null>(null),

    perVe,
    perItem,
    overlay,
    history,
    general: makeGeneralStore(),
    user: userStore,
    find,
  };

  // Initialize global request tracker for server.ts
  setGlobalRequestTracker({
    setCurrentNetworkRequest: value.general.setCurrentNetworkRequest,
    setQueuedNetworkRequests: value.general.setQueuedNetworkRequests,
    addErroredNetworkRequest: value.general.addErroredNetworkRequest,
    clearErrorsByCommand: value.general.clearErrorsByCommand,
  });

  return (
    <StoreContext.Provider value={value}>
      {props.children}
    </StoreContext.Provider>
  );
}


export function useStore(): StoreContextModel {
  return useContext(StoreContext) ?? panic("no store context");
}
