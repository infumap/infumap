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
import { asRatingItem } from "../../../items/rating-item";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";


export const Toolbar_Rating: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;

  const ratingItem = () => asRatingItem(store.history.getFocusItem());
  const ratingTypeText = () => {
    store.touchToolbarDependency();
    return ratingItem().ratingType;
  }

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
    navigator.clipboard.writeText(ratingItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "rating id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <div class="inline-block">

        <div class="inline-block w-[115px] border border-slate-400 rounded-md ml-[10px] cursor-pointer"
          style={`font-size: 13px;`}>
          <div class="inline-block w-[113px] pl-[6px] hover:bg-slate-300"
            onClick={(e) => {
              if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.RatingType) {
                store.overlay.toolbarPopupInfoMaybe.set(null);
                return;
              }
              store.overlay.toolbarPopupInfoMaybe.set(
                { topLeftPx: { x: (e.currentTarget as HTMLDivElement).getBoundingClientRect().x, y: (e.currentTarget as HTMLDivElement).getBoundingClientRect().y + 35 }, type: ToolbarPopupType.RatingType });
            }}
            onMouseDown={(e) => { ClickState.setButtonClickBoundsPx((e.currentTarget as HTMLDivElement).getBoundingClientRect()); }}>
            {ratingTypeText()}
          </div>
        </div>

        <div ref={qrDiv} class="inline-block pl-[2px]" onMouseDown={handleQrDown}>
          <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
        </div>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
        </div>

      </div>
    </div>
  );
}
