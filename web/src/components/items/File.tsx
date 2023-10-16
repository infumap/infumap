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

import { Component, For, Show } from "solid-js";
import { FileFns, asFileItem } from "../../items/file-item";
import { ATTACH_AREA_SIZE_PX, FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns} from "../../items/base/item-polymorphism";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";
import { asXSizableItem } from "../../items/base/x-sizeable-item";


export const File: Component<VisualElementProps> = (props: VisualElementProps) => {
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
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      const cloned = FileFns.asFileMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      cloned.spatialWidthGr = asXSizableItem(VeFns.canonicalItem(VesCache.get(props.visualElement.parentPath!)!.get())).spatialWidthGr;
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return FileFns.calcSpatialDimensionsBl(fileItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideComposite) {
      return 'absolute rounded-sm bg-white';
    } else {
      return 'absolute border border-slate-700 rounded-sm shadow-lg bg-white';
    }
  };

  const zIndexStyle = () => props.visualElement.flags & VisualElementFlags.TopZ ? " z-index: 10;" : "";

  return (
    <div class={outerClass()}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
        <div style={`position: absolute; ` +
                    `left: ${NOTE_PADDING_PX}px; ` +
                    `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)}px; ` +
                    `width: ${naturalWidthPx()}px; ` +
                    `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
                    `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                    `overflow-wrap: break-word;` +
                    `${zIndexStyle()}`}>
          <span class="text-green-800 cursor-pointer">{fileItem().title}</span>
        </div>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} />
        }</For>
        <Show when={props.visualElement.linkItemMaybe != null}>
          <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;` +
                      `${zIndexStyle()}`} />
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttach.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
        <Show when={props.visualElement.movingItemIsOverAttachComposite.get()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
      </Show>
    </div>
  );
}


export const FileLineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const fileItem = () => asFileItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w
    : boundsPx().w - oneBlockWidthPx();

  return (
    <>
      <Show when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`} />
      </Show>
      <Show when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
      </Show>
      <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
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
