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
import { asFileItem, calcFileSizeForSpatialBl } from "../../items/file-item";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElement_Desktop, VisualElementProps_Desktop, VisualElementProps_LineItem } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { calcSizeForSpatialBl } from "../../items/base/item-polymorphism";
import { attachmentFlagSet, detailedFlagSet } from "../../layout/visual-element";


export const File: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  const fileItem = () => asFileItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const sizeBl = createMemo(() => {
    if (props.visualElement.linkItemMaybe != null) {
      return calcSizeForSpatialBl(props.visualElement.linkItemMaybe!);
    }
    return calcFileSizeForSpatialBl(fileItem());
  });
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());

  return (
    <div class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={detailedFlagSet(props.visualElement)}>
        <div style={`position: absolute; left: 0px; top: ${-LINE_HEIGHT_PX/4 * scale()}px; width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${scale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`}>
          <span class="text-green-800 cursor-pointer">{fileItem().title}</span>
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} />
        }</For>
        <Show when={props.visualElement.linkItemMaybe != null}>
          <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`}></div>
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttach.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`}>
          </div>
        </Show>
      </Show>
    </div>
  );
}


export const FileLineItem: Component<VisualElementProps_LineItem> = (props: VisualElementProps_LineItem) => {
  const fileItem = () => asFileItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const leftPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => attachmentFlagSet(props.visualElement)
    ? boundsPx().w
    : boundsPx().w - oneBlockWidthPx();

  return (
    <>
      <Show when={!attachmentFlagSet(props.visualElement)}>
        <div class="absolute text-center"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                    `transform: scale(${scale()}); transform-origin: top left;`}>
          <i class={`fas fa-file`} />
        </div>
      </Show>
      <div class="absolute overflow-hidden whitespace-nowrap"
           style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class="text-green-800 cursor-pointer">{fileItem().title}</span>
      </div>
    </>
  );
}
