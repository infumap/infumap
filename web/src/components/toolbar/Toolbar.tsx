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
import { TOP_TOOLBAR_HEIGHT_PX } from "../../constants";
import { Toolbar_Note } from "./Toolbar_Note";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { initialEditUserSettingsBounds } from "../overlay/UserSettings";
import { useNavigate } from "@solidjs/router";
import { itemState } from "../../store/ItemState";
import { asPageItem } from "../../items/page-item";
import { hexToRGBA } from "../../util/color";
import { Colors, linearGradient } from "../../style";
import { Toolbar_Note_Info } from './Toolbar_Note_Info';
import { InfuIconButton } from '../library/InfuIconButton';
import { Toolbar_Page } from './Toolbar_Page';
import { Toolbar_Page_Info } from './Toolbar_Page_Info';
import { Toolbar_Table } from './Toolbar_Table';
import { Toolbar_Table_Info } from './Toolbar_Table_Info';


export const Toolbar: Component = () => {
  const store = useStore();

  const navigate = useNavigate();

  const handleLogin = () => navigate("/login");

  const showUserSettings = () => { store.overlay.editUserSettingsInfo.set({ desktopBoundsPx: initialEditUserSettingsBounds(store) }); }

  const currentPageMaybe = () => {
    if (store.history.currentPage() == null) { return null; }
    return asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
  }

  const title = () => {
    if (currentPageMaybe() == null) { return ""; }
    return currentPageMaybe()!.title;
  }

  const mainTitleColor = () => {
    // item state is not solid-js signals.
    // as a bit of a hack, change in color is signalled by re-setting this instead.
    store.overlay.toolbarOverlayInfoMaybe.get();
    return `${hexToRGBA(Colors[currentPageMaybe() == null ? 0 : currentPageMaybe()!.backgroundColorIndex], 1.0)}; `
  };

  const pageColor = () => {
    store.overlay.toolbarOverlayInfoMaybe.get();
    if (currentPageMaybe() == null) { return ''; }
    return `background-image: ${linearGradient(currentPageMaybe()!.backgroundColorIndex, 0.95)};`
  }

  return (
    <div class="fixed right-0 top-0 border-b border-slate-300"
         style={`left: 0px; ` +
                `height: ${TOP_TOOLBAR_HEIGHT_PX}px; 0px; `}>

      <div class="fixed left-0 top-0 border-r border-b border-slate-300 overflow-hidden bg-slate-100"
           style={`width: ${store.dockWidthPx.get()}px; height: ${TOP_TOOLBAR_HEIGHT_PX}px;`}>
        <div style={'width: 160px; margin-top: 4px; margin-left: 6px;'}>
          <div class="align-middle inline-block" style="margin-top: -3px; margin-left: 2px;"><a href="/"><img src={imgUrl} class="w-[28px] inline-block" /></a></div>
          <Toolbar_Navigation />
        </div>
      </div>

      <div class="fixed right-[10px] top-[0px] rounded-lg" style={`left: ${store.dockWidthPx.get()}px; ${pageColor()}`}>
        <div class="flex flex-row flex-nowrap">
          <div class="font-bold p-[4px] ml-[6px] inline-block" style={`font-size: 22px; color: ${mainTitleColor()}`}>
            {title()}
          </div>
          <Show when={store.topLevelVisualElement.get().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
            <Switch>
              <Match when={store.overlay.noteEditOverlayInfo.get() != null}>
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Note />
                {/* <Toolbar_Note_Info /> */}
              </Match>
              <Match when={store.overlay.tableEditOverlayInfo.get() != null}>
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Table />
                {/* <Toolbar_Table_Info /> */}
              </Match>
              {/* default */}
              <Match when={store.overlay.noteEditOverlayInfo.get() == null}>
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Page />
                {/* <Toolbar_Page_Info /> */}
              </Match>
            </Switch>
          </Show>
          <div class="float-right p-[8px]">
            <Show when={!store.user.getUserMaybe()}>
              <InfuIconButton icon="fa fa-sign-in" highlighted={false} clickHandler={handleLogin} />
            </Show>
            <Show when={store.user.getUserMaybe()}>
              <InfuIconButton icon="fa fa-user" highlighted={false} clickHandler={showUserSettings} />
            </Show>
          </div>
        </div>
      </div>

    </div>
  );
}
