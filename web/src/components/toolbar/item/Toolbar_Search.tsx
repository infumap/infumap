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
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { ClickState } from "../../../input/state";
import { ToolbarPopupType, TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { ArrangeAlgorithm } from "../../../items/page-item";
import { asSearchItem } from "../../../items/search-item";


export const Toolbar_Search: Component = () => {
  const store = useStore();

  let arrangeAlgoDiv: HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;

  const searchItem = () => asSearchItem(store.history.getFocusItem());

  const handleArrangeAlgoClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null &&
      store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.SearchArrangeAlgorithm) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set({
      topLeftPx: { x: arrangeAlgoDiv!.getBoundingClientRect().x, y: arrangeAlgoDiv!.getBoundingClientRect().y + 35 },
      type: ToolbarPopupType.SearchArrangeAlgorithm
    });
  };

  const handleArrangeAlgoDown = () => {
    ClickState.setButtonClickBoundsPx(arrangeAlgoDiv!.getBoundingClientRect());
  };

  const arrangeAlgoText = () => {
    const aa = store.perItem.getSearchArrangeAlgorithm(searchItem().id);
    return aa == ArrangeAlgorithm.Grid ? "grid" : "catalog";
  };

  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null &&
      store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  };

  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(searchItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "search id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <div ref={arrangeAlgoDiv}
          class="inline-block w-[88px] border border-slate-400 rounded-md ml-[10px] cursor-pointer text-center align-middle"
          style={`font-size: 13px;`}
          onMouseDown={handleArrangeAlgoDown}
          onClick={handleArrangeAlgoClick}>
          {arrangeAlgoText()}
        </div>

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
