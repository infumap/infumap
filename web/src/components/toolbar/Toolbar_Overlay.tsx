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

import { Component, Match, Switch, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { CursorEventState } from "../../input/state";
import { isInside } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { arrange } from "../../layout/arrange";
import { server } from "../../server";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";
import { asNoteItem } from "../../items/note-item";
import { InfuColorButton } from "../library/InfuColorButton";


export const Toolbar_Overlay: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const item = () => itemState.get(store.getToolbarFocus()!.itemId)!;
  const pageItem = () => asPageItem(itemState.get(store.getToolbarFocus()!.itemId)!);
  const noteItem = () => asNoteItem(itemState.get(store.getToolbarFocus()!.itemId)!);

  const overlayTypeConst = store.overlay.toolbarOverlayInfoMaybe.get()!.type;
  const overlayType = () => store.overlay.toolbarOverlayInfoMaybe.get()!.type;

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestClientPx(), boxBoundsPx())) {
      ev.stopPropagation();
      return;
    }
    store.overlay.toolbarOverlayInfoMaybe.set(null);
    store.rerenderToolbar();
    arrange(store);
    server.updateItem(item());
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    if (isInside(CursorEventState.getLatestClientPx(), boxBoundsPx())) {
      ev.stopPropagation();
      return;
    }
    CursorEventState.setFromMouseEvent(ev);
  };

  const mouseUpListener = (ev: MouseEvent) => {
    if (isInside(CursorEventState.getLatestClientPx(), boxBoundsPx())) {
      ev.stopPropagation();
      return;
    }
  };

  const handleTextChange = () => {
    if (overlayTypeConst == ToolbarOverlayType.PageWidth) {
      pageItem().innerSpatialWidthGr = Math.round(parseFloat(textElement!.value)) * GRID_SIZE;
    } else if (overlayTypeConst == ToolbarOverlayType.PageAspect) {
      pageItem().naturalAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarOverlayType.NoteUrl) {
      noteItem().url = textElement!.value;
    } else if (overlayTypeConst == ToolbarOverlayType.NoteFormat) {
      noteItem().format = textElement!.value;
    } else if (overlayTypeConst == ToolbarOverlayType.PageNumCols) {
      pageItem().gridNumberOfColumns = Math.round(parseFloat(textElement!.value));
    }
    arrange(store);
  };

  const boxBoundsPx = () => {
    if (overlayType() != ToolbarOverlayType.PageColor) {
      return {
        x: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.x,
        y: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.y,
        w: 300, h: 30
      }
    }
    else {
      return {
        x: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.x,
        y: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.y,
        w: 96, h: 56
      }
    }
  };

  onMount(() => {
    if (overlayType() != ToolbarOverlayType.PageColor) {
      textElement!.focus();
    }
  });

  const handleColorClick = (col: number) => {
    pageItem().backgroundColorIndex = col;
    store.overlay.toolbarOverlayInfoMaybe.set(store.overlay.toolbarOverlayInfoMaybe.get());
  }

  const textEntryValue = (): string => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return noteItem().format; }
    if (overlayType() == ToolbarOverlayType.NoteUrl) { return noteItem().url; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return "" + pageItem().innerSpatialWidthGr / GRID_SIZE; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return "" + pageItem().naturalAspect; }
    if (overlayType() == ToolbarOverlayType.PageNumCols) { return "" + pageItem().gridNumberOfColumns; }
    return "[unknown]";
  }

  const label = (): string => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return "Format"; }
    if (overlayType() == ToolbarOverlayType.NoteUrl) { return "Url"; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return "Inner Width"; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return "Aspect"; }
    if (overlayType() == ToolbarOverlayType.PageNumCols) { return "Num Cols"; }
    return "[unknown]";
  }

  return (
    <div id="formatOverlay"
         class="fixed left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <Switch>
        <Match when={overlayType() != ToolbarOverlayType.PageColor}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px`}>
            <span class="text-sm ml-1 mr-2">{label()}</span>
            <input ref={textElement}
                   class="border border-slate-300 rounded w-[100px] pl-1"
                   autocomplete="on"
                   value={textEntryValue()}
                   type="text"
                   onChange={handleTextChange} />
          </div>
        </Match>
        <Match when={overlayType() == ToolbarOverlayType.PageColor}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px`}>
          <div class="pt-[6px] pl-[4px]">
            <div class="inline-block pl-[2px]"><InfuColorButton col={0} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={1} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={2} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={3} onClick={handleColorClick} /></div>
          </div>
          <div class="pt-0 pl-[4px]">
            <div class="inline-block pl-[2px]"><InfuColorButton col={4} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={5} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={6} onClick={handleColorClick} /></div>
            <div class="inline-block pl-[2px]"><InfuColorButton col={7} onClick={handleColorClick} /></div>
          </div>
        </div>
        </Match>
      </Switch>
    </div>
  );
}
