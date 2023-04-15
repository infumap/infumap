/*
  Copyright (C) 2023 The Infumap Authors
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

import { Component, onMount, Show } from "solid-js";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { boundingBoxFromPosSize, getBoundingBoxTopLeft, getBoundingBoxSize } from "../../util/geometry";
import { EditItem } from "./EditItem";


export const editDialogSizePx = { w: 400, h: 400 };

export const EditDialogInner: Component = () => {
  const generalStore = useGeneralStore();
  const desktopStore = useDesktopStore();

  let editDialogDiv: HTMLDivElement | undefined;

  onMount(() => {
    let posPx = {
      x: (desktopStore.desktopBoundsPx().w / 2.0) - 200,
      y: 120.0
    };
    generalStore.setEditDialogInfo({ item: item(), desktopBoundsPx: boundingBoxFromPosSize(posPx, { ...editDialogSizePx }) });
  });

  const item = () => generalStore.editDialogInfo()!.item;
  const posPx = () => getBoundingBoxTopLeft(generalStore.editDialogInfo()!.desktopBoundsPx);
  const sizePx = () => getBoundingBoxSize(generalStore.editDialogInfo()!.desktopBoundsPx);

  return (
    <>
      <div class="absolute text-xl font-bold z-10 rounded-md p-8 blur-md"
           style={`left: ${posPx().x}px; top: ${posPx().y}px; width: ${sizePx().w}px; height: ${sizePx().h}px; background-color: #303030d0;`}>
      </div>
      <div ref={editDialogDiv}
           class="absolute bg-white z-20 rounded-md border border-slate-700"
           style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: ${sizePx().w-20.0}px; height: ${sizePx().h-20.0}px;`}>
        <EditItem item={item()} />
      </div>
    </>
  );
}

export const EditDialog: Component = () => {
  const generalStore = useGeneralStore();

  return (
    <Show when={generalStore.editDialogInfo() != null}>
      <EditDialogInner />
    </Show>
  );
}