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

import { Component, onCleanup, onMount, Show } from "solid-js";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { desktopPxFromMouseEvent, subtract, add, Vector } from "../../util/geometry";
import { EditItem } from "./EditItem";


export const EditDialogInner: Component = () => {
  const generalStore = useGeneralStore();
  const desktopStore = useDesktopStore();

  let editDialogDiv: HTMLDivElement | undefined;

  let lastMousePosPx: Vector | null = null;

  let mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    lastMousePosPx = desktopPxFromMouseEvent(ev);
  };

  let mouseMoveListener = (ev: MouseEvent) => {
    // TODO (MEDIUM): this really needs to be managed by a global mouse handler, because the mouse can
    //                move outside the dialog area and stop triggering move events.
    if (ev.buttons == 1) { // left mouse down.
      let currentMousePosPx = desktopPxFromMouseEvent(ev);
      let changePx = subtract(currentMousePosPx, lastMousePosPx!)
      generalStore.setEditDialogInfo(({ item: item(), posPx: add(generalStore.editDialogInfo()!.posPx, changePx) }));
      lastMousePosPx = currentMousePosPx;
    }
  };

  onMount(() => {
    editDialogDiv!.addEventListener('mousedown', mouseDownListener);
    editDialogDiv!.addEventListener('mousemove', mouseMoveListener);
    let posPx = {
      x: (desktopStore.desktopBoundsPx().w / 2.0) - 200,
      y: 120.0
    };
    generalStore.setEditDialogInfo({ item: item(), posPx });
  });

  onCleanup(() => {
    editDialogDiv!.removeEventListener('mousedown', mouseDownListener);
    editDialogDiv!.removeEventListener('mousemove', mouseMoveListener);
  });

  const item = () => generalStore.editDialogInfo()!.item;
  const posPx = () => generalStore.editDialogInfo()!.posPx;

  return (
    <>
      <div class="absolute text-xl font-bold z-10 rounded-md p-8 blur-md"
           style={`left: ${posPx().x}px; top: ${posPx().y}px; width: 400px; height: 400px; background-color: #303030d0;`}>
      </div>
      <div ref={editDialogDiv}
           class="absolute bg-white z-20 rounded-md border border-slate-700"
           style={`left: ${posPx().x+10.0}px; top: ${posPx().y+10}px; width: 380px; height: 380px;`}>
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