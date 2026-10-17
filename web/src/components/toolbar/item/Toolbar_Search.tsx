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
import { ClickState } from "../../../input/state";
import { isLiveQueryChat, queryChatHasContent } from "../../../items/chat";
import { asQueryItem } from "../../../items/query-item";
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { getToolbarFocusItem } from "../toolbarFocus";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";


export const Toolbar_Search: Component = () => {
  const store = useStore();
  let openFileDiv: HTMLDivElement | undefined;

  const queryItem = () => asQueryItem(getToolbarFocusItem(store));
  const canOpenChatFile = () => isLiveQueryChat(store, queryItem()) && queryChatHasContent(store, queryItem());

  const handleOpenFile = () => {
    window.open(`/files/${queryItem().id}/chat`, "_blank", "noopener");
  };
  const handleOpenFileDown = () => {
    ClickState.setButtonClickBoundsPx(openFileDiv!.getBoundingClientRect());
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canOpenChatFile()}>
          <div ref={openFileDiv} class="inline-block pl-[2px]" onMouseDown={handleOpenFileDown}>
            <InfuIconButton icon="fa fa-download" highlighted={false} clickHandler={handleOpenFile} title="Open text file" />
          </div>
        </Show>
        <Toolbar_InfoAndId infoClass="inline-block pl-[2px]" />
      </div>
    </div>
  );
}
