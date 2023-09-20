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

import { Component, onCleanup } from "solid-js";
import { useDesktopStore } from "../store/DesktopStoreProvider";
import { VesCache } from "../layout/ves-cache";
import { InfuTextArea } from "./library/InfuTextArea";
import { asNoteItem } from "../items/note-item";
import { arrange } from "../layout/arrange";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { InfuIconButton } from "./library/InfuIconButton";
import { VeFns } from "../layout/visual-element";


export interface TextEditOverlayProps {};

export const TextEditOverlay: Component = () => {
  const desktopStore = useDesktopStore();

  const noteVisualElement = VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!;
  const noteItem = () => asNoteItem(noteVisualElement.get().displayItem);
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(noteVisualElement.get());

  const mouseDownListener = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const keyDownListener = (ev: KeyboardEvent) => {
    if (ev.code == 'Enter') {
      console.log(ev);
      ev.preventDefault();
      return;
    }
  }

  const handleTextInput = (v: string) => {
    noteItem().title = v;
    arrange(desktopStore);
  };

  onCleanup(() => {
    server.updateItem(noteItem());
  });

  const boldHandler = () => {

  }

  const headingHandler = () => {

  }

  const handleUrlChange = (v: string) => {
    asNoteItem(itemState.getItem(noteItem().id)!).url = v;
    arrange(desktopStore);
  };


  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <div class="absolute border rounded w-[250px] h-[55px] bg-white mb-1"
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y - 80}px; width: 320px; height: 64px`}>
        <div class="text-slate-800 text-sm">
          <span class="font-mono text-slate-400">{`${noteItem().id}`}</span>
          <i class={`fa fa-copy text-slate-400 cursor-pointer ml-1`} onclick={boldHandler} />
          <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={boldHandler} />
        </div>
        <div>
          <InfuIconButton icon="font" clickHandler={headingHandler} />
          <InfuIconButton icon="header-1" clickHandler={headingHandler} />
          <InfuIconButton icon="header-2" clickHandler={headingHandler} />
          <InfuIconButton icon="header-3" clickHandler={headingHandler} />
          <InfuIconButton icon="list" clickHandler={headingHandler} />
          <div style="width: 10px; display: inline-block;"></div>
          <InfuIconButton icon="clone" clickHandler={headingHandler} />
          <div style="width: 10px; display: inline-block;"></div>
          <InfuIconButton icon="align-left" clickHandler={headingHandler} />
        </div>
        {/* <div class="text-slate-800 text-sm">Url <InfuTextInput value={noteItem().url} onChangeOrCleanup={handleUrlChange} /></div> */}
      </div>
      <div class="absolute rounded"
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
        <InfuTextArea focus={true} value={noteItem().title} onInput={handleTextInput} />
      </div>
    </div>
  );
}
