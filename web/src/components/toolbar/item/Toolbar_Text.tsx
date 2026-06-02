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
import { useStore } from "../../../store/StoreProvider";
import { InfuIconButton } from "../../library/InfuIconButton";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { TextFns, asTextItem } from "../../../items/text-item";
import { materializeTextDocumentPageAndOpen } from "../../../items/text-document";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { getToolbarFocusItem } from "../toolbarFocus";


export const Toolbar_Text: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;
  let iconDiv: HTMLDivElement | undefined;

  const textItem = () => asTextItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(textItem());

  const iconVisible = (): boolean => {
    return TextFns.showsIcon(textItem());
  }

  const iconButtonHandler = (): void => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.ItemIcon) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: iconDiv!.getBoundingClientRect().x, y: iconDiv!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.ItemIcon });
  };
  const handleIconDown = () => {
    ClickState.setButtonClickBoundsPx(iconDiv!.getBoundingClientRect());
  };

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
    navigator.clipboard.writeText(textItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "text id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const handleCreateDocumentPage = () => {
    void materializeTextDocumentPageAndOpen(store, textItem());
  };

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <div ref={iconDiv} class="inline-block pl-[2px]" onMouseDown={handleIconDown}>
            <InfuIconButton icon="fa fa-font" highlighted={iconVisible()} clickHandler={iconButtonHandler} />
          </div>
        </Show>

        <Toolbar_ItemOrdering />

        <div class="inline-block pl-[2px]">
          <InfuIconButton icon="fa fa-clone" highlighted={false} clickHandler={handleCreateDocumentPage} title="Create document page" />
        </div>

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

        <div ref={qrDiv} class="inline-block pl-[18px]" onMouseDown={handleQrDown}>
          <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
        </div>

      </div>
    </div>
  );
}
