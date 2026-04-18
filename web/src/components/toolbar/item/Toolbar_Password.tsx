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
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { asPasswordItem } from "../../../items/password-item";
import { PasswordFlags } from "../../../items/base/flags-item";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { requestArrange } from "../../../layout/arrange";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";


export const Toolbar_Password: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;

  const passwordItem = () => asPasswordItem(store.history.getFocusItem());

  const desktopPopupIconVisible = (): boolean => {
    return !!(passwordItem().flags & PasswordFlags.ShowDesktopPopupIcon);
  }

  const desktopPopupIconButtonHandler = (): void => {
    if (desktopPopupIconVisible()) {
      passwordItem().flags &= ~PasswordFlags.ShowDesktopPopupIcon;
    } else {
      passwordItem().flags |= PasswordFlags.ShowDesktopPopupIcon;
    }
    requestArrange(store, "toolbar-password-desktop-popup-icon");
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
    navigator.clipboard.writeText(passwordItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "password id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <div class="inline-block pl-[2px]">
          <InfuIconButton icon="fa fa-eye-slash" highlighted={desktopPopupIconVisible()} clickHandler={desktopPopupIconButtonHandler} />
        </div>

        <Toolbar_ItemOrdering />

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
