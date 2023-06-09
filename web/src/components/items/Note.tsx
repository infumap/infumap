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

import { Component, createMemo, For, Show } from "solid-js";
import { asNoteItem, calcNoteSizeForSpatialBl } from "../../items/note-item";
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../items/table-item";
import { BoundingBox } from "../../util/geometry";


export const Note: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const noteItem = () => asNoteItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = createMemo(() => calcNoteSizeForSpatialBl(noteItem()));
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  }

  return (
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={props.visualElement.isInteractive}>
        <div style={`position: absolute; left: 0px; top: ${-LINE_HEIGHT_PX/4 * scale()}px; width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
          <Show when={noteItem().url != null && noteItem().url != ""}
                fallback={<span>{noteItem().title}</span>}>
            <span class={`text-blue-800 cursor-pointer`}>{noteItem().title}</span>
          </Show>
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementOnDesktop visualElement={attachment.get()} />
        }</For>
      </Show>
      <Show when={props.visualElement.movingItemIsOverAttach.get()}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: #ff0000;`}>
        </div>
      </Show>
    </div>
  );
}


export const NoteInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const noteItem = () => asNoteItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const tableWidthBl = asTableItem(props.parentVisualElement.item).spatialWidthGr / GRID_SIZE;
    return props.parentVisualElement.boundsPx.w / tableWidthBl;
  }
  const leftPx = () => props.visualElement.isAttachment
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.isAttachment
    ? boundsPx().w
    : boundsPx().w - oneBlockWidthPx();

  return (
    <>
      <Show when={!props.visualElement.isAttachment}>
        <div class="absolute text-center"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                    `transform: scale(${scale()}); transform-origin: top left;`}>
          <i class={`fas fa-sticky-note`} />
        </div>
      </Show>
      <div class="absolute overflow-hidden whitespace-nowrap"
           style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class={`${noteItem().url == "" ? "" : "text-blue-800 cursor-pointer"}`}>{noteItem().title}</span>
      </div>
    </>
  );
}
