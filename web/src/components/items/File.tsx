/*
  Copyright (C) 2023 The Infumap Authors
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

import { Component, createMemo, For } from "solid-js";
import { asFileItem, calcFileSizeForSpatialBl } from "../../store/desktop/items/file-item";
import { GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { VisualElementInTable, VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";
import { ITEM_TYPE_FILE } from "../../store/desktop/items/base/item";
import { HTMLDivElementWithData } from "../../util/html";


export const File: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const fileItem = () => asFileItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    nodeElement!.data = {
      itemType: ITEM_TYPE_FILE,
      itemId: props.visualElement.itemId,
      parentId: fileItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes(),
      children: []
    };
    return currentBoundsPx;
  };
  const sizeBl = createMemo(() => calcFileSizeForSpatialBl(fileItem()));
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());

  return (
    <div ref={nodeElement}
         id={props.visualElement.itemId}
         class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <div style={`position: absolute; left: 0px; top: ${-LINE_HEIGHT_PX/5}px; width: ${naturalWidthPx()}px; ` +
                  `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                  `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
        <span class="text-green-800 cursor-pointer">{fileItem().title}</span>
      </div>
      <For each={props.visualElement.attachments()}>{attachment =>
        <VisualElementOnDesktop visualElement={attachment} />
      }</For>
    </div>
  );
}


export const FileInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const fileItem = () => asFileItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    nodeElement!.data = {
      itemType: ITEM_TYPE_FILE,
      itemId: props.visualElement.itemId,
      parentId: fileItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes(),
      children: []
    };
    return currentBoundsPx;
  };
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div class="absolute text-center"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-file`} />
      </div>
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class="text-green-800 cursor-pointer">{fileItem().title}</span>
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementInTable visualElement={attachment} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
    </>
  );
}
