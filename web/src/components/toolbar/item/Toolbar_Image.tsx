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
import { asImageItem } from "../../../items/image-item";
import { VesCache } from "../../../layout/ves-cache";
import { ImageFlags } from "../../../items/base/flags-item";
import { serverOrRemote } from "../../../server";
import { ClickState } from "../../../input/state";
import { fullArrange } from "../../../layout/arrange";
import { InfuButton } from "../../library/InfuButton";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";


export const Toolbar_Image: Component = () => {
  const store = useStore();

  const imageVisualElement = () => VesCache.get(store.history.getFocusPath())!.get();
  const imageItem = () => asImageItem(imageVisualElement().displayItem);

  let qrDiv: HTMLDivElement | undefined;

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
    navigator.clipboard.writeText(imageItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "image id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const borderButtonHandler = () => {
    if (imageItem().flags & ImageFlags.HideBorder) {
      imageItem().flags &= ~ImageFlags.HideBorder;
    } else {
      imageItem().flags |= ImageFlags.HideBorder;
    }
    fullArrange(store);
    serverOrRemote.updateItem(imageItem(), store.general.networkStatus);
  }

  const borderVisible = () => {
    return (imageItem().flags & ImageFlags.HideBorder) ? false : true;
  }

  const cropHandler = () => {
    if (imageItem().flags & ImageFlags.NoCrop) {
      imageItem().flags &= ~ImageFlags.NoCrop;
    } else {
      imageItem().flags |= ImageFlags.NoCrop;
    }
    fullArrange(store);
    serverOrRemote.updateItem(imageItem(), store.general.networkStatus);
  }

  const shouldCropImage = () => {
    return (imageItem().flags & ImageFlags.NoCrop) ? false : true;
  }

  return (
    <div id="toolbarItemOptionsDiv"
         class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <div class="pl-[4px] inline-block">
          <InfuIconButton icon="bi-crop" highlighted={shouldCropImage()} clickHandler={cropHandler} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
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
