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

import { Component, For, Show } from "solid-js";
import { GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { asImageItem } from "../../store/desktop/items/image-item";
import { asTableItem } from "../../store/desktop/items/table-item";
import { quantizeBoundingBox } from "../../util/geometry";
import { VisualElementInTableFn, VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktopFn, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";


export const Image: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  const imageItem = () => asImageItem(desktopStore.getItem(props.visualElement.itemId)!);
  const quantizedBoundsPx = () => quantizeBoundingBox(props.visualElement.boundsPx());
  const resizingFromBoundsPx = () => props.visualElement.resizingFromBoundsPx != null ? quantizeBoundingBox(props.visualElement.resizingFromBoundsPx!) : null;
  const imageAspect = () => imageItem().imageSizePx.w / imageItem().imageSizePx.h;
  const imgUrl = () => {
    if (!props.visualElement.isTopLevel) {
      return "data:image/png;base64, " + imageItem().thumbnail;
    }
    return "/files/" + props.visualElement.itemId + "_" + imageWidthToRequestPx(true);
  };

  const imageWidthToRequestPx = (lockToResizinFromBounds: boolean) => {
    let boundsPx = (resizingFromBoundsPx() == null || !lockToResizinFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    let boundsAspect = boundsPx.w / boundsPx.h;
    if (boundsAspect > imageAspect()) {
      // Bounds is flatter than the image, so:
      //   - Image needs to be cropped top and bottom.
      //   - Bounds width determines width of image to request.
      return boundsPx.w;
    } else {
      // Image is flatter than bounds, so:
      //   - Image needs to be cropped left and right.
      //   - Bounds height determines width of image to request.
      return Math.round(boundsPx.w / (boundsAspect/imageAspect()));
    }
  }

  // Note: The image requested has the same size as the div. Since the div has a border of
  // width 1px, the image is 2px wider or higher than necessary (assuming there are no
  // rounding errors, which there may be, so this adds the perfect degree of safety).

  const BORDER_WIDTH_PX = 1;

  return (
    <Show when={quantizedBoundsPx().w > 5}>
      <div class="absolute border border-slate-700 rounded-sm shadow-lg overflow-hidden"
           style={`left: ${quantizedBoundsPx().x}px; top: ${quantizedBoundsPx().y}px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;`}>
        <img class="max-w-none absolute"
             style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                    `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px;`}
             width={imageWidthToRequestPx(false)}
             src={imgUrl()} />
      </div>
      <For each={props.visualElement.attachments()}>{attachment =>
        <VisualElementOnDesktopFn visualElement={attachment} />
      }</For>
    </Show>
  );
}


export const ImageInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  const imageItem = () => asImageItem(desktopStore.getItem(props.visualElement.itemId)!);
  const boundsPx = props.visualElement.boundsPx;
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
        <i class={`fas fa-image`} />
        <For each={props.visualElement.attachments()}>{attachment =>
          <VisualElementInTableFn visualElement={attachment} parentVisualElement={props.parentVisualElement} />
        }</For>
      </div>
      <div class="absolute overflow-hidden"
          style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class="text-red-800 cursor-pointer">{imageItem().title}</span>
      </div>
    </>
  );
}
