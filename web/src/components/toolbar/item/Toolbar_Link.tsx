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

import { Component, onCleanup, onMount } from "solid-js";
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { asLinkItem } from "../../../items/link-item";
import { fullArrange } from "../../../layout/arrange";
import { serverOrRemote } from "../../../server";
import { ClickState } from "../../../input/state";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";


export const Toolbar_Link: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;
  let linkResourceInput: HTMLInputElement | undefined;

  const linkItem = () => asLinkItem(store.history.getFocusItem());
  const linkItemOnMount = linkItem();

  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  }
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(linkItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "link id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  onMount(() => {
    linkResourceInput!.value = linkItem().linkTo;
    linkResourceInput!.focus();
  });

  onCleanup(() => {
    linkItemOnMount.linkTo = linkResourceInput!.value;
    fullArrange(store);
    serverOrRemote.updateItem(linkItemOnMount, store.general.networkStatus);
  });

  const keyEventHandler = (_ev: KeyboardEvent) => { }

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0">
      <div class="inline-block">
        <div class="inline-block ml-[8px]">
          <span class="mr-[6px]">link to:</span>
          <input ref={linkResourceInput}
                 class="pl-[7px] pt-[4px] pb-[4px] w-[420px] text-slate-800 font-mono text-sm"
                 type="text"
                 spellcheck={false}
                 onKeyDown={keyEventHandler}
                 onKeyUp={keyEventHandler}
                 onKeyPress={keyEventHandler} />
        </div>

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

        <div ref={qrDiv} class="inline-block pl-[20px]" onMouseDown={handleQrDown}>
          <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
        </div>
      </div>
    </div>
  );
}
