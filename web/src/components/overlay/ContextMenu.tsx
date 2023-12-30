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
import { useStore } from "../../store/StoreProvider";
import { Vector } from "../../util/geometry";
import { HitInfo } from "../../input/hit";
import { InfuIconButton } from "../library/InfuIconButton";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { newItemInContext } from "../../input/create";


type ContexMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};


export const AddItem: Component<ContexMenuProps> = (props: ContexMenuProps) => {
  const store = useStore();

  const newPageInContext = () => newItemInContext(store, "page", props.hitInfo, props.desktopPosPx);
  const newNoteInContext = () => newItemInContext(store, "note", props.hitInfo, props.desktopPosPx);
  const newTableInContext = () => newItemInContext(store, "table", props.hitInfo, props.desktopPosPx);
  const newRatingInContext = () => newItemInContext(store, "rating", props.hitInfo, props.desktopPosPx);
  const newLinkInContext = () => newItemInContext(store, "link", props.hitInfo, props.desktopPosPx);
  const newPasswordInContext = () => newItemInContext(store, "password", props.hitInfo, props.desktopPosPx);
  const newExpressionInContext = () => newItemInContext(store, "expression", props.hitInfo, props.desktopPosPx);

  return (
    <div class="border rounded w-[115px] h-[242px] bg-slate-50 mb-1 shadow-lg">
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] mt-[3px] p-[3px]" onClick={newNoteInContext}>
        <i class="fa fa-sticky-note" /> Note
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newPageInContext}>
        <i class="fa fa-folder" /> Page
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newTableInContext}>
        <i class="fa fa-table" /> Table
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newRatingInContext}>
        <i class="fa fa-star" /> Rating
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newExpressionInContext}>
        <span class="w-[16px] h-[16px] inline-block text-center relative">∑</span> Expression
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newLinkInContext}>
        <i class="fa fa-link" /> Rating
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[5px] mr-[5px] p-[3px]" onClick={newPasswordInContext}>
        <i class="fa fa-eye-slash" /> Password
      </div>
      <div class="text-sm ml-[5px] mr-[5px] p-[3px] text-slate-500">
        <i class="fa fa-image" /> Image
      </div>
      <div class="text-sm ml-[5px] mr-[5px] p-[3px] text-slate-500">
        <i class="fa fa-file" /> File
      </div>
    </div>
  );
}


export const ContextMenu: Component = () => {
  const store = useStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) {
      ev.stopPropagation();
    }
  }

  const posPx = () => store.overlay.contextMenuInfo.get()!.posPx;
  const hitInfo = () => store.overlay.contextMenuInfo.get()!.hitInfo;

  return (
    <div class="absolute"
         style={`left: ${posPx().x-10}px; top: ${posPx().y-30}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}
