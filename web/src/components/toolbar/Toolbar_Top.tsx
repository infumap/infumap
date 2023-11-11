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

import { Component, Show } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { useUserStore } from "../../store/UserStoreProvider";
import { NONE_VISUAL_ELEMENT } from "../../layout/visual-element";
import { LEFT_TOOLBAR_WIDTH_PX, TOP_TOOLBAR_HEIGHT_PX } from "../../constants";

export const Toolbar_Top: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  return (
    <Show when={desktopStore.topLevelVisualElement().displayItem.itemType != NONE_VISUAL_ELEMENT.displayItem.itemType}>
      <div class="fixed right-0 top-0 border-r border-gray-800 text-gray-100"
          style={`background-color: #0dd; ` +
                 `left: ${LEFT_TOOLBAR_WIDTH_PX}px; ` +
                 `height: ${TOP_TOOLBAR_HEIGHT_PX}px; `}>

      </div>
    </Show>
  );
}