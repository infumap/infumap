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

import { Component, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Vector } from "../../util/geometry";
import { HitInfo } from "../../input/hit";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { newItemInContext } from "../../input/create";


type ContextMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};


export const AddItem: Component<ContextMenuProps> = (props: ContextMenuProps) => {
  const store = useStore();

  const newPageInContext = () => newItemInContext(store, "page", props.hitInfo, props.desktopPosPx);
  const newNoteInContext = () => newItemInContext(store, "note", props.hitInfo, props.desktopPosPx);
  const newTableInContext = () => newItemInContext(store, "table", props.hitInfo, props.desktopPosPx);
  const newRatingInContext = () => newItemInContext(store, "rating", props.hitInfo, props.desktopPosPx);
  const newLinkInContext = () => newItemInContext(store, "link", props.hitInfo, props.desktopPosPx);
  const newPasswordInContext = () => newItemInContext(store, "password", props.hitInfo, props.desktopPosPx);
  const newExpressionInContext = () => newItemInContext(store, "expression", props.hitInfo, props.desktopPosPx);
  const newFlipCardInContext = () => newItemInContext(store, "flipcard", props.hitInfo, props.desktopPosPx);

  const heightPx = () => store.general.installationState()!.devFeatureFlag
    ? 272
    : 242;

  return (
    <div class={`border rounded w-[115px] h-[${heightPx()}px] bg-slate-50 mb-1 shadow-lg`}>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={newNoteInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-sticky-note" /></div> Note
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newPageInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-folder" /></div> Page
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newTableInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-table" /></div> Table
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newRatingInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-star" /></div> Rating
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newExpressionInContext}>
        <div class="inline-block text-center w-[18px]"><span class="w-[16px] h-[16px] inline-block text-center relative">∑</span></div> Expression
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newLinkInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-link" /></div> Link
      </div>
      <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newPasswordInContext}>
        <div class="inline-block text-center w-[18px]"><i class="fa fa-eye-slash" /></div> Password
      </div>
      <Show when={store.general.installationState()?.devFeatureFlag}>
        <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={newFlipCardInContext}>
          <div class="inline-block text-center w-[18px]"><i class="fa fa-retweet" /></div> FlipCard
        </div>
      </Show>
      <div class="text-sm ml-[3px] mr-[5px] p-[3px] text-slate-500">
        <div class="inline-block text-center w-[18px]"><i class="fa fa-image" /></div> Image
      </div>
      <div class="text-sm ml-[3px] mr-[5px] p-[3px] text-slate-500">
        <div class="inline-block text-center w-[18px]"><i class="fa fa-file" /></div> File
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
