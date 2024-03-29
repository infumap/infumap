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
import { useStore } from "../../store/StoreProvider";
import { InfuIconButton } from "../library/InfuIconButton";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";
import { asLinkItem } from "../../items/link-item";
import { arrange } from "../../layout/arrange";
import { server } from "../../server";


export const Toolbar_Link: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;
  let linkResourceInput: HTMLInputElement | undefined;

  const linkItem = () => asLinkItem(store.history.getFocusItem());
  const linkItemOnMount = linkItem();

  const handleQr = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarOverlayType.Ids });
  }

  onMount(() => {
    linkResourceInput!.value = linkItem().linkTo;
    linkResourceInput!.focus();
  });

  onCleanup(() => {
    linkItemOnMount.linkTo = linkResourceInput!.value;
    arrange(store);
    server.updateItem(linkItemOnMount);
  });

  const keyEventHandler = (_ev: KeyboardEvent) => { }

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0">
      <div class="inline-block">
        <div class="inline-block ml-[8px]">
          <span class="mr-[6px]">link to:</span>
          <input ref={linkResourceInput}
                 class="pl-[4px] w-[300px] text-slate-800"
                 type="text"
                 onKeyDown={keyEventHandler}
                 onKeyUp={keyEventHandler}
                 onKeyPress={keyEventHandler} />
        </div>
        <div ref={qrDiv}
             class="pl-[4px] inline-block">
          <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
        </div>
      </div>
    </div>
  );
}
