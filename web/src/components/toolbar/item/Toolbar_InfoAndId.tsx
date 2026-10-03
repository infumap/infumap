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
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { InfuIconButton } from "../../library/InfuIconButton";
import { toolbarPopupTopPx } from "../toolbarPopupStyle";
import { infoPopupItem } from "../Toolbar_Popup";


/**
 * The info (ⓘ) and id (#) buttons at the right of each item toolbar.
 * Clicking # copies the item id immediately and opens a popup with the QR code and a copy url option.
 */
export const Toolbar_InfoAndId: Component<{ infoClass?: string }> = (props) => {
  const store = useStore();

  let infoDiv: HTMLDivElement | undefined;
  let idDiv: HTMLDivElement | undefined;

  const popupIsOpen = (type: ToolbarPopupType) => store.overlay.toolbarPopupInfoMaybe.get()?.type == type;

  const togglePopup = (type: ToolbarPopupType, buttonDiv: HTMLDivElement): boolean => {
    if (popupIsOpen(type)) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return false;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: buttonDiv.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type });
    return true;
  };

  const handleInfo = () => { togglePopup(ToolbarPopupType.Info, infoDiv!); };
  const handleId = () => {
    if (togglePopup(ToolbarPopupType.Id, idDiv!)) {
      navigator.clipboard.writeText(infoPopupItem(store).id);
    }
  };

  return (
    <>
      <div ref={infoDiv} class={props.infoClass ?? "inline-block pl-[20px]"}
        onMouseDown={() => ClickState.setButtonClickBoundsPx(infoDiv!.getBoundingClientRect())}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleInfo} title="Info" />
      </div>
      <div ref={idDiv} class="inline-block"
        onMouseDown={() => ClickState.setButtonClickBoundsPx(idDiv!.getBoundingClientRect())}>
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleId} title="Copy id" />
      </div>
    </>
  );
}
