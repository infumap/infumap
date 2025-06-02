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

import { Component, For, JSX, Show, createEffect, onCleanup } from "solid-js";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, MIN_IMAGE_WIDTH_PX, Z_INDEX_SHADOW } from "../../constants";
import { asImageItem } from "../../items/image-item";
import { BoundingBox, Dimensions, quantizeBoundingBox } from "../../util/geometry";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { getImage, releaseImage } from "../../imageManager";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { ImageFlags } from "../../items/base/flags-item";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { createInfuSignal } from "../../util/signals";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Image_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

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
  const isDetailed = () => { return (props.visualElement.flags & VisualElementFlags.Detailed) != 0; }
  const isPopup = () => {
    try {
      return (props.visualElement.flags & VisualElementFlags.Popup) != 0;
    } catch (e) {
      console.warn("Error in isPopup:", e, "props:", props, "visualElement:", props?.visualElement);
      return false;
    }
  }
  const thumbnailSrc = () => { return "data:image/png;base64, " + imageItem().thumbnail; }
  const imgOrigin = () => { return props.visualElement.displayItem.origin; }
  const imgSrc = () => "/files/" + props.visualElement.displayItem.id + "_" + imageWidthToRequestPx(true);
  const showTriangleDetail = () => (boundsPx().w / (imageItem().spatialWidthGr / GRID_SIZE)) > 0.5;

  const imgSrcSignal = createInfuSignal<string | undefined>(undefined);

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

  const isMainPoppedUp = () => {
    try {
      if (store.history.currentPopupSpecVeid() == null) {
        return false;
      }
      return VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0;
    } catch (e) {
      console.warn("Error in isMainPoppedUp:", e, "props:", props, "visualElement:", props?.visualElement);
      return false;
    }
  };

  // Note: The image requested has the same size as the div. Since the div has a border of
  // width 1px, the image is 2px wider or higher than necessary (assuming there are no
  // rounding errors, which there may be, so this adds the perfect degree of safety).

  const BORDER_WIDTH_PX = 1;


  let isDetailed_OnLoad = isDetailed();
  let currentImgSrc = "";
  let imgOriginOnLoad = imgOrigin();
  let isMounting = true;
  let isShowingThumbnail = createInfuSignal<boolean>(true);

  // TODO (LOW): Better behavior when imageWidthToRequestPx <= MIN_IMAGE_WIDTH_PX.
  createEffect(() => {
    if (currentImgSrc != imgSrc() && !store.anItemIsResizing.get()) {
      if (isDetailed_OnLoad) {
        if (!isMounting) {
          releaseImage(currentImgSrc);
        }
        isMounting = false;
        currentImgSrc = imgSrc();
        const imageIdOnRequest = props.visualElement.displayItem.id;
        imgSrcSignal.set(thumbnailSrc());
        isShowingThumbnail.set(true);
        const isHighPriority = isPopup();
        getImage(currentImgSrc, imgOriginOnLoad, isHighPriority)
          .then((objectUrl) => {
            try {
              // props.visualElement is actually a function call, which will fail if the component is unmounted.
              if (props.visualElement == null) {
                // dummy statement to ensure the check is not optimized away.
                return;
              }
            }
            catch (e) {
              // expected behavior when the component is unmounted.
              return;
            }
            if (isPopup()) {
              if (imageIdOnRequest == props.visualElement.displayItem.id) {
                imgSrcSignal.set(objectUrl);
                isShowingThumbnail.set(false);
              } else {
                const prevObjectUrl = imgSrcSignal.get();
                // temporarily set the image src to the out-of-date fetched image to force the browser to cache the image.
                // if this is not done, the image will need to be re-fetched if the user re-selects the image (which they will often do).
                imgSrcSignal.set(objectUrl);
                setTimeout(() => { imgSrcSignal.set(prevObjectUrl) }, 0);
              }
            } else {
              imgSrcSignal.set(objectUrl);
              isShowingThumbnail.set(false);
            }
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
                !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
                !(props.visualElement.flags & VisualElementFlags.DockItem) &&
                (!(imageItem().flags & ImageFlags.HideBorder) || store.perVe.getMouseIsOver(vePath()))}>
      <div class={`absolute border border-transparent rounded-sm shadow-xl bg-white`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
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
                  `border border-[#555] rounded-sm overflow-hidden pointer-events-none`}
            style={`left: ${quantizedBoundsPx().x}px; ` +
                   `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                   `width: ${quantizedBoundsPx().w}px; ` +
                   `height: ${quantizedBoundsPx().h}px;` +
                   `${VeFns.zIndexStyle(props.visualElement)}`}>
        <img class="max-w-none absolute pointer-events-none"
             style={`height: ${imageWidthToRequestPx(false) / imageAspect()}px;`}
             width={imageWidthToRequestPx(false)}
             height={imageWidthToRequestPx(false) / imageAspect()}
             src={thumbnailSrc()} />
      </div>
    </Show>;

  const tooSmallFallback = (): JSX.Element =>
    <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} ` +
                `border border-[#555] overflow-hidden pointer-events-none`}
          style={`left: ${quantizedBoundsPx().x}px; ` +
                 `top: ${quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0)}px; ` +
                 `width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px;`} />;

  const notDetailedFallback = (): JSX.Element =>
    <img class="max-w-none absolute pointer-events-none"
         style={`height: ${imageWidthToRequestPx(false) / imageAspect()}px;`}
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
        <Show when={props.visualElement.linkItemMaybe != null &&
                    (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                    showTriangleDetail() &&
                    !((props.visualElement.flags & VisualElementFlags.Popup) && (props.visualElement.actualLinkItemMaybe == null)) &&
                    (!(imageItem().flags & ImageFlags.HideBorder) || store.perVe.getMouseIsOver(vePath()))}>
          <InfuLinkTriangle />
        </Show>
        <Show when={showTriangleDetail() &&
                    (!(imageItem().flags & ImageFlags.HideBorder) || store.perVe.getMouseIsOver(vePath()))}>
          <InfuResizeTriangle />
        </Show>
      </div>
    </Show>;

  const renderCroppedImage = (): JSX.Element =>
    <img src={imgSrcSignal.get()}
         class="max-w-none absolute pointer-events-none"
         style={`left: ${isShowingThumbnail.get() ? 0 : -(Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w)/2.0) + BORDER_WIDTH_PX)}px; ` +
                `top: ${isShowingThumbnail.get() ? 0 : -(Math.round((imageWidthToRequestPx(false)/imageAspect() - quantizedBoundsPx().h)/2.0) + BORDER_WIDTH_PX)}px; ` +
                (isShowingThumbnail.get() ? 'width: 100%; height: 100%; ' : '') +
                `${VeFns.zIndexStyle(props.visualElement)}`}
         width={isShowingThumbnail.get() ? undefined : imageWidthToRequestPx(false)} />;

  const renderNoCropImage = (): JSX.Element =>
    <img src={imgSrcSignal.get()}
         class="max-w-none absolute pointer-events-none"
         style={`${VeFns.zIndexStyle(props.visualElement)} ` +
                (isShowingThumbnail.get() ? 'width: 100%; height: 100%; ' : '') +
                `left: ${isShowingThumbnail.get() ? 0 : noCropPaddingLeftPx(false)}px; ` +
                `top: ${isShowingThumbnail.get() ? 0 : noCropPaddingTopPx(false)}px;`}
         width={isShowingThumbnail.get() ? undefined : noCropWidth(false)} />;

  return (
    <Show when={boundsPx().w > MIN_IMAGE_WIDTH_PX} fallback={tooSmallFallback()}>
      {renderPopupBaseMaybe()}
      {renderShadowMaybe()}
      <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute"} ` +
                  `overflow-hidden border pointer-events-none rounded-sm ${store.perVe.getMouseIsOver(vePath()) ? 'shadow-md' : '' } ` +
                  (imageItem().flags & ImageFlags.HideBorder ? 'border-transparent' : `border-[#555] `)}
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
          <Show when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
            <div class="absolute"
                 style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; ` +
                        `background-color: rgba(255, 255, 0, 0.4); ${VeFns.zIndexStyle(props.visualElement)}`} />
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
