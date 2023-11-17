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
import { StoreContextModel, useStore } from "../../../store/StoreProvider";
import { boundingBoxFromPosSize, getBoundingBoxTopLeft, getBoundingBoxSize } from "../../../util/geometry";
import { EditItem } from "./EditItem";
import { LEFT_TOOLBAR_WIDTH_PX } from "../../../constants";


const DIALOG_WIDTH_PX = 400;

export const editDialogSizePx = { w: DIALOG_WIDTH_PX, h: 500 };

export function initialEditDialogBounds(store: StoreContextModel) {
  let posPx = {
    x: (store.desktopBoundsPx().w) / 2.0 + LEFT_TOOLBAR_WIDTH_PX - DIALOG_WIDTH_PX / 2.0,
    y: 120.0
  };
  return boundingBoxFromPosSize(posPx, { ...editDialogSizePx }); 
}

export const EditDialog: Component = () => {
  const store = useStore();

  let editDialogDiv: HTMLDivElement | undefined;

  const item = () => store.overlay.editDialogInfo.get()!.item;
  const posPx = () => getBoundingBoxTopLeft(store.overlay.editDialogInfo.get()!.desktopBoundsPx);
  const sizePx = () => getBoundingBoxSize(store.overlay.editDialogInfo.get()!.desktopBoundsPx);

  return (
    <>
      <div class="fixed text-xl font-bold z-10 rounded-md p-8 blur-md"
           style={`left: ${posPx().x}px; top: ${posPx().y}px; width: ${sizePx().w}px; height: ${sizePx().h}px; background-color: #303030d0;`}>
      </div>
      <div ref={editDialogDiv}
           class="fixed bg-white z-20 rounded-md border border-slate-700"
           style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: ${sizePx().w-20.0}px; height: ${sizePx().h-20.0}px;`}>
        <EditItem item={item()} linkedTo={false} />
      </div>
    </>
  );
}
