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
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { asDividerItem, DividerDirection } from "../../../items/divider-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../../items/page-item";
import { requestArrange } from "../../../layout/arrange";
import { VeFns } from "../../../layout/visual-element";
import { VesCache } from "../../../layout/ves-cache";
import { serverOrRemote } from "../../../server";
import { ToolbarPopupType, TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { useStore } from "../../../store/StoreProvider";
import { ClickState } from "../../../input/state";
import { InfuIconButton } from "../../library/InfuIconButton";
import { getToolbarFocusItem, getToolbarFocusPathMaybe } from "../toolbarFocus";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";


export const Toolbar_Divider: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;

  const dividerItem = () => asDividerItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(dividerItem());
  const isInDocumentPage = () => {
    const focusPath = getToolbarFocusPathMaybe(store);
    if (focusPath == null) { return false; }
    const parentPath = VeFns.parentPath(focusPath);
    if (parentPath == null || parentPath == "") { return false; }
    const parentVe = VesCache.current.readNode(parentPath);
    return parentVe != null &&
      isPage(parentVe.displayItem) &&
      asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document;
  };

  const setDirection = (direction: DividerDirection) => {
    const item = dividerItem();
    if (item.dividerDirection == direction) { return; }
    item.dividerDirection = direction;
    const oldWidthGr = item.spatialWidthGr;
    item.spatialWidthGr = item.spatialHeightGr;
    item.spatialHeightGr = oldWidthGr;
    requestArrange(store, "toolbar-divider-direction");
    serverOrRemote.updateItem(item, store.general.networkStatus);
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
    navigator.clipboard.writeText(dividerItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "divider id -> clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit() && !isInDocumentPage()}>
          <div class="inline-block ml-[10px] mr-[4px] align-middle">
            <InfuIconButton
              icon="fa fa-arrows-h"
              highlighted={dividerItem().dividerDirection == "horizontal"}
              title="Horizontal divider"
              clickHandler={() => setDirection("horizontal")} />
            <InfuIconButton
              icon="fa fa-arrows-v"
              highlighted={dividerItem().dividerDirection == "vertical"}
              title="Vertical divider"
              clickHandler={() => setDirection("vertical")} />
          </div>
        </Show>

        <Toolbar_ItemOrdering />

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
