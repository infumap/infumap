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

import { Component, Show, onCleanup, onMount } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { server } from "../../server";
import { InfuIconButton } from "../library/InfuIconButton";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { createBooleanSignal } from "../../util/signals";
import { StyleSelectOverlay } from "./StyleSelectOverlay";
import { desktopPxFromMouseEvent, isInside } from "../../util/geometry";
import { AlignmentSelectOverlay } from "./AlignmentSelectOverlay";


export const TextEditOverlay: Component = () => {
  const desktopStore = useDesktopStore();

  let textElement: HTMLTextAreaElement | undefined;

  const styleOverlayVisible = createBooleanSignal(false);
  const alignmentOverlayVisible = createBooleanSignal(false);
  const linkOverlayVisible = createBooleanSignal(false);
  const additionalOverlayVisible = createBooleanSignal(false);

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(noteVisualElement());
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);
  const noteItemOnInitialize = noteItem();

  const toolboxBoundsPx = () => {
    return ({
      x: noteVeBoundsPx().x + noteVeBoundsPx().w + 10,
      y: noteVeBoundsPx().y - 2,
      w: 120,
      h: 120
    });
  }

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
    ev.stopPropagation();
    const desktopPx = desktopPxFromMouseEvent(ev);
    if (isInside(desktopPx, noteVeBoundsPx()) || isInside(desktopPx, toolboxBoundsPx())) { return; }
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const keyDownListener = (ev: KeyboardEvent) => {
    if (ev.code == 'Enter') {
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

  const styleButtonHandler = () => { styleOverlayVisible.set(!styleOverlayVisible.get()); }
  const alignmentButtonHandler = () => { alignmentOverlayVisible.set(!alignmentOverlayVisible.get()); }
  const linkButtonHandler = () => { linkOverlayVisible.set(!linkOverlayVisible.get()); }
  const additionalButtonHandler = () => { additionalOverlayVisible.set(!additionalOverlayVisible.get()); }

  const textAreaMouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
  }

  const textAreaOnInputHandler = () => {
    noteItem().title = textElement!.value;
    arrange(desktopStore);
  }

  const isLeftAlign = () => {

  }

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <InfuIconButton icon="font" highlighted={false} clickHandler={styleButtonHandler} />
        <InfuIconButton icon="align-left" highlighted={false} clickHandler={alignmentButtonHandler} />
        <InfuIconButton icon="link" highlighted={false} clickHandler={linkButtonHandler} />
        <InfuIconButton icon="ellipsis-h" highlighted={false} clickHandler={additionalButtonHandler} />
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
      <Show when={styleOverlayVisible.get()}>
        <StyleSelectOverlay styleOverlayVisible={styleOverlayVisible} />
      </Show>
      <Show when={alignmentOverlayVisible.get()}>
        <AlignmentSelectOverlay alignmentOverlayVisible={alignmentOverlayVisible} />
      </Show>
      <Show when={linkOverlayVisible.get()}>
        <div>link overlay visible</div>
      </Show>
      <Show when={additionalOverlayVisible.get()}>
        <div>additional overlay visible</div>
      </Show>
    </div>
  );
}
