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
import { logout } from "../Main";
import { NONE_VISUAL_ELEMENT } from '../../layout/visual-element';
import { useUserStore } from '../../store/UserStoreProvider';
import { switchToPage } from '../../layout/navigation';
import { useNavigate } from '@solidjs/router';
import { itemState } from '../../store/ItemState';
import { editDialogSizePx } from '../edit/EditDialog';


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

  const handleBack = () => {
    console.log("back");
  };

  const handleUp = () => {
    console.log("up");
  }

  const handleLogin = () => {
    navigate("/login");
  }

  const bgColIdx = () => asPageItem(desktopStore.topLevelVisualElement()!.displayItem).backgroundColorIndex;

  const titleClick = () => {
    desktopStore.setEditDialogInfo({
      desktopBoundsPx: {
        x: 40,
        y: 40,
        w: editDialogSizePx.w,
        h: editDialogSizePx.h
      },
      item: itemState.get(desktopStore.currentPage()!.itemId)!
    });
  }

  const titleText = () => {
    const text = asPageItem(desktopStore.topLevelVisualElement()!.displayItem).title;
    if (text == "") {
      return "[empty]";
    }
    return text;
  }

  return (
    <Show when={desktopStore.topLevelVisualElement().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
      <div class="fixed left-0 top-0 bottom-0 border-r border-gray-800 text-gray-100"
          style={`background-image: linear-gradient(270deg, ` +
                 `${hexToRGBA(Colors[bgColIdx()], 0.786)}, ` +
                 `${hexToRGBA(Colors[bgColIdx()], 0.864)}); ` +
                 `width: ${MAIN_TOOLBAR_WIDTH_PX}px`}>
        <a href="/"><img src={imgUrl} class="w-[28px] mt-[12px] ml-[5px]" /></a>
        <div class="mt-[16px] uppercase rotate-90 whitespace-pre text-[22px] cursor-pointer" onClick={titleClick}>
          {titleText()}
        </div>
        <div class="absolute bottom-0">
          <div class="ml-[12px] mb-[12px]">
            <i class="fa fa-search cursor-pointer" onclick={handleUp} />
          </div>
          <div class="ml-[12px] mb-[12px]">
            <i class="fa fa-arrow-circle-up cursor-pointer" onclick={handleUp} />
          </div>
          <div class="ml-[12px] mb-[12px]">
            <i class="fa fa-arrow-circle-left cursor-pointer" onclick={handleBack} />
          </div>
          <Show when={userStore.getUserMaybe()}>
            {/* <div class="ml-[12px] mb-[12px]">
              <i class="fa fa-cog cursor-pointer" onclick={handleUp} />
            </div> */}
            <div class="ml-[12px] mb-[12px]">
              <i class="fa fa-home cursor-pointer" onclick={handleHome} />
            </div>
            <div class="ml-[12px] mb-[12px]">
              <i class="fa fa-user cursor-pointer" onclick={logout!} />
            </div>
          </Show>
          <Show when={!userStore.getUserMaybe()}>
            <div class="ml-[12px] mb-[12px]">
              <i class="fa fa-sign-in cursor-pointer" onclick={handleLogin} />
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
