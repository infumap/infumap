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

import { Component, Match, Show, Switch, createSignal, on, onMount } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { asRatingItem, isRating } from "../../items/rating-item";
import { BoundingBox } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";
import { fullArrange } from "../../layout/arrange";
import { ToolbarPopupType, TransientMessageType } from "../../store/StoreProvider_Overlay";
import { asNoteItem, isNote } from "../../items/note-item";
import { InfuColorButton } from "../library/InfuColorButton";
import { VesCache } from "../../layout/ves-cache";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { serverOrRemote } from "../../server";
import { panic } from "../../util/lang";
import { itemState } from "../../store/ItemState";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { asFormatItem } from "../../items/base/format-item";
import { asTableItem, isTable } from "../../items/table-item";
import QRCode from "qrcode";
import { asFlipCardItem, isFlipCard } from "../../items/flipcard-item";
import { isImage, asImageItem } from "../../items/image-item";
import { isFile, asFileItem } from "../../items/file-item";


function toolbarPopupHeight(overlayType: ToolbarPopupType, isComposite: boolean): number {
  if (overlayType == ToolbarPopupType.NoteFormat) { return 105; }
  if (overlayType == ToolbarPopupType.NoteUrl) { return 38; }
  if (overlayType == ToolbarPopupType.PageWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageAspect) { return 92; }
  if (overlayType == ToolbarPopupType.PageNumCols) { return 36; }
  if (overlayType == ToolbarPopupType.TableNumCols) { return 36; }
  if (overlayType == ToolbarPopupType.PageDocWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageCellAspect) { return 60; }
  if (overlayType == ToolbarPopupType.PageJustifiedRowAspect) { return 60; }
  if (overlayType == ToolbarPopupType.PageCalendarDayRowHeight) { return 60; }
  if (overlayType == ToolbarPopupType.Scale) { return 92; }
  if (overlayType == ToolbarPopupType.QrLink) {
    if (isComposite) {
      return 500;
    }
    return 450;
  }
  return 30;
}

function calculateChildrenStats(containerItem: any): { totalChildren: number, imageFileChildren: number, totalBytes: number } {
  const children = containerItem.computed_children || [];
  let totalChildren = children.length;
  let imageFileChildren = 0;
  let totalBytes = 0;

  children.forEach((childId: string) => {
    const child = itemState.get(childId);
    if (child) {
      if (isImage(child)) {
        imageFileChildren++;
        totalBytes += asImageItem(child).fileSizeBytes || 0;
      } else if (isFile(child)) {
        imageFileChildren++;
        totalBytes += asFileItem(child).fileSizeBytes || 0;
      }
    }
  });

  return { totalChildren, imageFileChildren, totalBytes };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function toolbarPopupBoxBoundsPx(store: StoreContextModel): BoundingBox {
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
      popupType != ToolbarPopupType.PageArrangeAlgorithm &&
      popupType != ToolbarPopupType.RatingType) {
    const popupWidth = popupType == ToolbarPopupType.TableNumCols ? 300 : 330;
    const maxX = store.desktopBoundsPx().w - popupWidth - 20;
    let x = store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x;
    if (x > maxX) { x = maxX; }
    return {
      x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: popupWidth,
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
      w: 96,
      h: store.general.installationState()?.devFeatureFlag ? 164 : 138
    }
  } else if (popupType == ToolbarPopupType.RatingType) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 140,
      h: 128
    }
  } else {
    panic("unexpected popup type: " + popupType);
  }
}


export const Toolbar_Popup: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(store.history.getFocusItem());
  const flipCardItem = () => asFlipCardItem(store.history.getFocusItem());
  const noteItem = () => asNoteItem(store.history.getFocusItem());
  const tableItem = () => asTableItem(store.history.getFocusItem());
  const ratingItem = () => asRatingItem(store.history.getFocusItem());
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
  const [sliderValue, setSliderValue] = createSignal(
    isTable(store.history.getFocusItem())
      ? asTableItem(store.history.getFocusItem()).numberOfVisibleColumns.toString()
      : isPage(store.history.getFocusItem())
        ? overlayTypeConst == ToolbarPopupType.PageCalendarDayRowHeight
          ? asPageItem(store.history.getFocusItem()).calendarDayRowHeightBl.toString()
          : asPageItem(store.history.getFocusItem()).gridNumberOfColumns.toString()
        : "1"
  );

  const handleKeyDown = (ev: KeyboardEvent) => {
    if (ev.code == "Enter") {
      handleTextChange();
      store.touchToolbar();
      fullArrange(store);
      if (isNote(store.history.getFocusItem())) {
        serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);
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
    } else if (overlayTypeConst == ToolbarPopupType.Scale) {
      const fcItem = flipCardItem();
      fcItem.scale = parseFloat(textElement!.value) / 100.0;
      for (let i=0; i<fcItem.computed_children.length; ++i) {
        const childPage = asPageItem(itemState.get(fcItem.computed_children[i])!);
        childPage.innerSpatialWidthGr = Math.round(flipCardItem().spatialWidthGr * flipCardItem().scale / GRID_SIZE) * GRID_SIZE;
      }
    } else if (overlayTypeConst == ToolbarPopupType.PageCellAspect) {
      pageItem().gridCellAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageJustifiedRowAspect) {
      pageItem().justifiedRowAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageCalendarDayRowHeight) {
      pageItem().calendarDayRowHeightBl = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.NoteUrl) {
      noteItem().url = textElement!.value;
    } else if (overlayTypeConst == ToolbarPopupType.NoteFormat) {
      formatItem().format = textElement!.value;
    } else if (overlayTypeConst == ToolbarPopupType.PageDocWidth) {
      pageItem().docWidthBl = Math.round(parseFloat(textElement!.value));
    } else if (overlayTypeConst == ToolbarPopupType.TableNumCols) {
      panic("unexpected overlay type in handleTextChange: " + overlayTypeConst);
    }
    fullArrange(store);
  };

  const inputWidthPx = (): number => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return 264; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return 292; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return 196; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return 180; }
    if (overlayType() == ToolbarPopupType.Scale) { return 180; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return 238; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return 260; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return 230; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return 162; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return 190; }
    if (overlayType() == ToolbarPopupType.PageCalendarDayRowHeight) { return 230; }
    return 200;
  }

  const boxBoundsPx = () => toolbarPopupBoxBoundsPx(store);

  onMount(() => {
    if (overlayType() == ToolbarPopupType.TableNumCols) {
      setSliderValue(asTableItem(store.history.getFocusItem()).numberOfVisibleColumns.toString());
    } else if (overlayType() == ToolbarPopupType.PageCalendarDayRowHeight) {
      setSliderValue(asPageItem(store.history.getFocusItem()).calendarDayRowHeightBl.toString());
    }

    if (overlayType() != ToolbarPopupType.PageColor &&
        overlayType() != ToolbarPopupType.QrLink &&
        overlayType() != ToolbarPopupType.PageArrangeAlgorithm &&
        overlayType() != ToolbarPopupType.TableNumCols &&
        overlayType() != ToolbarPopupType.PageNumCols &&
        overlayType() != ToolbarPopupType.PageCalendarDayRowHeight &&
        overlayType() != ToolbarPopupType.RatingType) {
      textElement!.focus();
    }
  });

  const handleColorClick = (col: number) => {
    if (isPage(store.history.getFocusItem())) {
      pageItem().backgroundColorIndex = col;
    } else if (isFlipCard(store.history.getFocusItem())) {
      flipCardItem().backgroundColorIndex = col;
    } else {
      panic(`unexpected item type ${store.history.getFocusItem().itemType} changing color.`);
    }
    store.overlay.toolbarPopupInfoMaybe.set(store.overlay.toolbarPopupInfoMaybe.get());
    serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    fullArrange(store);
  }

  const textEntryValue = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return formatItem().format; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return noteItem().url; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "" + pageItem().innerSpatialWidthGr / GRID_SIZE; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "" + pageItem().naturalAspect; }
    if (overlayType() == ToolbarPopupType.Scale) { return "" + Math.round(flipCardItem().scale * 1000.0) / 10.0; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "" + pageItem().gridNumberOfColumns; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "" + pageItem().docWidthBl; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "" + pageItem().gridCellAspect; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "" + pageItem().justifiedRowAspect; }
    if (overlayType() == ToolbarPopupType.PageCalendarDayRowHeight) { return "" + pageItem().calendarDayRowHeightBl; }
    if (overlayType() == ToolbarPopupType.QrLink) { return null; }
    return "[unknown]";
  }

  const label = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return "Format"; }
    if (overlayType() == ToolbarPopupType.NoteUrl) { return "Url"; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "Inner Block Width"; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "Page Aspect"; }
    if (overlayType() == ToolbarPopupType.Scale) { return "Scale"; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "Num Cols"; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return "Num Visible Cols"; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "Document Block Width"; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "Cell Aspect"; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "Row Aspect"; }
    if (overlayType() == ToolbarPopupType.PageCalendarDayRowHeight) { return "Row Height"; }
    if (overlayType() == ToolbarPopupType.QrLink) { return null; }
    return "[unknown]";
  }

  const tooltip = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteFormat) { return "If the text is numeric, it will be formatted according to the specified pattern. Currently only a limited set of format patterns are supported: 0.0000, 0.000, 0.00, 0.0, 1,000, 1,000.00 or empty"; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "The width of the page in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "The natural aspect ratio (width / height) of the page. The actual displayed aspect ratio may be stretched or quantized as required."; }
    if (overlayType() == ToolbarPopupType.Scale) { return "Inner page scale."; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "The aspect ratio (width / height) of a grid cell."; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "The aspect ratio (width / height) of one row of items."; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "The width of the document area in 'blocks'. One block is equal to the hight of one line of normal sized text."; }
    if (overlayType() == ToolbarPopupType.PageCalendarDayRowHeight) { return "The height of one row of calendar day items."; }
    return null;
  }

  const showAutoButton = (): boolean => overlayType() == ToolbarPopupType.PageAspect;

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(store.history.getFocusItem().id); }
  const linkItemIdClickHandler = (): void => {
    navigator.clipboard.writeText(window.location.origin + "/" + store.history.getFocusItem()!.id);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.overlay.toolbarTransientMessage.set({ text: store.history.getFocusItem().itemType + " id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const copyCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(compositeItemMaybe()!.id); }
  const linkCompositeIdClickHandler = (): void => {
    navigator.clipboard.writeText(window.location.origin + "/" + compositeItemMaybe()!.id);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.overlay.toolbarTransientMessage.set({ text: "composite id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const handleAutoClick = (): void => {
    const aspect = "" + Math.round(store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h * 1000) / 1000;
    textElement!.value = aspect;
    if (isPage(store.history.getFocusItem())) {
      pageItem().naturalAspect = parseFloat(textElement!.value);
    } else if (isFlipCard(store.history.getFocusItem())) {
      flipCardItem().naturalAspect = parseFloat(textElement!.value);
    } else {
      panic(`unexpected item type ${store.history.getFocusItem().itemType} changing aspect (auto).`);
    }
    fullArrange(store);
  }

  const finalizeAAChange = () => {
    itemState.sortChildren(pageItem().id);
    fullArrange(store);
    store.touchToolbar();
    serverOrRemote.updateItem(pageItem(), store.general.networkStatus);
    store.overlay.toolbarPopupInfoMaybe.set(null);
  }

  const aaSpatialClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.SpatialStretch; finalizeAAChange(); }
  const aaGridClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Grid; finalizeAAChange(); }
  const aaJustifiedClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Justified; finalizeAAChange(); }
  const aaListClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.List; finalizeAAChange(); }
  const aaDocumentClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Document; finalizeAAChange(); }
  const aaCalendarClick = () => { pageItem().arrangeAlgorithm = ArrangeAlgorithm.Calendar; finalizeAAChange(); }

  const handleMouseDown = (e: MouseEvent) => { if (e.button == MOUSE_RIGHT) { store.overlay.toolbarPopupInfoMaybe.set(null); } }

  onMount(() => {
    const canvas = document.getElementById('qrcanvas');
    const url = window.location.origin + "/" + store.history.getFocusItem()!.id;
    QRCode.toCanvas(canvas, url, { scale: 7 });
  });

  const handleSliderInput = (e: Event & { currentTarget: HTMLInputElement }) => {
    setSliderValue(e.currentTarget.value);
    let newValue = parseInt(e.currentTarget.value);
    if (overlayTypeConst == ToolbarPopupType.PageCalendarDayRowHeight) {
      if (newValue > 8) { newValue = 8; }
      if (newValue < 1) { newValue = 1; }
      pageItem().calendarDayRowHeightBl = newValue;
    } else {
      if (newValue > 20) { newValue = 20; }
      if (newValue < 1) { newValue = 1; }
      if (overlayTypeConst == ToolbarPopupType.TableNumCols) {
        tableItem().numberOfVisibleColumns = newValue;
        while (tableItem().tableColumns.length < newValue) {
          tableItem().tableColumns.push({ name: `col ${tableItem().tableColumns.length}`, widthGr: 120 });
        }
      } else if (overlayTypeConst == ToolbarPopupType.PageNumCols) {
        pageItem().gridNumberOfColumns = newValue;
      }
    }
    store.touchToolbar();
    fullArrange(store);
  };

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
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaCalendarClick}>
              Calendar
            </div>
            <Show when={store.general.installationState()?.devFeatureFlag}>
              <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaDocumentClick}>
                Document
              </div>
              <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={aaCalendarClick}>
                Calendar
              </div>
            </Show>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.RatingType}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={() => { ratingItem().ratingType = "Star"; fullArrange(store); serverOrRemote.updateItem(ratingItem(), store.general.networkStatus); store.overlay.toolbarPopupInfoMaybe.set(null); }}>
              Star
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { ratingItem().ratingType = "Number"; fullArrange(store); serverOrRemote.updateItem(ratingItem(), store.general.networkStatus); store.overlay.toolbarPopupInfoMaybe.set(null); }}>
              Number
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { ratingItem().ratingType = "HorizontalBar"; fullArrange(store); serverOrRemote.updateItem(ratingItem(), store.general.networkStatus); store.overlay.toolbarPopupInfoMaybe.set(null); }}>
              Horizontal Bar
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { ratingItem().ratingType = "VerticalBar"; fullArrange(store); serverOrRemote.updateItem(ratingItem(), store.general.networkStatus); store.overlay.toolbarPopupInfoMaybe.set(null); }}>
              Vertical Bar
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.QrLink}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
            <canvas id="qrcanvas" style="margin: auto; width: 200px; height: 200px; margin-top: 12px;" width="200" height="200" />
            <Show when={compositeItemMaybe() != null}>
              <div style="width: 100%; margin-top: -20px; color: #00a; cursor: pointer;" class="text-center" onclick={linkCompositeIdClickHandler}>copy composite url</div>
            </Show>
            <Show when={compositeItemMaybe() == null}>
              <div style="width: 100%; margin-top: -20px; color: #00a; cursor: pointer;" class="text-center" onclick={linkItemIdClickHandler}>copy url</div>
            </Show>
            <div class="inline-block text-slate-800 text-xs p-[6px] ml-[30px] mt-[6px]">
              <span class="font-mono text-slate-400">{store.history.getFocusItem().itemType[0].toUpperCase() + store.history.getFocusItem().itemType.substring(1)} Id:</span><br />
              <span class="font-mono text-slate-400">{`${store.history.getFocusItem().id}`}</span>
              <i class={`fa fa-copy text-slate-400 cursor-pointer ml-2`} onclick={copyItemIdClickHandler} />
            </div>
            <Show when={compositeItemMaybe() != null}>
              <div class="inline-block text-slate-800 text-xs p-[6px] ml-[30px] mt-[6px]">
                <span class="font-mono text-slate-400">Composite Id:</span><br />
                <span class="font-mono text-slate-400">{`${compositeItemMaybe()!.id}`}</span>
                <i class={`fa fa-copy text-slate-400 cursor-pointer ml-2`} onclick={copyCompositeIdClickHandler} />
              </div>
            </Show>
            <Show when={isPage(store.history.getFocusItem()) || isTable(store.history.getFocusItem())}>
              <div class="text-slate-800 text-xs p-[6px] ml-[30px]">
                {(() => {
                  const currentItem = store.history.getFocusItem();
                  const stats = calculateChildrenStats(currentItem);
                  return (
                    <>
                      <span class="font-mono text-slate-400">Children: {stats.totalChildren}</span><br />
                      <span class="font-mono text-slate-400">Images & Files: {stats.imageFileChildren}</span><br />
                      <span class="font-mono text-slate-400">Total Size: {formatBytes(stats.totalBytes)}</span>
                    </>
                  );
                })()}
              </div>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
               style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY};`}
               onMouseDown={handleMouseDown}>
            <Show when={label() != null}>
              {overlayType() == ToolbarPopupType.TableNumCols || overlayType() == ToolbarPopupType.PageNumCols || overlayType() == ToolbarPopupType.PageCalendarDayRowHeight
                ? <div class="flex items-center mt-[7px]">
                    <div class="text-sm ml-2 mr-2">{label()}</div>
                    <input ref={textElement}
                          class="p-[2px] focus:outline-none"
                          style={`width: ${inputWidthPx() - 50}px`}
                          type="range"
                          min={overlayType() == ToolbarPopupType.PageCalendarDayRowHeight ? "1" : "1"}
                          max={overlayType() == ToolbarPopupType.PageCalendarDayRowHeight ? "8" : "20"}
                          value={sliderValue()}
                          onInput={handleSliderInput}
                          onKeyDown={handleKeyDown}
                          onKeyUp={handleKeyUp}
                          onKeyPress={handleKeyPress}/>
                    <span class="ml-1 text-sm font-mono w-6 text-center">{sliderValue()}</span>
                  </div>
                : <div class="inline-block">
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
                  </div>
              }
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
