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

import { Component } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { useUserStore } from "../../store/UserStoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { CursorEventState } from "../../input/state";



export const PageSettingsOverlay: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  let textElement: HTMLTextAreaElement | undefined;

  const mouseDownListener = async (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    const desktopPx = CursorEventState.getLatestDesktopPx();
    // if (isInside(desktopPx, noteVeBoundsPx()) ||
    //     isInside(desktopPx, toolboxBoundsPx()) ||
    //     isInside(desktopPx, formatBoxBoundsPx()) ||
    //     isInside(desktopPx, urlBoxBoundsPx()) ||
    //     (compositeVisualElementMaybe() != null && isInside(desktopPx, compositeToolboxBoundsPx()))) { return; }

    // if (userStore.getUserMaybe() != null && noteItem().ownerId == userStore.getUser().userId) {
    //   server.updateItem(noteVisualElement().displayItem);
    // }
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const keyDownListener = (ev: KeyboardEvent): void => {
  }

  const renderTextArea = () => {
    return (
      <div>sd</div>
    )
  }

  return (
    <div id="pageSettingsOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      {renderTextArea()}
    </div>
  );
}