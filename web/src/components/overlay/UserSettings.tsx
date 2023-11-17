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
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { boundingBoxFromPosSize, getBoundingBoxTopLeft, getBoundingBoxSize } from "../../util/geometry";
import { LEFT_TOOLBAR_WIDTH_PX } from "../../constants";
import { logout } from "../Main";
import { InfuButton } from "../library/InfuButton";


const DIALOG_WIDTH_PX = 400;

export const editUserSettingsSizePx = { w: DIALOG_WIDTH_PX, h: 500 };

export function initialEditUserSettingsBounds(store: StoreContextModel) {
  let posPx = {
    x: (store.desktopBoundsPx().w) / 2.0 + LEFT_TOOLBAR_WIDTH_PX - DIALOG_WIDTH_PX / 2.0,
    y: 120.0
  };
  return boundingBoxFromPosSize(posPx, { ...editUserSettingsSizePx }); 
}

export const EditUserSettings: Component = () => {
  const store = useStore();

  let editUserSettingsDiv: HTMLDivElement | undefined;

  const posPx = () => getBoundingBoxTopLeft(store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx);
  const sizePx = () => getBoundingBoxSize(store.overlay.editUserSettingsInfo.get()!.desktopBoundsPx);

  const copyClickHandler = () => {
    navigator.clipboard.writeText(store.user.getUser().userId);
  }

  const logoutHandler = () => {
    store.overlay.editUserSettingsInfo.set(null);
    logout!();
  }

  return (
    <>
      <div class="fixed text-xl font-bold z-10 rounded-md p-8 blur-md"
           style={`left: ${posPx().x}px; top: ${posPx().y}px; width: ${sizePx().w}px; height: ${sizePx().h}px; background-color: #303030d0;`}>
      </div>
      <div ref={editUserSettingsDiv}
           class="fixed bg-white z-20 rounded-md border border-slate-700"
           style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: ${sizePx().w-20.0}px; height: ${sizePx().h-20.0}px;`}>

        <div class="p-3">
          <div class="font-bold">Edit User Settings: {store.user.getUser().username}</div>
          <div class="text-slate-800 text-sm">
            <span class="font-mono text-slate-400">{`${store.user.getUser().userId}`}</span>
            <i class={`fa fa-copy text-slate-400 cursor-pointer ml-1`} onclick={copyClickHandler} />
          </div>
          <div style="margin-top: 10px;">
            <InfuButton text="logout" onClick={logoutHandler} />
          </div>
        </div>
      </div>
    </>
  );
}
