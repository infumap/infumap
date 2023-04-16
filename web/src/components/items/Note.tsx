/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { Component, createMemo, For, Show } from "solid-js";
import { asNoteItem, calcNoteSizeForSpatialBl } from "../../store/desktop/items/note-item";
import { GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";
import { ITEM_TYPE_NOTE } from "../../store/desktop/items/base/item";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElement_Concrete } from "../../store/desktop/visual-element";


export const Note: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const noteItem = () => asNoteItem(desktopStore.getItem(props.visualElement.itemId)!);
  // refer to: visual-element.ts
  const boundsPx_cache = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    (nodeElement!.data as VisualElement_Concrete) = {
      itemType: ITEM_TYPE_NOTE,
      itemId: props.visualElement.itemId,
      parentId: noteItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes()
    };
    return currentBoundsPx;
  };
  const boundsPx = props.visualElement.boundsPx;
  const hitboxes = props.visualElement.hitboxes;
  const sizeBl = createMemo(() => calcNoteSizeForSpatialBl(noteItem()));
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());

  return (
    <div ref={nodeElement}
         id={props.visualElement.itemId}
         class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx_cache().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={props.visualElement.isInteractive}>
        <div style={`position: absolute; left: 0px; top: ${-LINE_HEIGHT_PX/5}px; width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
          <Show when={noteItem().url != null && hitboxes().length > 0}
                fallback={<span>{noteItem().title}</span>}>
            <span class={`${noteItem().url == "" ? "" : "text-blue-800 cursor-pointer"}`}>{noteItem().title}</span>
          </Show>
        </div>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementOnDesktop visualElement={attachment} />
        }</For>
      </Show>
    </div>
  );
}


export const NoteInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const noteItem = () => asNoteItem(desktopStore.getItem(props.visualElement.itemId)!);
  // refer to: visual-element.ts
  const boundsPx_cache = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    (nodeElement!.data as VisualElement_Concrete) = {
      itemType: ITEM_TYPE_NOTE,
      itemId: props.visualElement.itemId,
      parentId: noteItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes()
    };
    return currentBoundsPx;
  };
  const boundsPx = props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr.get() / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div class="absolute text-center"
           style={`left: ${boundsPx_cache().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-sticky-note`} />
      </div>
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class="absolute overflow-hidden"
           style={`left: ${boundsPx_cache().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class={`${noteItem().url == "" ? "" : "text-blue-800 cursor-pointer"}`}>{noteItem().title}</span>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementInTable visualElement={attachment} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
