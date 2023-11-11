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

import imgUrl from '../../../assets/circle.png'

import { Component, Show } from "solid-js";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { NONE_VISUAL_ELEMENT } from "../../../layout/visual-element";
import { LEFT_TOOLBAR_WIDTH_PX, TOP_TOOLBAR_HEIGHT_PX } from "../../../constants";
import { Toolbar_TextEdit } from "./Toolbar_TextEdit";
import { Toolbar_Navigation } from "./Toolbar_Navigation";
import { useUserStore } from "../../../store/UserStoreProvider"
import { initialEditUserSettingsBounds } from "../../overlay/UserSettings";
import { useNavigate } from "@solidjs/router";
import { itemState } from "../../../store/ItemState";
import { asPageItem } from "../../../items/page-item";
import { hexToRGBA } from "../../../util/color";
import { Colors } from "../../../style";

export const Toolbar_Top: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();
  const navigate = useNavigate();

  const handleLogin = () => navigate("/login");
  const showUserSettings = () => { desktopStore.setEditUserSettingsInfo({ desktopBoundsPx: initialEditUserSettingsBounds(desktopStore) }); }

  const currentPageMaybe = () => {
    if (desktopStore.currentPage() == null) { return null; }
    return asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  }

  const title = () => {
    if (currentPageMaybe() == null) { return ""; }
    return currentPageMaybe()!.title;
  }

  const fullTitleColor = () => `${hexToRGBA(Colors[currentPageMaybe() == null ? 0 : currentPageMaybe()!.backgroundColorIndex], 1.0)}; `;

  return (
    <div class="fixed right-0 top-0"
         style={`background-color: #f9fbfd; ` +
                `left: ${LEFT_TOOLBAR_WIDTH_PX}px; ` +
                `height: ${TOP_TOOLBAR_HEIGHT_PX}px; ${LEFT_TOOLBAR_WIDTH_PX}px; `}>
      <div class="fixed right-0 top-0" style={`left: ${LEFT_TOOLBAR_WIDTH_PX + 10}px; `}>
        <a href="/"><img src={imgUrl} class="w-[28px] inline-block" /></a>
        <span class="font-bold" style={`font-size: 22px; color: ${fullTitleColor()}`}>{title()}</span>
        <div class="float-right">
          <Show when={!userStore.getUserMaybe()}>
            <i class="fa fa-sign-in cursor-pointer" onclick={handleLogin} />
          </Show>
          <Show when={userStore.getUserMaybe()}>
            <i class="fa fa-user cursor-pointer" onclick={showUserSettings!} />
          </Show>
        </div>
      </div>

      <div class="fixed right-0 top-[35px]" style={`left: ${LEFT_TOOLBAR_WIDTH_PX + 10}px; background-color: #edf2fa;`}>
        <Toolbar_Navigation />
        <Show when={desktopStore.topLevelVisualElement().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
          <Show when={desktopStore.textEditOverlayInfo() != null}>
            <Toolbar_TextEdit />
          </Show>
        </Show>
      </div>

    </div>
  );
}
