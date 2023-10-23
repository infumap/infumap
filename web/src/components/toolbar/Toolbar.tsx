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

import { Component, Show } from "solid-js";
import { MAIN_TOOLBAR_WIDTH_PX, ROOT_USERNAME } from "../../constants";
import { asPageItem } from "../../items/page-item";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { Colors } from "../../style";
import { hexToRGBA } from "../../util/color";
import { NONE_VISUAL_ELEMENT } from '../../layout/visual-element';
import { useUserStore } from '../../store/UserStoreProvider';
import { navigateBack, navigateUp, switchToPage } from '../../layout/navigation';
import { useNavigate } from '@solidjs/router';
import { initialEditUserSettingsBounds } from '../overlay/UserSettings';


export const Toolbar: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();
  const navigate = useNavigate();

  const handleHome = () => {
    const userMaybe = userStore.getUserMaybe();
    if (!userMaybe) {
      window.history.pushState(null, "", "/");
    } else {
      switchToPage(desktopStore, userStore, { itemId: userStore.getUser().homePageId, linkIdMaybe: null }, false);
      if (userMaybe.username == ROOT_USERNAME) {
        window.history.pushState(null, "", "/");
      } else {
        window.history.pushState(null, "", `/${userMaybe.username}`);
      }
    }
  }

  const handleBack = () => navigateBack(desktopStore, userStore);

  const handleUp = () => navigateUp(desktopStore, userStore);

  const handleLogin = () => {
    navigate("/login");
  }

  const bgColIdx = () => asPageItem(desktopStore.topLevelVisualElement()!.displayItem).backgroundColorIndex;

  const handleSearchClick = () => {
    desktopStore.setSearchOverlayVisible(!desktopStore.searchOverlayVisible())
  };

  const showUserSettings = () => {
    desktopStore.setEditUserSettingsInfo({ desktopBoundsPx: initialEditUserSettingsBounds(desktopStore) });
  }

  return (
    <Show when={desktopStore.topLevelVisualElement().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
      <div class="fixed left-0 top-0 bottom-0 border-r border-gray-800 text-gray-100"
          style={`background-image: linear-gradient(270deg, ` +
                 `${hexToRGBA(Colors[bgColIdx()], 0.786)}, ` +
                 `${hexToRGBA(Colors[bgColIdx()], 0.864)}); ` +
                 `width: ${MAIN_TOOLBAR_WIDTH_PX}px`}>
        <a href="/"><img src={imgUrl} class="w-[28px] mt-[12px] ml-[6px]" /></a>
        <Show when={userStore.getUserMaybe()}>
          <div class="ml-[11px] mt-[12px]">
            <i class="fa fa-home cursor-pointer" onclick={handleHome} />
          </div>
        </Show>
        <div class="ml-[11px] mt-[12px]">
          <i class="fa fa-search cursor-pointer" onclick={handleSearchClick} />
        </div>
        <div class="ml-[11px] mt-[12px]">
          <i class="fa fa-arrow-circle-up cursor-pointer" onclick={handleUp} />
        </div>
        <div class="ml-[11px] mt-[12px]">
          <i class="fa fa-arrow-circle-left cursor-pointer" onclick={handleBack} />
        </div>
      <div class="absolute bottom-0">
      <Show when={!userStore.getUserMaybe()}>
            <div class="ml-[11px] mt-[12px] mb-[12px]">
              <i class="fa fa-sign-in cursor-pointer" onclick={handleLogin} />
            </div>
          </Show>
        <Show when={userStore.getUserMaybe()}>
          <div class="ml-[12px] mt-[12px] mb-[12px]">
            <i class="fa fa-user cursor-pointer" onclick={showUserSettings!} />
          </div>
        </Show>
      </div>
      </div>
    </Show>
  );
}
