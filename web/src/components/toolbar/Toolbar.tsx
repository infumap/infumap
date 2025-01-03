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

import imgUrl from '../../assets/circle.png'

import { Component, For, Match, Show, Switch, createMemo } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { NONE_VISUAL_ELEMENT, VeFns, VisualElementFlags } from "../../layout/visual-element";
import { Toolbar_Note } from "./item/Toolbar_Note";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { Toolbar_NetworkStatus } from "./Toolbar_NetworkStatus";
import { initialEditUserSettingsBounds } from "../overlay/UserSettings";
import { itemState } from "../../store/ItemState";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { hexToRGBA } from "../../util/color";
import { BORDER_COLOR, BorderType, Colors, LIGHT_BORDER_COLOR, borderColorForColorIdx, linearGradient, mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { InfuIconButton } from '../library/InfuIconButton';
import { Toolbar_Page } from './item/Toolbar_Page';
import { Toolbar_Table } from './item/Toolbar_Table';
import { fullArrange } from '../../layout/arrange';
import { GRID_SIZE, LINE_HEIGHT_PX, NATURAL_BLOCK_SIZE_PX, Z_INDEX_SHOW_TOOLBAR_ICON } from '../../constants';
import { Toolbar_Expression } from './item/Toolbar_Expression';
import { isNote } from '../../items/note-item';
import { isExpression } from '../../items/expression-item';
import { isTable } from '../../items/table-item';
import { isRating } from '../../items/rating-item';
import { Toolbar_Rating } from './item/Toolbar_Rating';
import { isPassword } from '../../items/password-item';
import { Toolbar_Password } from './item/Toolbar_Password';
import { isImage } from '../../items/image-item';
import { Toolbar_Image } from './item/Toolbar_Image';
import { isFile } from '../../items/file-item';
import { Toolbar_File } from './item/Toolbar_File';
import { isLink } from '../../items/link-item';
import { Toolbar_Link } from './item/Toolbar_Link';
import { VesCache } from '../../layout/ves-cache';
import { isFlipCard } from '../../items/flipcard-item';
import { Toolbar_FlipCard } from './item/Toolbar_FlipCard';
import { logout } from '../Main';


export const Toolbar: Component = () => {
  const store = useStore();

  const handleLogin = () => {
    logout!(); // ensures all state is cleared, so old state can never be visible briefly after login.
    window.location.pathname = "/login";
  }

  const showUserSettings = () => {
    store.overlay.editUserSettingsInfo.set({ desktopBoundsPx: initialEditUserSettingsBounds(store) });
  }

  const calcFocusPageIdx = () => {
    store.touchToolbarDependency();
    const topPageVePaths = store.topTitledPages.get();
    const focusPath = store.history.getFocusPathMaybe();
    if (focusPath == null) {
      return -1;
    }
    const currentFocusVeid = VeFns.veidFromPath(focusPath);
    let focusPageIdx = -1;
    for (let i=0; i<topPageVePaths.length; ++i) {
      if (!VeFns.compareVeids(VeFns.veidFromPath(topPageVePaths[i]), currentFocusVeid)) {
        focusPageIdx = i;
      }
    }
    return focusPageIdx;
  };

  const titleSpecs = createMemo(() => {
    store.touchToolbarDependency();

    const defaultBg = 'background-color: #fafafa;';
    const defaultCol = hexToRGBA(Colors[0], 1.0);

    if (store.history.currentPageVeid() == null) {
      return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1 }];
    }

    let aTopPageHasFocus = isPage(store.history.getFocusItem());
    if (store.history.currentPopupSpecVeid() != null && isPage(itemState.get(store.history.currentPopupSpecVeid()!.itemId)!)) {
      aTopPageHasFocus = false;
    }
    const fVes = VesCache.get(store.history.getFocusPath()!);
    if (fVes) {
      const fVe = fVes.get();
      if (!(fVe.flags & VisualElementFlags.TopLevelRoot)) {
        aTopPageHasFocus = false;
      }
    }

    const topPageVePaths = store.topTitledPages.get();
    const topPageVeids = [];
    for (let i=0; i<topPageVePaths.length; ++i) {
      topPageVeids.push(VeFns.veidFromPath(topPageVePaths[i]));
    }
    let focusPageIdx = -1;
    let focusPageItem = null;
    if (aTopPageHasFocus) {
      focusPageIdx = calcFocusPageIdx();
      if (focusPageIdx == -1) {
        return [{ title: "", idx: 0, lPosPx: 0, rPosPx: -1, bg: defaultBg, col: defaultCol, hasFocus: false, nextHasFocus: false, borderColor: ' ', borderWidthPx: 1 }];
      }
      focusPageItem = asPageItem(itemState.get(topPageVeids[focusPageIdx].itemId)!);
    }

    let r = [];

    let lPosPx = 0;
    let rPosPx = (asPageItem(itemState.get(topPageVeids[0].itemId)!).tableColumns[0].widthGr / GRID_SIZE) * LINE_HEIGHT_PX;
    if (topPageVeids.length == 1) { rPosPx = -1; }
    r.push({
      title: asPageItem(itemState.get(topPageVeids[0].itemId)!).title,
      idx: 0,
      lPosPx,
      rPosPx,
      bg: focusPageIdx == 0 ? `background-image: ${linearGradient(asPageItem(itemState.get(topPageVeids[0].itemId)!).backgroundColorIndex, 0.92)};` : defaultBg,
      col: `${hexToRGBA(Colors[asPageItem(itemState.get(topPageVeids[0].itemId)!).backgroundColorIndex], 1.0)}; `,
      hasFocus: focusPageIdx == 0,
      nextHasFocus: focusPageIdx == 1,
      borderColor: focusPageIdx == 0
        ? borderColorForColorIdx(asPageItem(itemState.get(topPageVeids[0].itemId)!).backgroundColorIndex, BorderType.MainPage)
        : ' ',
      borderWidthPx: focusPageIdx == 0 ? 2 : 1,
    });

    for (let i=1; i<topPageVeids.length; ++i) {
      let pUid = topPageVeids[i].itemId;
      let page = asPageItem(itemState.get(pUid)!);
      lPosPx = rPosPx;
      rPosPx = lPosPx + (page.tableColumns[0].widthGr / GRID_SIZE) * LINE_HEIGHT_PX;
      if (i == topPageVeids.length-1) {
        rPosPx = -1;
      }

      r.push({
        title: page.title,
        idx: i,
        lPosPx,
        rPosPx,
        bg: aTopPageHasFocus && focusPageIdx <= i ? `background-image: ${linearGradient(focusPageItem!.backgroundColorIndex, 0.92)};` : defaultBg,
        col: `${hexToRGBA(Colors[page.backgroundColorIndex], 1.0)}; `,
        hasFocus: focusPageIdx == i,
        nextHasFocus: focusPageIdx == i+1,
        borderColor: aTopPageHasFocus && focusPageIdx <= i
          ? borderColorForColorIdx(focusPageItem!.backgroundColorIndex, BorderType.MainPage)
          : ' ',
        borderWidthPx: focusPageIdx <= i ? 2 : 1
      });
    }

    return r;
  });

  const rightMostTitleSpec = () =>
    titleSpecs()[titleSpecs().length-1];

  const hideToolbar = () => {
    store.topToolbarVisible.set(false);
    store.resetDesktopSizePx();
    fullArrange(store);
  }

  const showToolbar = () => {
    store.topToolbarVisible.set(true);
    store.resetDesktopSizePx();
    fullArrange(store);
  }

  const handleTitleClick = () => {
    return;
  }

  const handleLogoClick = () => {
    window.history.pushState(null, "", "/");
    window.location.reload();
  }

  const dockToolbarAreaMaybe = () =>
    <Show when={store.dockVisible.get()}>
      <>
        <div class="fixed left-0 top-0 border-r border-b overflow-hidden"
             style={`width: ${store.getCurrentDockWidthPx()}px; height: ${store.topToolbarHeightPx()}px; background-color: #fafafa; ` +
                    `border-bottom-color: ${LIGHT_BORDER_COLOR}; border-right-color: ${mainPageBorderColor(store, itemState.get)}; ` +
                    `border-right-width: ${mainPageBorderWidth(store)}px`}>
          <div class="flex flex-row flex-nowrap" style={'width: 100%; margin-top: 4px; margin-left: 6px;'}>
            <Show when={store.getCurrentDockWidthPx() > NATURAL_BLOCK_SIZE_PX.w}>
              <div class="align-middle inline-block" style="margin-top: 2px; margin-left: 2px; flex-grow: 0; flex-basis: 28px; flex-shrink: 0;">
                <a href="/" onClick={handleLogoClick}><img src={imgUrl} class="w-[28px] inline-block" /></a>
              </div>
            </Show>
            <div class="inline-block" style="flex-grow: 1;" />
            <div class="inline-block"
                 style={"flex-grow: 0; margin-right: 8px;" +
                        `padding-right: ${2-(mainPageBorderWidth(store)-1)}px; `}>
              <Show when={store.getCurrentDockWidthPx() > NATURAL_BLOCK_SIZE_PX.w * 2}>
                <Toolbar_Navigation />
              </Show>
            </div>
          </div>
        </div>
        {/* this a hack to cover over a barely visible visual issue at the intersection of the toolbar and dock borders. */}
        <div class="absolute"
             style={`width: ${mainPageBorderWidth(store)}px; ` +
                    `height: 10px; ` +
                    `left: ${store.getCurrentDockWidthPx() - mainPageBorderWidth(store)}px; ` +
                    `top: ${store.topToolbarHeightPx() - 5}px; ` +
                    `background-color: ${mainPageBorderColor(store, itemState.get)};`} />
      </>
    </Show>;

  const rightToolbarSection = () =>
    <div class="border-l border-b pl-[4px] flex flex-row"
         style={`border-color: ${rightMostTitleSpec().borderColor}; background-color: #fafafa; ` +
                `border-left-width: ${rightMostTitleSpec().borderWidthPx}px; border-bottom-width: ${rightMostTitleSpec().borderWidthPx}px; ` +
                `align-items: baseline;`}>

      <Show when={store.umbrellaVisualElement.get().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
        <Switch fallback={<div id="toolbarItemOptionsDiv">[no context]</div>}>
          <Match when={isPage(store.history.getFocusItem())}>
            <Show when={asPageItem(store.history.getFocusItem()).arrangeAlgorithm != ArrangeAlgorithm.SingleCell}>
              <Toolbar_Page />
            </Show>
          </Match>
          <Match when={isNote(store.history.getFocusItem())}>
            <Toolbar_Note />
          </Match>
          <Match when={isExpression(store.history.getFocusItem())}>
            <Toolbar_Expression />
          </Match>
          <Match when={isTable(store.history.getFocusItem())}>
            <Toolbar_Table />
          </Match>
          <Match when={isRating(store.history.getFocusItem())}>
            <Toolbar_Rating />
          </Match>
          <Match when={isPassword(store.history.getFocusItem())}>
            <Toolbar_Password />
          </Match>
          <Match when={isImage(store.history.getFocusItem())}>
            <Toolbar_Image />
          </Match>
          <Match when={isFile(store.history.getFocusItem())}>
            <Toolbar_File />
          </Match>
          <Match when={isLink(store.history.getFocusItem())}>
            <Toolbar_Link />
          </Match>
          <Match when={isFlipCard(store.history.getFocusItem())}>
            <Toolbar_FlipCard />
          </Match>
        </Switch>
      </Show>

      <div class="flex-grow-0 ml-[7px] mr-[7px] relative" style="flex-order: 1; height: 25px;">
        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 87px; top: 7px;"></div>
      </div>

      <div class="flex-grow-0 pr-[8px]" style="flex-order: 2;">
        <Show when={!store.user.getUserMaybe()}>
          <InfuIconButton icon="fa fa-sign-in" highlighted={false} clickHandler={handleLogin} />
        </Show>
        <Show when={store.user.getUserMaybe()}>
          <InfuIconButton icon="fa fa-user" highlighted={false} clickHandler={showUserSettings} />
        </Show>
        <Toolbar_NetworkStatus />
        <InfuIconButton icon="fa fa-chevron-up" highlighted={false} clickHandler={hideToolbar} />
      </div>

    </div>;

  const mainToolbarArea = () =>
    <div class="fixed right-0 top-0" style={`left: ${store.getCurrentDockWidthPx()}px;}`}>
      <div class="flex flex-row">

        <For each={titleSpecs()}>{tSpec =>
          <>
            {/* spacer before title text */}
            <div class="border-b flex-grow-0"
                 style={`width: ${tSpec.lPosPx == 0 ? '5' : (tSpec.hasFocus ? '7' : '6')}px; border-bottom-color: ${LIGHT_BORDER_COLOR}; ` +
                        `${tSpec.bg}` +
                        (tSpec.lPosPx != 0 ? `border-left-width: ${tSpec.hasFocus ? '2' : '1'}px; border-left-color: ${tSpec.hasFocus ? tSpec.borderColor : BORDER_COLOR}; ` : '') +
                        `border-top-color: ${tSpec.borderColor};` +
                        `border-top-width: ${tSpec.borderWidthPx - 1}px; `} />

            <div id={`toolbarTitleDiv-${tSpec.idx}`}
                 class="p-[3px] inline-block cursor-text border-b flex-grow-0 overflow-hidden whitespace-nowrap"
                 contentEditable={true}
                 style={`font-size: 22px; color: ${tSpec.col}; font-weight: 700; border-bottom-color: ${LIGHT_BORDER_COLOR}; ` +
                        `${tSpec.bg} ` +
                        `border-top-color: ${tSpec.borderColor};` +
                        `border-top-width: ${tSpec.borderWidthPx - 1}px; ` +
                        `padding-top: ${2-(tSpec.borderWidthPx-1)}px; ` +
                        `height: ${store.topToolbarHeightPx()}px; ` +
                        (tSpec.rPosPx > 0 ? `width: ${tSpec.rPosPx - tSpec.lPosPx - 6 - (tSpec.nextHasFocus ? 1 : 0)}px;` : '') +
                        "outline: 0px solid transparent;"}
                onClick={handleTitleClick}>
              {tSpec.title}
            </div>
          </>
        }</For>

        <div class="inline-block flex-nowrap border-b"
             style={`flex-grow: 1; border-bottom-color: ${LIGHT_BORDER_COLOR};` +
                    `${rightMostTitleSpec().bg} ` +
                    `border-top-color: ${rightMostTitleSpec().borderColor};` +
                    `border-top-width: ${rightMostTitleSpec().borderWidthPx - 1}px; `}></div>

        {rightToolbarSection()}

      </div>
    </div>;

  const toolbar = () => 
    <>
      {dockToolbarAreaMaybe()}
      {mainToolbarArea()}
    </>;

  const showToolbarButton = () =>
    <div class="absolute"
         style={`z-index: ${Z_INDEX_SHOW_TOOLBAR_ICON}; ` +
                `right: 6px; top: -3px;`} onmousedown={showToolbar}>
      <i class={`fa fa-chevron-down hover:bg-slate-300 p-[2px] text-xs ${!store.dockVisible.get() ? 'text-white' : 'text-slate-400'}`} />
    </div>;

  return (
    <>
      <Show when={store.topToolbarVisible.get()}>
        {toolbar()}
      </Show>
      <Show when={!store.topToolbarVisible.get()}>
        {showToolbarButton()}
      </Show>
    </>
  );
}
