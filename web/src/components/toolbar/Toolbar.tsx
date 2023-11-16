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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { NONE_VISUAL_ELEMENT } from "../../layout/visual-element";
import { LEFT_TOOLBAR_WIDTH_PX, TOP_TOOLBAR_HEIGHT_PX } from "../../constants";
import { Toolbar_Note } from "./Toolbar_Note";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { initialEditUserSettingsBounds } from "../overlay/UserSettings";
import { useNavigate } from "@solidjs/router";
import { itemState } from "../../store/ItemState";
import { asPageItem } from "../../items/page-item";
import { hexToRGBA } from "../../util/color";
import { Colors } from "../../style";
import { Toolbar_Note_Info } from './Toolbar_Note_Info';
import { InfuIconButton } from '../library/InfuIconButton';
import { Toolbar_Page } from './Toolbar_Page';
import { Toolbar_Page_Info } from './Toolbar_Page_Info';
import { Toolbar_Table } from './Toolbar_Table';
import { Toolbar_Table_Info } from './Toolbar_Table_Info';


export const Toolbar: Component = () => {
  const desktopStore = useDesktopStore();

  const navigate = useNavigate();

  const handleLogin = () => navigate("/login");

  const showUserSettings = () => { desktopStore.editUserSettingsInfo.set({ desktopBoundsPx: initialEditUserSettingsBounds(desktopStore) }); }

  const currentPageMaybe = () => {
    if (desktopStore.currentPage() == null) { return null; }
    return asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  }

  const title = () => {
    if (currentPageMaybe() == null) { return ""; }
    return currentPageMaybe()!.title;
  }

  const mainTitleColor = () => {
    // item state is not solid-js signals.
    // as a bit of a hack, change in color is signalled by re-setting this instead.
    desktopStore.pageColorOverlayInfoMaybe.get();
    return `${hexToRGBA(Colors[currentPageMaybe() == null ? 0 : currentPageMaybe()!.backgroundColorIndex], 1.0)}; `
  };

  return (
    <div class="fixed right-0 top-0"
         style={`background-color: #f9fbfd; ` +
                `left: ${LEFT_TOOLBAR_WIDTH_PX}px; ` +
                `height: ${TOP_TOOLBAR_HEIGHT_PX}px; ${LEFT_TOOLBAR_WIDTH_PX}px; `}>

      <div class="fixed top-0" style={`left: ${LEFT_TOOLBAR_WIDTH_PX + 10}px; right: ${10}px;`}>
        <div class="align-middle inline-block" style="margin-top: -3px; margin-left: 2px;"><a href="/"><img src={imgUrl} class="w-[28px] inline-block" /></a></div>
        <div class="inline-block pl-1"></div>
        <div class="font-bold p-[4px] inline-block" style={`font-size: 22px; color: ${mainTitleColor()}`}>
          {title()}
        </div>
        <div class="float-right p-[8px]">
          <Show when={!desktopStore.userStore.getUserMaybe()}>
            <InfuIconButton icon="fa fa-sign-in" highlighted={false} clickHandler={handleLogin} />
          </Show>
          <Show when={desktopStore.userStore.getUserMaybe()}>
            <InfuIconButton icon="fa fa-user" highlighted={false} clickHandler={showUserSettings} />
          </Show>
        </div>
      </div>

      <div class="fixed right-[10px] top-[42px] rounded-lg" style={`left: ${LEFT_TOOLBAR_WIDTH_PX + 10}px; background-color: #edf2fa;`}>
        <div class="flex flex-row flex-nowrap">
          <Toolbar_Navigation />
          <Show when={desktopStore.topLevelVisualElement.get().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
            <Switch>
              <Match when={desktopStore.noteEditOverlayInfo.get() != null}>
                <Toolbar_Note />
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Note_Info />
              </Match>
              <Match when={desktopStore.tableEditOverlayInfo.get() != null}>
                <Toolbar_Table />
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Table_Info />
              </Match>
              {/* default */}
              <Match when={desktopStore.noteEditOverlayInfo.get() == null}>
                <Toolbar_Page />
                <div class="inline-block" style="flex-grow: 1"></div>
                <Toolbar_Page_Info />
              </Match>
            </Switch>
          </Show>
        </div>
      </div>

    </div>
  );
}
