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

import { Component, onCleanup, onMount } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { InfuTextArea } from "../library/InfuTextArea";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { server } from "../../server";
import { itemState } from "../../store/ItemState";
import { InfuIconButton } from "../library/InfuIconButton";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem } from "../../items/base/x-sizeable-item";


export interface TextEditOverlayProps {};

export const TextEditOverlay: Component = () => {
  const desktopStore = useDesktopStore();

  let textElement: HTMLTextAreaElement | undefined;

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(noteVisualElement());
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);
  const noteItemOnInitialize = noteItem();

  const sizeBl = () => {
    if (noteVisualElement().flags & VisualElementFlags.InsideComposite) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(noteVisualElement().displayItem));
      cloned.spatialWidthGr = asXSizableItem(VeFns.getCanonicalItem(VesCache.get(noteVisualElement().parentPath!)!.get())).spatialWidthGr;
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (noteVisualElement().linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(noteVisualElement().linkItemMaybe!);
    }
    return NoteFns.calcSpatialDimensionsBl(noteItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (noteVeBoundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (noteVeBoundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const mouseDownListener = (ev: MouseEvent) => {
    console.log("C", ev);
    ev.preventDefault();
    ev.stopPropagation();
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    console.log("A", ev);
    ev.preventDefault();
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    console.log("B", ev);
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


  onCleanup(() => {
    server.updateItem(noteItemOnInitialize);
  });

  onMount(() => {
    textElement?.focus();
  });

  const boldHandler = () => {

  }

  const headingHandler = () => {

  }

  const handleUrlChange = (v: string) => {
    asNoteItem(itemState.get(noteItem().id)!).url = v;
    arrange(desktopStore);
  };

  const textAreaMouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
  }
  
  const textAreaOnInputHandler = () => {
    noteItem().title = textElement!.value;
    arrange(desktopStore);
  }

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      {/* <div class="absolute border rounded w-[250px] h-[55px] bg-white mb-1"
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
      </div> */}
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${noteVeBoundsPx().x + noteVeBoundsPx().w + 10}px; top: ${noteVeBoundsPx().y - 2}px; width: 55px; height: 120px`}>
        <InfuIconButton icon="font" clickHandler={headingHandler} />
        <InfuIconButton icon="align-left" clickHandler={headingHandler} />
        <InfuIconButton icon="link" clickHandler={headingHandler} />
        <InfuIconButton icon="ellipsis-h" clickHandler={headingHandler} />
      </div>
      <div class={`absolute rounded border`}
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
        <textarea ref={textElement}
          class="rounded"
          style={`position: absolute; left: ${NOTE_PADDING_PX}px; top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)}px; ` +
                 `width: ${naturalWidthPx()}px; height: ${naturalHeightPx()*heightScale()/widthScale()}px; ` +
                 `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; transform: scale(${textBlockScale()}); ` +
                 `transform-origin: top left; overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;`}
          value={noteItem().title}
          onMouseDown={textAreaMouseDownHandler}
          onInput={textAreaOnInputHandler} />
      </div>
    </div>
  );
}
