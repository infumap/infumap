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

import { Component, Match, Show, Switch, onMount } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { BoundingBox } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { fullArrange } from "../../layout/arrange";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";
import { asNoteItem, isNote } from "../../items/note-item";
import { InfuColorButton } from "../library/InfuColorButton";
import { VesCache } from "../../layout/ves-cache";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { serverOrRemote } from "../../server";


function toolbarOverlayHeight(overlayType: ToolbarOverlayType, isComposite: boolean): number {
  if (overlayType == ToolbarOverlayType.NoteFormat) { return 105; }
  if (overlayType == ToolbarOverlayType.NoteUrl) { return 38; }
  if (overlayType == ToolbarOverlayType.PageWidth) { return 74; }
  if (overlayType == ToolbarOverlayType.PageAspect) { return 92; }
  if (overlayType == ToolbarOverlayType.PageNumCols) { return 38; }
  if (overlayType == ToolbarOverlayType.PageDocWidth) { return 74; }
  if (overlayType == ToolbarOverlayType.PageCellAspect) { return 60; }
  if (overlayType == ToolbarOverlayType.PageJustifiedRowAspect) { return 60; }
  if (overlayType == ToolbarOverlayType.Ids) {
    if (isComposite) {
      return 60;
    }
    return 30;
  }
  return 30;
}

export function toolbarBoxBoundsPx(store: StoreContextModel): BoundingBox {
  const overlayType = store.overlay.toolbarOverlayInfoMaybe.get()!.type;
  const compositeVisualElementMaybe = () => {
    if (!isNote(store.history.getFocusItem())) {
      return null;
    }
    const noteVisualElement = () => VesCache.get(store.overlay.noteEditOverlayInfo()!.itemPath)!.get();
    const parentVe = VesCache.get(noteVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };

  if (overlayType != ToolbarOverlayType.PageColor) {
    const maxX = store.desktopBoundsPx().w - 335;
    let x = store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.x;
    if (x > maxX) { x = maxX; }
    return {
      x,
      y: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.y,
      w: 330,
      h: toolbarOverlayHeight(overlayType, compositeItemMaybe() != null)
    }
  }
  else {
    return {
      x: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarOverlayInfoMaybe.get()!.topLeftPx.y,
      w: 96, h: 56
    }
  }
}


export const Toolbar_Overlay: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(store.history.getFocusItem());
  const noteItem = () => asNoteItem(store.history.getFocusItem());

  const noteVisualElement = () => VesCache.get(store.overlay.noteEditOverlayInfo()!.itemPath)!.get();
  const compositeVisualElementMaybe = () => {
    if (!isNote(store.history.getFocusItem())) {
      return null;
    }
    const parentVe = VesCache.get(noteVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };

  const overlayTypeConst = store.overlay.toolbarOverlayInfoMaybe.get()!.type;
  const overlayType = () => store.overlay.toolbarOverlayInfoMaybe.get()!.type;

  const handleKeyDown = (ev: KeyboardEvent) => {
    if (ev.code == "Enter") {
      handleTextChange();
      store.touchToolbar();
      fullArrange(store);
      if (isNote(store.history.getFocusItem())) {
        serverOrRemote.updateItem(store.history.getFocusItem());
        setTimeout(() => {
          store.overlay.toolbarOverlayInfoMaybe.set(null);
          document.getElementById("noteEditOverlayTextArea")!.focus();
        }, 0);
      }
    }
    ev.stopPropagation();
  }
  const handleKeyUp = (ev: KeyboardEvent) => { ev.stopPropagation(); }
  const handleKeyPress = (ev: KeyboardEvent) => { ev.stopPropagation(); }

  const handleTextChange = () => {
    if (overlayTypeConst == ToolbarOverlayType.PageWidth) {
      pageItem().innerSpatialWidthGr = Math.round(parseFloat(textElement!.value)) * GRID_SIZE;
    } else if (overlayTypeConst == ToolbarOverlayType.PageAspect) {
      pageItem().naturalAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarOverlayType.PageCellAspect) {
      pageItem().gridCellAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarOverlayType.PageJustifiedRowAspect) {
      pageItem().justifiedRowAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarOverlayType.NoteUrl) {
      noteItem().url = textElement!.value;
    } else if (overlayTypeConst == ToolbarOverlayType.NoteFormat) {
      noteItem().format = textElement!.value;
    } else if (overlayTypeConst == ToolbarOverlayType.PageNumCols) {
      pageItem().gridNumberOfColumns = Math.round(parseFloat(textElement!.value));
    } else if (overlayTypeConst == ToolbarOverlayType.PageDocWidth) {
      pageItem().docWidthBl = Math.round(parseFloat(textElement!.value));
    }
    fullArrange(store);
  };

  const inputWidthPx = (): number => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return 264; }
    if (overlayType() == ToolbarOverlayType.NoteUrl) { return 292; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return 196; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return 180; }
    if (overlayType() == ToolbarOverlayType.PageCellAspect) { return 238; }
    if (overlayType() == ToolbarOverlayType.PageNumCols) { return 250; }
    if (overlayType() == ToolbarOverlayType.PageJustifiedRowAspect) { return 230; }
    if (overlayType() == ToolbarOverlayType.PageDocWidth) { return 162; }
    return 200;
  }

  const boxBoundsPx = () => toolbarBoxBoundsPx(store);

  onMount(() => {
    if (overlayType() != ToolbarOverlayType.PageColor && overlayType() != ToolbarOverlayType.Ids) {
      textElement!.focus();
    }
  });

  const handleColorClick = (col: number) => {
    pageItem().backgroundColorIndex = col;
    store.overlay.toolbarOverlayInfoMaybe.set(store.overlay.toolbarOverlayInfoMaybe.get());
    store.touchToolbar();
    serverOrRemote.updateItem(store.history.getFocusItem());
    store.overlay.toolbarOverlayInfoMaybe.set(null);
  }

  const textEntryValue = (): string | null => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return noteItem().format; }
    if (overlayType() == ToolbarOverlayType.NoteUrl) { return noteItem().url; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return "" + pageItem().innerSpatialWidthGr / GRID_SIZE; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return "" + pageItem().naturalAspect; }
    if (overlayType() == ToolbarOverlayType.PageNumCols) { return "" + pageItem().gridNumberOfColumns; }
    if (overlayType() == ToolbarOverlayType.PageDocWidth) { return "" + pageItem().docWidthBl; }
    if (overlayType() == ToolbarOverlayType.PageCellAspect) { return "" + pageItem().gridCellAspect; }
    if (overlayType() == ToolbarOverlayType.PageJustifiedRowAspect) { return "" + pageItem().justifiedRowAspect; }
    if (overlayType() == ToolbarOverlayType.Ids) { return null; }
    return "[unknown]";
  }

  const label = (): string | null => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return "Format"; }
    if (overlayType() == ToolbarOverlayType.NoteUrl) { return "Url"; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return "Inner Block Width"; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return "Page Aspect"; }
    if (overlayType() == ToolbarOverlayType.PageNumCols) { return "Num Cols"; }
    if (overlayType() == ToolbarOverlayType.PageDocWidth) { return "Document Block Width"; }
    if (overlayType() == ToolbarOverlayType.PageCellAspect) { return "Cell Aspect"; }
    if (overlayType() == ToolbarOverlayType.PageJustifiedRowAspect) { return "Row Aspect"; }
    if (overlayType() == ToolbarOverlayType.Ids) { return null; }
    return "[unknown]";
  }

  const tooltip = (): string | null => {
    if (overlayType() == ToolbarOverlayType.NoteFormat) { return "If the note text is numeric, it will be formatted according to the specified pattern. Currently only a limited set of format patterns are supported: 0.0000, 0.000, 0.00, 0.0 or empty"; }
    if (overlayType() == ToolbarOverlayType.PageWidth) { return "The width of the page in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    if (overlayType() == ToolbarOverlayType.PageAspect) { return "The natural aspect ratio (width / height) of the page. The actual displayed aspect ratio may be stretched or quantized as required."; }
    if (overlayType() == ToolbarOverlayType.PageCellAspect) { return "The aspect ratio (width / height) of a grid cell."; }
    if (overlayType() == ToolbarOverlayType.PageJustifiedRowAspect) { return "The aspect ratio (width / height) of one row of items."; }
    if (overlayType() == ToolbarOverlayType.PageDocWidth) { return "The width of the document area in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    return null;
  }

  const showAutoButton = (): boolean => overlayType() == ToolbarOverlayType.PageAspect;

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(store.history.getFocusItem().id); }
  const linkItemIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + store.history.getFocusItem()!.id); }

  const copyCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(compositeItemMaybe()!.id); }
  const linkCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + compositeItemMaybe()!.id); }

  const handleAutoClick = (): void => {
    const aspect = "" + Math.round(store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h * 1000) / 1000;
    textElement!.value = aspect;
    pageItem().naturalAspect = parseFloat(textElement!.value);
    fullArrange(store);
  }

  return (
    <>
      <Switch>
        <Match when={overlayType() == ToolbarOverlayType.PageColor}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}>
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
        <Match when={overlayType() == ToolbarOverlayType.Ids}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}>
            <div class="inline-block text-slate-800 text-xs p-[6px]">
              <span class="font-mono text-slate-400">{`I: ${store.history.getFocusItem().id}`}</span>
              <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyItemIdClickHandler} />
              <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkItemIdClickHandler} />
            </div>
            <Show when={compositeItemMaybe() != null}>
              <div class="inline-block text-slate-800 text-xs p-[6px]">
                <span class="font-mono text-slate-400">{`C: ${compositeItemMaybe()!.id}`}</span>
                <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyCompositeIdClickHandler} />
                <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkCompositeIdClickHandler} />
              </div>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}>
            <Show when={label() != null}>
              <div class="text-sm ml-1 mr-2 inline-block">{label()}</div>
              <input ref={textElement}
                     class="border border-slate-300 rounded mt-[3px] p-[2px]"
                     style={`width: ${inputWidthPx()}px`}
                     autocomplete="on"
                     value={textEntryValue()!}
                     type="text"
                     onChange={handleTextChange}
                     onKeyDown={handleKeyDown}
                     onKeyUp={handleKeyUp}
                     onKeyPress={handleKeyPress}/>
            </Show>
            <Show when={showAutoButton()}>
              <button class="border border-slate-300 rounded mt-[3px] p-[2px] ml-[4px] hover:bg-slate-300"
                      type="button"
                      onClick={handleAutoClick}>
                auto
              </button>
            </Show>
            <Show when={tooltip() != null}>
              <div class="text-xs p-[4px] pt-[5px]">
                {tooltip()}
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
    </>
  );
}
