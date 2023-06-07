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

import imgUrl from '../assets/circle.png'

import { Component, Show } from "solid-js";
import { TOOLBAR_WIDTH } from "../constants";
import { asPageItem } from "../items/page-item";
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { Colors } from "../style";
import { hexToRGBA } from "../util/color";
import { logout } from "./Main";
import { NONE_VISUAL_ELEMENT } from '../layout/visual-element';


export const Toolbar: Component = () => {
  const desktopStore = useDesktopStore();

  return (
    <Show when={desktopStore.topLevelVisualElement().item.itemType != NONE_VISUAL_ELEMENT.item.itemType}>
      <div class="fixed left-0 top-0 bottom-0 border-r border-gray-800 text-gray-100"
          style={`background-image: linear-gradient(270deg, ` +
                 `${hexToRGBA(Colors[asPageItem(desktopStore.topLevelVisualElement()!.item).backgroundColorIndex], 0.786)}, ` +
                 `${hexToRGBA(Colors[asPageItem(desktopStore.topLevelVisualElement()!.item).backgroundColorIndex], 0.864)}); ` +
                 `width: ${TOOLBAR_WIDTH}px`}>
        <img src={imgUrl} class="w-[28px] mt-[12px] ml-[5px]" />
        <div class="mt-[16px] uppercase rotate-90 whitespace-pre text-[22px]">
          {asPageItem(desktopStore.topLevelVisualElement()!.item).title}
        </div>
        <div class="absolute bottom-0">
          <div class="ml-[12px] mb-[12px]">
            <i class="fa fa-user cursor-pointer" onclick={logout!} />
          </div>
        </div>
      </div>
    </Show>
  );
}
