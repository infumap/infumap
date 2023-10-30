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

import { Component, onMount } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { BooleanSignal } from "../../util/signals";
import { isInside } from "../../util/geometry";
import { asNoteItem } from "../../items/note-item";
import { arrange } from "../../layout/arrange";
import { CursorEventState } from "../../mouse/state";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";


export const UrlOverlay: Component<{urlOverlayVisible: BooleanSignal}> = (props: { urlOverlayVisible: BooleanSignal }) => {
  const desktopStore = useDesktopStore();

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDestkopPx(desktopStore, noteVisualElement());
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);

  const toolboxBoundsPx = () => {
    return ({
      x: noteVeBoundsPx().x + noteVeBoundsPx().w + 10,
      y: noteVeBoundsPx().y + 38,
      w: 360,
      h: 36
    });
  }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    const desktopPx = CursorEventState.getLastestDesktopPx();
    if (isInside(desktopPx, noteVeBoundsPx()) || isInside(desktopPx, toolboxBoundsPx())) { return; }
    props.urlOverlayVisible.set(false);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const handleUrlChange = () => {
    noteItem().url = urlTextElement!.value;
    arrange(desktopStore);
  };

  onMount(() => {
    urlTextElement?.focus();
  });

  let urlTextElement: HTMLInputElement | undefined;

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <div class="p-[4px]">
          <span class="text-sm ml-1 mr-2">Link:</span>
          <input ref={urlTextElement}
            class="border border-slate-300 rounded w-[305px] pl-1"
            autocomplete="on"
            value={noteItem().url}
            type="text"
            onChange={handleUrlChange} />
        </div>
      </div>
    </div>
  );
}
