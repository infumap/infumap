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

import { Component, Match, Show, Switch } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { NONE_VISUAL_ELEMENT } from "../../layout/visual-element";
import { Toolbar_Note } from "./Toolbar_Note";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { initialEditUserSettingsBounds } from "../overlay/UserSettings";
import { useNavigate } from "@solidjs/router";
import { itemState } from "../../store/ItemState";
import { asPageItem, isPage } from "../../items/page-item";
import { hexToRGBA } from "../../util/color";
import { Colors, LIGHT_BORDER_COLOR, linearGradient, mainPageBorderColor, mainPageBorderWidth } from "../../style";
import { InfuIconButton } from '../library/InfuIconButton';
import { Toolbar_Page } from './Toolbar_Page';
import { Toolbar_Table } from './Toolbar_Table';
import { fullArrange } from '../../layout/arrange';
import { NATURAL_BLOCK_SIZE_PX, Z_INDEX_SHOW_TOOLBAR_ICON } from '../../constants';
import { Toolbar_Expression } from './Toolbar_Expression';
import { isNote } from '../../items/note-item';
import { isExpression } from '../../items/expression-item';
import { isTable } from '../../items/table-item';
import { isRating } from '../../items/rating-item';
import { Toolbar_Rating } from './Toolbar_Rating';
import { isPassword } from '../../items/password-item';
import { Toolbar_Password } from './Toolbar_Password';
import { isImage } from '../../items/image-item';
import { Toolbar_Image } from './Toolbar_Image';
import { isFile } from '../../items/file-item';
import { Toolbar_File } from './Toolbar_File';
import { isLink } from '../../items/link-item';
import { Toolbar_Link } from './Toolbar_Link';


export const Toolbar: Component = () => {
  const store = useStore();

  const navigate = useNavigate();

  const handleLogin = () => navigate("/login");

  const showUserSettings = () => { store.overlay.editUserSettingsInfo.set({ desktopBoundsPx: initialEditUserSettingsBounds(store) }); }

  const currentPageMaybe = () => {
    if (store.history.currentPageVeid() == null) { return null; }
    return asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
  }

  const title = () => {
    store.touchToolbarDependency();
    if (currentPageMaybe() == null) { return ""; }
    return currentPageMaybe()!.title;
  }

  const mainTitleColor = () => {
    // item state is not solid-js signals.
    // as a bit of a hack, change in color is signalled by re-setting this instead.
    store.overlay.toolbarPopupInfoMaybe.get();
    return `${hexToRGBA(Colors[currentPageMaybe() == null ? 0 : currentPageMaybe()!.backgroundColorIndex], 1.0)}; `
  };

  const pageColor = () => {
    store.overlay.toolbarPopupInfoMaybe.get();
    if (currentPageMaybe() == null) { return ''; }
    if (store.history.getFocusIsCurrentPage()) {
      return `background-image: ${linearGradient(currentPageMaybe()!.backgroundColorIndex, 0.92)};`
    }
    return 'background-color: #fafafa;';
  }

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

  return (
    <>
      <Show when={store.topToolbarVisible.get()}>
        <div class="fixed right-0 top-0"
             style={`left: 0px; `}>

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
              <div class="absolute"
                  style={`width: ${mainPageBorderWidth(store)}px; height: 10px; ` +
                         `left: ${store.getCurrentDockWidthPx() - mainPageBorderWidth(store)}px; top: ${store.topToolbarHeightPx() - 5}px; ` +
                         `background-color: ${mainPageBorderColor(store, itemState.get)};`} />
            </>
          </Show>

          <div class="fixed right-0 top-0" style={`left: ${store.getCurrentDockWidthPx()}px; ${pageColor()}`}>
            <div class="flex flex-row">
              <div class="border-b"
                   style={`width: 6px; border-bottom-color: ${LIGHT_BORDER_COLOR};` +
                          `border-top-color: ${mainPageBorderColor(store, itemState.get)}; ` +
                          `border-top-width: ${mainPageBorderWidth(store)-1}px`}></div>
              <div id="toolbarTitleDiv"
                   class="p-[3px] inline-block cursor-text border-b"
                   contentEditable={true}
                   style={`font-size: 22px; color: ${mainTitleColor()}; font-weight: 700; border-bottom-color: ${LIGHT_BORDER_COLOR}; ` +
                          `border-top-color: ${mainPageBorderColor(store, itemState.get)}; ` +
                          `border-top-width: ${mainPageBorderWidth(store)-1}px; ` +
                          `padding-top: ${2-(mainPageBorderWidth(store)-1)}px; ` +
                          `height: ${store.topToolbarHeightPx()}px; ` +
                          "outline: 0px solid transparent;"}
                   onClick={handleTitleClick}>
                {title()}
              </div>
              <div class="inline-block flex-nowrap border-b"
                   style={`flex-grow: 1; border-bottom-color: ${LIGHT_BORDER_COLOR};` +
                          `border-top-color: ${mainPageBorderColor(store, itemState.get)}; ` +
                          `border-top-width: ${mainPageBorderWidth(store)-1}px`}></div>

              <div class="border-l border-b pl-[4px] flex flex-row"
                   style={`border-color: ${mainPageBorderColor(store, itemState.get)}; background-color: #fafafa; ` +
                          `border-left-width: ${mainPageBorderWidth(store)}px; border-bottom-width: ${mainPageBorderWidth(store)}px; ` +
                          `align-items: baseline;`}>

                <Show when={store.umbrellaVisualElement.get().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
                  <Switch fallback={<div id="toolbarItemOptionsDiv">[no context]</div>}>
                    <Match when={isPage(store.history.getFocusItem())}>
                      <Toolbar_Page />
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
                  </Switch>
                </Show>

                <div class="flex-grow-0 ml-[7px] mr-[7px] relative" style="flex-order: 1; height: 25px;">
                  {/* TODO (LOW): line is currently drawn below as a fixed element 'cause i can't get the alignment right if done here. */}
                </div>

                <div class="flex-grow-0 pr-[8px]" style="flex-order: 2;">
                  <Show when={!store.user.getUserMaybe()}>
                    <InfuIconButton icon="fa fa-sign-in" highlighted={false} clickHandler={handleLogin} />
                  </Show>
                  <Show when={store.user.getUserMaybe()}>
                    <InfuIconButton icon="fa fa-user" highlighted={false} clickHandler={showUserSettings} />
                  </Show>
                  <div class="inline-block">
                    <InfuIconButton icon="fa fa-chevron-up" highlighted={false} clickHandler={hideToolbar} />
                  </div>
                </div>

              </div>

            </div>
          </div>

          <div class="fixed border-r border-slate-300" style="height: 25px; right: 62px; top: 7px;"></div>

        </div>
      </Show>

      <Show when={!store.topToolbarVisible.get()}>
        <div class="absolute"
             style={`z-index: ${Z_INDEX_SHOW_TOOLBAR_ICON}; ` +
                    `right: 6px; top: -3px;`} onmousedown={showToolbar}>
          <i class={`fa fa-chevron-down hover:bg-slate-300 p-[2px] text-xs ${!store.dockVisible.get() ? 'text-white' : 'text-slate-400'}`} />
        </div>
      </Show>
    </>
  );
}
