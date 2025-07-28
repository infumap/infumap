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
import { asFlipCardItem } from "../../../items/flipcard-item";
import { ClickState } from "../../../input/state";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { InfuColorButton } from "../../library/InfuColorButton";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";


export const Toolbar_FlipCard: Component = () => {
  const store = useStore();

  let qrDiv: HTMLDivElement | undefined;
  let divBeforeColorSelect: HTMLDivElement | undefined;
  let colorSelectDiv: HTMLDivElement | undefined;
  let scaleDiv: HTMLDivElement | undefined;

  const flipCardItem = () => asFlipCardItem(store.history.getFocusItem());

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
    navigator.clipboard.writeText(flipCardItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "flip card id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const colorNumber = () => {
    store.touchToolbarDependency();
    return flipCardItem().backgroundColorIndex;
  }

  const scaleText = () => {
    store.touchToolbarDependency();
    return Math.round(flipCardItem().scale * 1000.0) / 10.0;
  }

  // Color
  const handleColorClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageColor) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: divBeforeColorSelect!.getBoundingClientRect().x + 8, y: divBeforeColorSelect!.getBoundingClientRect().y + 19 }, type: ToolbarPopupType.PageColor });
  };
  const handleColorDown = () => {
    ClickState.setButtonClickBoundsPx(colorSelectDiv!.getBoundingClientRect());
  };

  // Scale
  const handleScaleClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.Scale) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: scaleDiv!.getBoundingClientRect().x, y: scaleDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.Scale });
  };
  const handleScaleDown = () => {
    ClickState.setButtonClickBoundsPx(scaleDiv!.getBoundingClientRect());
  };

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0">
      <div class="inline-block">

      <div ref={scaleDiv}
           class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
           style={`font-size: 13px;`}
           onClick={handleScaleClick}
           onMouseDown={handleScaleDown}>
        <div class="inline-block ml-[4px] mr-[4px]">%</div>
        <div class="inline-block w-[40px] pl-[6px] text-right">
          {scaleText()}
        </div>
      </div>

        <div ref={divBeforeColorSelect} class="inline-block ml-[0px]" />
        <div ref={colorSelectDiv} class="inline-block h-[22px] mt-[2px] ml-[12px] mr-[18px] align-middle" onMouseDown={handleColorDown}>
          <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
        </div>

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

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