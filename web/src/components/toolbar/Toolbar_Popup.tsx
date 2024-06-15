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
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { BoundingBox } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { fullArrange } from "../../layout/arrange";
import { ToolbarPopupType } from "../../store/StoreProvider_Overlay";
import { asNoteItem, isNote } from "../../items/note-item";
import { InfuColorButton } from "../library/InfuColorButton";
import { VesCache } from "../../layout/ves-cache";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { serverOrRemote } from "../../server";
import { panic } from "../../util/lang";
import { itemState } from "../../store/ItemState";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { asFormatItem } from "../../items/base/format-item";
import { asTableItem } from "../../items/table-item";


function toolbarPopupHeight(overlayType: ToolbarPopupType, isComposite: boolean): number {
  if (overlayType == ToolbarPopupType.NoteFormat) { return 105; }
  if (overlayType == ToolbarPopupType.NoteUrl) { return 38; }
  if (overlayType == ToolbarPopupType.PageWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageAspect) { return 92; }
  if (overlayType == ToolbarPopupType.PageNumCols) { return 38; }
  if (overlayType == ToolbarPopupType.TableNumCols) { return 38; }
  if (overlayType == ToolbarPopupType.PageDocWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageCellAspect) { return 60; }
  if (overlayType == ToolbarPopupType.PageJustifiedRowAspect) { return 60; }
  if (overlayType == ToolbarPopupType.Ids) {
    if (isComposite) {
      return 60;
    }
    return 30;
  }
  return 30;
}

export function toolbarBoxBoundsPx(store: StoreContextModel): BoundingBox {
  const popupType = store.overlay.toolbarPopupInfoMaybe.get()!.type;
  const compositeVisualElementMaybe = () => {
    if (!isNote(store.history.getFocusItem())) {
      return null;
    }
    const noteVisualElement = () => VesCache.get(store.overlay.textEditInfo()!.itemPath)!.get();
    const parentVe = VesCache.get(noteVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };

  if (popupType != ToolbarPopupType.PageColor &&
      popupType != ToolbarPopupType.PageArrangeAlgorithm) {
    const maxX = store.desktopBoundsPx().w - 335;
    let x = store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x;
    if (x > maxX) { x = maxX; }
    return {
      x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 330,
      h: toolbarPopupHeight(popupType, compositeItemMaybe() != null)
    }
  } else if (popupType == ToolbarPopupType.PageColor) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 96, h: 56
    }
  } else if (popupType == ToolbarPopupType.PageArrangeAlgorithm) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 96, h: 140
    }
  } else {
    panic("unexpected popup type: " + popupType);
  }
}


export const Toolbar_Popup: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(store.history.getFocusItem());
  const noteItem = () => asNoteItem(store.history.getFocusItem());
  const tableItem = () => asTableItem(store.history.getFocusItem());
  const formatItem = () => asFormatItem(store.history.getFocusItem());

  const noteVisualElement = () => VesCache.get(store.overlay.textEditInfo()!.itemPath)!.get();
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

  const overlayTypeConst = store.overlay.toolbarPopupInfoMaybe.get()!.type;
  const overlayType = () => store.overlay.toolbarPopupInfoMaybe.get()!.type;

  const handleKeyDown = (ev: KeyboardEvent) => {
    if (ev.code == "Enter") {
      handleTextChange();
      store.touchToolbar();
      fullArrange(store);
      if (isNote(store.history.getFocusItem())) {
        serverOrRemote.updateItem(store.history.getFocusItem());
        setTimeout(() => {
          store.overlay.toolbarPopupInfoMaybe.set(null);
          document.getElementById("noteEditOverlayTextArea")!.focus();
        }, 0);
      }
    }
    ev.stopPropagation();
  }
  const handleKeyUp = (ev: KeyboardEvent) => { ev.stopPropagation(); }
  const handleKeyPress = (ev: KeyboardEvent) => { ev.stopPropagation(); }

  const handleTextChange = () => {
    if (overlayTypeConst == ToolbarPopupType.PageWidth) {
      pageItem().innerSpatialWidthGr = Math.round(parseFloat(textElement!.value)) * GRID_SIZE;
    } else if (overlayTypeConst == ToolbarPopupType.PageAspect) {
      pageItem().naturalAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageCellAspect) {
      pageItem().gridCellAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageJustifiedRowAspect) {
      pageItem().justifiedRowAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.NoteUrl) {
      noteItem().url = textElement!.value;
    } else if (overlayTypeConst == ToolbarPopupType.NoteFormat) {
      formatItem().format = textElement!.value;
    } else if (overlayTypeConst == ToolbarPopupType.PageNumCols) {
      pageItem().gridNumberOfColumns = Math.round(parseFloat(textElement!.value));
    } else if (overlayTypeConst == ToolbarPopupType.PageDocWidth) {
      pageItem().docWidthBl = Math.round(parseFloat(textElement!.value));
    } else if (overlayTypeConst == ToolbarPopupType.TableNumCols) {
      let newNumCols = Math.round(parseFloat(textElement!.value));
      if (newNumCols > 9) { newNumCols = 9; }
      if (newNumCols < 1) { newNumCols = 1; }
      while (tableItem().tableColumns.length < newNumCols) {
        tableItem().tableColumns.push({ name: `col ${tableItem().tableColumns.length}`, widthGr: 120 });
      }
      tableItem().numberOfVisibleColumns = newNumCols;
    }
    fullArrange(store);
  };

  const inputWidthPx = (): number => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return 264; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return 292; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return 196; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return 180; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return 238; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return 250; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return 150; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return 230; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return 162; }
    return 200;
  }

  const boxBoundsPx = () => toolbarBoxBoundsPx(store);

  onMount(() => {
    if (overlayType() != ToolbarPopupType.PageColor &&
        overlayType() != ToolbarPopupType.Ids &&
        overlayType() != ToolbarPopupType.PageArrangeAlgorithm) {
      textElement!.focus();
    }
  });

  const handleColorClick = (col: number) => {
    pageItem().backgroundColorIndex = col;
    store.overlay.toolbarPopupInfoMaybe.set(store.overlay.toolbarPopupInfoMaybe.get());
    store.touchToolbar();
    serverOrRemote.updateItem(store.history.getFocusItem());
    store.overlay.toolbarPopupInfoMaybe.set(null);
  }

  const textEntryValue = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return formatItem().format; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return noteItem().url; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "" + pageItem().innerSpatialWidthGr / GRID_SIZE; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "" + pageItem().naturalAspect; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "" + pageItem().gridNumberOfColumns; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return "" + tableItem().numberOfVisibleColumns; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "" + pageItem().docWidthBl; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "" + pageItem().gridCellAspect; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "" + pageItem().justifiedRowAspect; }
    if (overlayType() == ToolbarPopupType.Ids) { return null; }
    return "[unknown]";
  }

  const label = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return "Format"; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return "Url"; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "Inner Block Width"; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "Page Aspect"; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "Num Cols"; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return "Num Visible Cols"; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "Document Block Width"; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "Cell Aspect"; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "Row Aspect"; }
    if (overlayType() == ToolbarPopupType.Ids) { return null; }
    return "[unknown]";
  }

  const tooltip = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return "If the text is numeric, it will be formatted according to the specified pattern. Currently only a limited set of format patterns are supported: 0.0000, 0.000, 0.00, 0.0 or empty"; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "The width of the page in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "The natural aspect ratio (width / height) of the page. The actual displayed aspect ratio may be stretched or quantized as required."; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "The aspect ratio (width / height) of a grid cell."; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "The aspect ratio (width / height) of one row of items."; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "The width of the document area in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    return null;
  }

  const showAutoButton = (): boolean => overlayType() == ToolbarPopupType.PageAspect;

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

  const finalizeAAChange = () => {
    itemState.sortChildren(pageItem().id);
    fullArrange(store);
    store.touchToolbar();
    serverOrRemote.updateItem(pageItem());
    store.overlay.toolbarPopupInfoMaybe.set(null);
  }

  const aaSpatialClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.SpatialStretch; finalizeAAChange(); }
  const aaGridClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Grid; finalizeAAChange(); }
  const aaJustifiedClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Justified; finalizeAAChange(); }
  const aaListClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.List; finalizeAAChange(); }
  const aaDocumentClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Document; finalizeAAChange(); }

  const handleMouseDown = (e: MouseEvent) => { if (e.button == MOUSE_RIGHT) { store.overlay.toolbarPopupInfoMaybe.set(null); } }

  return (
    <>
      <Switch>
        <Match when={overlayType() == ToolbarPopupType.PageColor}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
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
        <Match when={overlayType() == ToolbarPopupType.PageArrangeAlgorithm}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={aaSpatialClick}>
              Spatial
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaGridClick}>
              Grid
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]"  onClick={aaJustifiedClick}>
              Justified
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaListClick}>
              List
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaDocumentClick}>
              Document
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.Ids}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
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
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
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
