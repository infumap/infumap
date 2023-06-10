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

import { Component, For, Show, onCleanup, onMount } from "solid-js";
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { asImageItem } from "../../items/image-item";
import { asTableItem } from "../../items/table-item";
import { BoundingBox, quantizeBoundingBox } from "../../util/geometry";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktop, VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { getImage, releaseImage } from "../../imageManager";


export const Image: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  let imgElement: HTMLImageElement | undefined;

  const imageItem = () => asImageItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const quantizedBoundsPx = () => quantizeBoundingBox(boundsPx());
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const resizingFromBoundsPx = () => props.visualElement.resizingFromBoundsPx != null ? quantizeBoundingBox(props.visualElement.resizingFromBoundsPx!) : null;
  const imageAspect = () => imageItem().imageSizePx.w / imageItem().imageSizePx.h;
  const isInteractive = () => { return props.visualElement.isInteractive; }
  const thumbnailSrc = () => { return "data:image/png;base64, " + imageItem().thumbnail; }
  const imgSrc = () => { return "/files/" + props.visualElement.item.id + "_" + imageWidthToRequestPx(true); }
  // const imgUrl = () => {
  //   if (!props.visualElement.isInteractive) {
  //     return "data:image/png;base64, " + imageItem().thumbnail;
  //   }
  //   return "/files/" + props.visualElement.itemId + "_" + imageWidthToRequestPx(true);
  // };

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


  let isInteractiveOnLoad = isInteractive();
  let imgSrcOnLoad = imgSrc();

  onMount(() => {
    if (isInteractiveOnLoad) {
      // console.debug(`mount: ${imgSrcOnLoad}`);
      getImage(imgSrcOnLoad)
        .then((objectUrl) => {
          imgElement!.src = objectUrl;
        });
    }
  });

  onCleanup(() => {
    // console.debug(`cleanup: ${imgSrcOnLoad}`);
    if (isInteractiveOnLoad) {
      releaseImage(imgSrcOnLoad);
    }
  });

  return (
    <Show when={boundsPx().w > 5}>
      <div class="absolute border border-slate-700 rounded-sm shadow-lg overflow-hidden"
           style={`left: ${quantizedBoundsPx().x}px; top: ${quantizedBoundsPx().y}px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;`}>
        <Show when={isInteractive()} fallback={
            <img class="max-w-none absolute"
                 style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                        `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px;`}
                 width={imageWidthToRequestPx(false)}
                 src={thumbnailSrc()} />
          }>
          <img ref={imgElement}
               class="max-w-none absolute"
               style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                      `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px;`}
               width={imageWidthToRequestPx(false)} />
          <Show when={props.visualElement.movingItemIsOverAttach.get()}>
            <div class={`absolute rounded-sm`}
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000;`}>
            </div>
          </Show>
        </Show>
      </div>
      <div class="absolute pointer-events-none"
           style={`left: ${quantizedBoundsPx().x}px; top: ${quantizedBoundsPx().y}px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;`}>
        <For each={props.visualElement.attachments}>{attachment =>
          <VisualElementOnDesktop visualElement={attachment.get()} />
        }</For>
      </div>
    </Show>
  );
}


export const ImageInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  let nodeElement: HTMLDivElementWithData | undefined;

  const imageItem = () => asImageItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const tableWidthBl = asTableItem(props.parentVisualElement.item).spatialWidthGr / GRID_SIZE;
    return props.parentVisualElement.boundsPx.w / tableWidthBl;
  }

  return (
    <>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-image`} />
      </div>
      <div ref={nodeElement}
           id={props.visualElement.item.id}
           class="absolute overflow-hidden"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class="text-red-800 cursor-pointer">{imageItem().title}</span>
      </div>
    </>
  );
}
