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

import { Component, For, JSX, Match, Show, Switch, createEffect, onCleanup } from "solid-js";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, LINE_HEIGHT_PX, Z_INDEX_SHADOW } from "../../constants";
import { asImageItem } from "../../items/image-item";
import { BoundingBox, Dimensions, cloneBoundingBox, quantizeBoundingBox } from "../../util/geometry";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { getImage, releaseImage } from "../../imageManager";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { ImageFlags } from "../../items/base/flags-item";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Image_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  let imgElement: HTMLImageElement | undefined;

  const imageItem = () => asImageItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
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
  const isDetailed = () => { return (props.visualElement.flags & VisualElementFlags.Detailed) }
  const thumbnailSrc = () => { return "data:image/png;base64, " + imageItem().thumbnail; }
  const imgOrigin = () => { return props.visualElement.displayItem.origin; }
  const imgSrc = () => { return "/files/" + props.visualElement.displayItem.id + "_" + imageWidthToRequestPx(true); }
  // const imgUrl = () => {
  //   if (!props.visualElement.isDetailed) {
  //     return "data:image/png;base64, " + imageItem().thumbnail;
  //   }
  //   return "/files/" + props.visualElement.itemId + "_" + imageWidthToRequestPx(true);
  // };
  const showTriangleDetail = () => (boundsPx().w / (imageItem().spatialWidthGr / GRID_SIZE)) > 0.5;

  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };

  const imageWidthToRequestPx = (lockToResizingFromBounds: boolean) => {
    let boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
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

  const noCropWidth = (lockToResizingFromBounds: boolean) => {
    let boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    let boundsAspect = boundsPx.w / boundsPx.h;
    // reverse of the crop case.
    if (boundsAspect > imageAspect()) {
      return Math.round(boundsPx.w / (boundsAspect/imageAspect()));
    } else {
      return boundsPx.w;
    }
  }

  const imageSizePx = (lockToResizingFromBounds: boolean): Dimensions => {
    const wPx = noCropWidth(lockToResizingFromBounds);
    const hPx = wPx / imageAspect();
    return { w: wPx, h: hPx };
  }

  const noCropPaddingTopPx = (lockToResizingFromBounds: boolean): number => {
    const boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    const imgSizePx = imageSizePx(lockToResizingFromBounds);
    const result = Math.round((boundsPx.h - imgSizePx.h)/2.0);
    if (result <= 0) { return 0; }
    return result;
  }

  const noCropPaddingLeftPx = (lockToResizingFromBounds: boolean): number => {
    const boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    const imgSizePx = imageSizePx(lockToResizingFromBounds);
    const result = Math.round((boundsPx.w - imgSizePx.w)/2.0);
    if (result <= 0) { return 0; }
    return result;
  }

  const isMainPoppedUp = () =>
    store.history.currentPopupSpecVeid() != null &&
    VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0;

  // Note: The image requested has the same size as the div. Since the div has a border of
  // width 1px, the image is 2px wider or higher than necessary (assuming there are no
  // rounding errors, which there may be, so this adds the perfect degree of safety).

  const BORDER_WIDTH_PX = 1;


  let isDetailed_OnLoad = isDetailed();
  let currentImgSrc = imgSrc();
  let imgOriginOnLoad = imgOrigin();
  let isMounting = true;

  createEffect(() => {
    const nextId = props.visualElement.displayItem.id;
    if (nextId != imgSrc()) {
      if (isDetailed_OnLoad) {
        if (!isMounting) {
          releaseImage(currentImgSrc);
        }
        isMounting = false;
        currentImgSrc = imgSrc();
        imgElement!.src = "";
        const isHighPriority = (props.visualElement.flags & VisualElementFlags.Popup) != 0;
        getImage(currentImgSrc, imgOriginOnLoad, isHighPriority)
          .then((objectUrl) => {
            imgElement!.src = objectUrl;
          });
      }
    }
  });

  onCleanup(() => {
    if (isDetailed_OnLoad) {
      releaseImage(currentImgSrc);
    }
  });

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();


  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Popup) &&
                !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-slate-700 rounded-sm shadow-lg bg-white`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderPopupBaseMaybe = (): JSX.Element =>
    <Show when={props.visualElement.flags & VisualElementFlags.Popup}>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} ` +
                  `text-xl font-bold rounded-md p-8 blur-md pointer-events-none`}
           style={`left: ${boundsPx().x-10}px; ` +
                  `top: ${boundsPx().y-10 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `width: ${boundsPx().w+20}px; ` +
                  `height: ${boundsPx().h+20}px; ` +
                  `background-color: #303030d0;` +
                  `${VeFns.zIndexStyle(props.visualElement)}`} />
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} ` +
                  `border border-slate-700 rounded-sm overflow-hidden pointer-events-none`}
            style={`left: ${quantizedBoundsPx().x}px; ` +
                   `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                   `width: ${quantizedBoundsPx().w}px; ` +
                   `height: ${quantizedBoundsPx().h}px;` +
                   `${VeFns.zIndexStyle(props.visualElement)}`}>
        <img class="max-w-none absolute pointer-events-none"
             style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                    `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px; ` +
                    `height: ${imageWidthToRequestPx(false) / imageAspect()}px;`}
             width={imageWidthToRequestPx(false)}
             height={imageWidthToRequestPx(false) / imageAspect()}
             src={thumbnailSrc()} />
      </div>
    </Show>;

  const tooSmallFallback = (): JSX.Element =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} ` +
                `border border-slate-700 overflow-hidden pointer-events-none`}
          style={`left: ${quantizedBoundsPx().x}px; ` +
                 `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                 `width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;`} />;

  const notDetailedFallback = (): JSX.Element =>
    <img class="max-w-none absolute pointer-events-none"
          style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                 `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px; ` +
                 `height: ${imageWidthToRequestPx(false) / imageAspect()}px;`}
          width={imageWidthToRequestPx(false)}
          height={imageWidthToRequestPx(false) / imageAspect()}
          src={thumbnailSrc()} />;

  const renderTitleMaybe = (): JSX.Element =>
    <Show when={props.visualElement.flags & VisualElementFlags.Popup}>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed": "absolute"} flex items-center justify-center pointer-events-none`}
            style={`left: ${boundsPx().x}px; ` +
                   `top: ${boundsPx().y + boundsPx().h - 50 + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                   `width: ${boundsPx().w}px; ` +
                   `height: ${50}px;` +
                   `${VeFns.zIndexStyle(props.visualElement)}`}>
        <div class="flex items-center text-center text-xl font-bold text-white pointer-events-none">
          {imageItem().title}
        </div>
      </div>
    </Show>;

  const renderAttachmentsAndDetailMaybe = (): JSX.Element =>
    <Show when={isDetailed()}>
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} pointer-events-none`}
          style={`left: ${quantizedBoundsPx().x}px; ` +
                `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                `width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;` +
                `${VeFns.zIndexStyle(props.visualElement)} ${VeFns.opacityStyle(props.visualElement)}`}>
        <For each={props.visualElement.attachmentsVes}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} />
        }</For>
        <Show when={showMoveOutOfCompositeArea()}>
          <div class={`absolute rounded-sm`}
               style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                      `background-color: ${FEATURE_COLOR};`} />
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null && !(props.visualElement.flags & VisualElementFlags.Popup) && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                    showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
        <Show when={showTriangleDetail()}>
          <InfuResizeTriangle />
        </Show>
      </div>
    </Show>;

  const renderCroppedImage = (): JSX.Element =>
    <img ref={imgElement}
         class="max-w-none absolute pointer-events-none"
         style={`left: -${Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX}px; ` +
                `top: -${Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX}px;` +
                `${VeFns.zIndexStyle(props.visualElement)}`}
         width={imageWidthToRequestPx(false)} />;

  const renderNoCropImage = (): JSX.Element =>
    <img ref={imgElement}
         class="max-w-none absolute pointer-events-none"
         style={`${VeFns.zIndexStyle(props.visualElement)} ` +
                `left: ${noCropPaddingLeftPx(false)}px; ` +
                `top: ${noCropPaddingTopPx(false)}px;`}
         width={noCropWidth(false)} />;

  return (
    <Show when={boundsPx().w > 5} fallback={tooSmallFallback()}>
      {renderPopupBaseMaybe()}
      {renderShadowMaybe()}
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} ` +
                  `overflow-hidden pointer-events-none border rounded-sm ` +
                  (imageItem().flags & ImageFlags.HideBorder ? 'border-transparent' : `border-slate-700 `)}
           style={`left: ${quantizedBoundsPx().x}px; ` +
                  `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                  `width: ${quantizedBoundsPx().w}px; ` +
                  `height: ${quantizedBoundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)} ${VeFns.opacityStyle(props.visualElement)}`}>
        <Show when={isDetailed()} fallback={notDetailedFallback()}>
          {imageItem().flags & ImageFlags.NoCrop ? renderNoCropImage() : renderCroppedImage()}
          <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || (isMainPoppedUp() && !(props.visualElement.flags & VisualElementFlags.Popup))}>
            <div class="absolute"
                 style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; ` +
                        `background-color: #dddddd88; ${VeFns.zIndexStyle(props.visualElement)}`} />
          </Show>
          <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
            <div class="absolute rounded-sm"
                 style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                        `background-color: #ff0000; ${VeFns.zIndexStyle(props.visualElement)}`} />
          </Show>
          <Show when={store.perVe.getMouseIsOver(vePath()) && !store.anItemIsMoving.get() && !isInComposite()}>
            <div class="absolute"
                 style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; ` +
                        `background-color: #ffffff33; ${VeFns.zIndexStyle(props.visualElement)}`} />
          </Show>
        </Show>
      </div>
      {renderAttachmentsAndDetailMaybe()}
      {renderTitleMaybe()}
    </Show>
  );
}


export const Image_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const imageItem = () => asImageItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-image`} />
    </div>;

  const renderText = () =>
    <div id={props.visualElement.displayItem.id}
         class="absolute overflow-hidden"
         style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${(boundsPx().w - oneBlockWidthPx())/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span class="text-red-800 cursor-pointer">{imageItem().title}<span></span></span>
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                showTriangleDetail()}>
      <div class="absolute text-center text-slate-600"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIcon()}
      {renderText()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
