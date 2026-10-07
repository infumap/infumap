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

import { Component, For, JSX, Show, createEffect, onCleanup, untrack } from "solid-js";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, MIN_IMAGE_WIDTH_PX } from "../../constants";
import { FOCUS_RING_BOX_SHADOW } from "../../style";
import { ImageFns, asImageItem } from "../../items/image-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { commitActiveTextEdit, edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { BoundingBox, Dimensions, quantizeBoundingBox } from "../../util/geometry";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { ImageFetchPriority, acquireFetchedImageMaybe, getImage, releaseImage } from "../../imageManager";
import { imagePlaceholderSizePx, imagePlaceholderSrc } from "../../util/imagePlaceholder";
import { VisualElementFlags, VeFns } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { linkHasTriangle } from "../../layout/link-triangle";
import { ImageFlags } from "../../items/base/flags-item";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { createInfuSignal } from "../../util/signals";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { PopupActionStrip } from "../library/PopupActionStrip";
import { calcPopupActionStripLayout } from "../../util/popupHeaderActions";
import { appendNewlineIfEmpty } from "../../util/string";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, documentPageMoveOutBoxPxMaybe, isInsideTranslucentPage, isInsidePopup, shouldShowFocusRingForVisualElement, highlightStyle } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

// Printed images are about 200dpi at the default document width.
const PRINT_IMAGE_RESOLUTION_MULTIPLIER = 2;

// The largest an image in a translucent page is displayed (in CSS pixels), relative to its placeholder, using only
// the placeholder.
const TRANSLUCENT_PLACEHOLDER_MAX_SCALE = 2;

// For debugging: when the localStorage key "debug:image-resolution" is "1" (read on load), each image shows a badge
// with what is shown (P = placeholder, I = interim / partial, F = final) and its resolution relative to the device
// pixels it covers: green >= 95%, amber >= 50%, red below.
const IMAGE_RESOLUTION_DEBUG = (() => {
  try {
    return window.localStorage.getItem("debug:image-resolution") == "1";
  } catch (_e) {
    return false;
  }
})();

type ShownImageKind = "placeholder" | "interim" | "final";

export const Image_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  type PopupImageActionKey = "child" | "default";

  const imageItem = () => asImageItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const canEdit = () => itemCanEdit(imageItem());
  const isEditingTitle = () => canEdit() && store.overlay.textEditInfo()?.itemPath == vePath();
  const boundsPx = () => props.visualElement.boundsPx;
  const quantizedBoundsPx = () => quantizeBoundingBox(boundsPx());
  const positionClass = () => props.visualElement.flags & VisualElementFlags.Fixed ? "fixed" : "absolute";
  const rootTopPx = () => quantizedBoundsPx().y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0);
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const attachInsertBarPx = (): BoundingBox => {
    const innerSizeBl = ImageFns.calcSpatialDimensionsBl(imageItem());
    const blockSizePx = props.visualElement.attachmentBlockSizePx ?? boundsPx().w / innerSizeBl.w;
    const insertIndex = store.perVe.getMoveOverAttachmentIndex(vePath());
    // Special case for position 0: align with right edge of parent item
    const xOffset = insertIndex === 0 ? -4 : -2;
    return {
      x: boundsPx().w - insertIndex * blockSizePx + xOffset,
      y: -blockSizePx / 2,
      w: 4,
      h: blockSizePx,
    };
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
  const thumbnailSrc = () => imagePlaceholderSrc(imageItem().thumbnail);
  const imgOrigin = () => { return props.visualElement.displayItem.origin; }
  // Images are requested at device (not CSS) pixel resolution, so they are sharp on high density displays. Printed
  // images are requested at a fixed higher resolution than they are displayed at, so they print sharply.
  const imageResolutionMultiplier = () =>
    store.printMode.get() ? PRINT_IMAGE_RESOLUTION_MULTIPLIER : store.devicePixelRatio.get();
  const imgSrc = () => {
    let widthPx = Math.round(imageWidthToRequestPx(true) * imageResolutionMultiplier());
    // The server responds with the unmodified original for any width >= the original width. Capping gives such
    // requests a single url (and hence cache entry).
    const originalWidthPx = imageItem().imageSizePx.w;
    if (originalWidthPx > 0 && widthPx > originalWidthPx) { widthPx = originalWidthPx; }
    return "/files/" + props.visualElement.displayItem.id + "_" + widthPx;
  };
  const showTriangleDetail = () => (boundsPx().w / (imageItem().spatialWidthGr / GRID_SIZE)) > 0.5;

  const imgSrcSignal = createInfuSignal<string | undefined>(undefined);
  // What imgSrcSignal is, and the natural width of the loaded image. Only maintained for the resolution debug badge.
  const shownImageKind = createInfuSignal<ShownImageKind>("placeholder");
  const loadedNaturalWidthPx = createInfuSignal<number>(0);
  const recordNaturalWidth = (ev: Event) => { loadedNaturalWidthPx.set((ev.currentTarget as HTMLImageElement).naturalWidth); };
  const BORDER_WIDTH_PX = 1;
  // Standard deviation of the blur applied to placeholders, in placeholder pixels.
  const PLACEHOLDER_BLUR_SIGMA = 1.0;

  const moveOutOfCompositeBox = (): BoundingBox => {
    const documentBox = documentPageMoveOutBoxPxMaybe(props.visualElement);
    if (documentBox != null) { return documentBox; }
    // In a composite, the move hitbox sits at the composite's right edge (aligned with the other children).
    const moveHitbox = isInComposite() ? props.visualElement.hitboxes.find(hitbox => hitbox.meta?.compositeMoveOut) : undefined;
    if (moveHitbox != null) {
      return ({
        x: moveHitbox.boundsPx.x,
        y: moveHitbox.boundsPx.y,
        w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
        h: moveHitbox.boundsPx.h,
      });
    }
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
      return Math.round(boundsPx.w / (boundsAspect / imageAspect()));
    }
  }

  const noCropWidth = (lockToResizingFromBounds: boolean) => {
    let boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    let boundsAspect = boundsPx.w / boundsPx.h;
    // reverse of the crop case.
    if (boundsAspect > imageAspect()) {
      return Math.round(boundsPx.w / (boundsAspect / imageAspect()));
    } else {
      return boundsPx.w;
    }
  }

  const imageSizePx = (lockToResizingFromBounds: boolean): Dimensions => {
    const wPx = noCropWidth(lockToResizingFromBounds);
    const hPx = wPx / imageAspect();
    return { w: wPx, h: hPx };
  }

  const imageFitStyle = (fit: "contain" | "cover" | "fill", fillBorderBox: boolean = false) =>
    (fillBorderBox
      ? `left: -${BORDER_WIDTH_PX}px; top: -${BORDER_WIDTH_PX}px; ` +
        `width: calc(100% + ${BORDER_WIDTH_PX * 2}px); height: calc(100% + ${BORDER_WIDTH_PX * 2}px); `
      : `width: 100%; height: 100%; `) +
    `object-fit: ${fit}; object-position: center center;`;

  const thumbnailFitStyle = () =>
    popupNoCropFrameFollowsImage()
      ? imageFitStyle("fill", true)
      : imageFitStyle(imageItem().flags & ImageFlags.NoCrop ? "contain" : "cover");

  const noCropPaddingTopPx = (lockToResizingFromBounds: boolean): number => {
    const boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    const imgSizePx = imageSizePx(lockToResizingFromBounds);
    const result = Math.round((boundsPx.h - imgSizePx.h) / 2.0);
    if (result <= 0) { return 0; }
    return result;
  }

  const noCropPaddingLeftPx = (lockToResizingFromBounds: boolean): number => {
    const boundsPx = (resizingFromBoundsPx() == null || !lockToResizingFromBounds) ? quantizedBoundsPx() : resizingFromBoundsPx()!;
    const imgSizePx = imageSizePx(lockToResizingFromBounds);
    const result = Math.round((boundsPx.w - imgSizePx.w) / 2.0);
    if (result <= 0) { return 0; }
    return result;
  }

  const localBoundsPx = (): BoundingBox => ({
    x: 0,
    y: 0,
    w: quantizedBoundsPx().w,
    h: quantizedBoundsPx().h,
  });

  const noCropImageBoundsPx = (lockToResizingFromBounds: boolean): BoundingBox => {
    const imgSizePx = imageSizePx(lockToResizingFromBounds);
    return {
      x: noCropPaddingLeftPx(lockToResizingFromBounds),
      y: noCropPaddingTopPx(lockToResizingFromBounds),
      w: imgSizePx.w,
      h: imgSizePx.h,
    };
  };

  const popupNoCropFrameFollowsImage = () =>
    isPopup() && !!(imageItem().flags & ImageFlags.NoCrop);

  const visualFrameBoundsPx = (): BoundingBox =>
    popupNoCropFrameFollowsImage() ? noCropImageBoundsPx(false) : localBoundsPx();

  const boundsStylePx = (boundsPx: BoundingBox): string =>
    `left: ${boundsPx.x}px; top: ${boundsPx.y}px; width: ${boundsPx.w}px; height: ${boundsPx.h}px;`;

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

  let isDetailed_OnLoad = isDetailed();
  // The path of the image rendition currently held (acquired from the image manager), "" if none is held because the
  // placeholder suffices, or null before the first evaluation.
  let currentImgSrc: string | null = null;
  let imgOriginOnLoad = imgOrigin();
  let isMounting = true;
  let isShowingThumbnail = createInfuSignal<boolean>(true);
  // When printing, an already fetched rendition of the image is shown whilst the print resolution one is fetched.
  let printStandInImage: { path: string, origin: string | null } | null = null;

  const releasePrintStandInImageMaybe = () => {
    if (printStandInImage == null) { return; }
    releaseImage(printStandInImage.path, printStandInImage.origin);
    printStandInImage = null;
  };

  // The printed page is laid out as soon as printing starts, before a fetch could complete, so the image must not
  // fall back to the (blurred) placeholder. Returns false if there is nothing better than the placeholder to show.
  const showFetchedImageForPrintMaybe = (): boolean => {
    if (!store.printMode.get()) { return false; }
    if (!untrack(() => isShowingThumbnail.get())) { return true; }
    const fetched = acquireFetchedImageMaybe(props.visualElement.displayItem.id, imgOriginOnLoad);
    if (fetched == null) { return false; }
    releasePrintStandInImageMaybe();
    printStandInImage = { path: fetched.path, origin: imgOriginOnLoad };
    imgSrcSignal.set(fetched.objectUrl);
    isShowingThumbnail.set(false);
    shownImageKind.set("final");
    return true;
  };

  // When the image is displayed no wider (in device pixels) than its placeholder, the placeholder is already at (or
  // above) display resolution, so nothing is fetched. Images in translucent pages are partially obscured, so there the
  // placeholder is used up to TRANSLUCENT_PLACEHOLDER_MAX_SCALE times its size, in CSS pixels. Not when printing, where
  // images are requested at a higher resolution.
  const placeholderSuffices = (): boolean => {
    if (store.printMode.get()) { return false; }
    const placeholderSizePx = imagePlaceholderSizePx(imageItem().thumbnail);
    if (placeholderSizePx == null) { return false; }
    if (untrack(() => isInsideTranslucentPage(props.visualElement))) {
      return imageWidthToRequestPx(false) <= placeholderSizePx.w * TRANSLUCENT_PLACEHOLDER_MAX_SCALE;
    }
    return imageWidthToRequestPx(false) * store.devicePixelRatio.get() <= placeholderSizePx.w;
  };

  createEffect(() => {
    const wantedImgSrc = placeholderSuffices() ? "" : imgSrc();
    if (currentImgSrc != wantedImgSrc && !store.anItemIsResizing.get()) {
      if (isDetailed_OnLoad) {
        if (!isMounting) {
          if (currentImgSrc != null && currentImgSrc !== "") {
            releaseImage(currentImgSrc, imgOriginOnLoad);
          }
        }
        isMounting = false;
        currentImgSrc = wantedImgSrc;
        if (wantedImgSrc == "") {
          releasePrintStandInImageMaybe();
          imgSrcSignal.set(thumbnailSrc());
          isShowingThumbnail.set(true);
          shownImageKind.set("placeholder");
          return;
        }
        const imgSrcOnRequest = wantedImgSrc;
        const imgOriginOnRequest = imgOriginOnLoad;
        const imageIdOnRequest = props.visualElement.displayItem.id;
        if (!showFetchedImageForPrintMaybe()) {
          imgSrcSignal.set(thumbnailSrc());
          isShowingThumbnail.set(true);
          shownImageKind.set("placeholder");
        }
        const priority = isPopup()
          ? ImageFetchPriority.High
          : untrack(() => isInsidePopup(props.visualElement))
            ? ImageFetchPriority.PopupContent
            : untrack(() => isInsideTranslucentPage(props.visualElement)) ? ImageFetchPriority.Low : ImageFetchPriority.Normal;
        // A lower resolution rendition, shown in place of the placeholder until the requested one arrives.
        const onInterim = (interimObjectUrl: string) => {
          try {
            if (props.visualElement == null) { return; }
          } catch (e) {
            // expected behavior when the component is unmounted.
            return;
          }
          // Not if superseded by a later request, or something better than the placeholder is shown. Never when
          // printing, which must wait for the requested resolution.
          if (currentImgSrc != imgSrcOnRequest ||
              imageIdOnRequest != props.visualElement.displayItem.id ||
              !isShowingThumbnail.get() ||
              store.printMode.get()) {
            return;
          }
          imgSrcSignal.set(interimObjectUrl);
          isShowingThumbnail.set(false);
          shownImageKind.set("interim");
        };
        getImage(imgSrcOnRequest, imgOriginOnRequest, priority, onInterim)
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
                shownImageKind.set("final");
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
              shownImageKind.set("final");
              releasePrintStandInImageMaybe();
            }
          })
          .catch((error) => {
            const originMessage = imgOriginOnRequest == null ? "" : ` from '${imgOriginOnRequest}'`;
            console.warn(`Could not fetch image '${imgSrcOnRequest}'${originMessage}:`, error);
          });
      }
    }
  });

  onCleanup(() => {
    releasePrintStandInImageMaybe();
    if (isDetailed_OnLoad) {
      if (currentImgSrc != null && currentImgSrc !== "") {
        releaseImage(currentImgSrc, imgOriginOnLoad);
      }
    }
  });

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const isInCompositeInDocumentPage = () => {
    if (!isInComposite()) { return false; }
    const compositeParentPath = VeFns.parentPath(props.visualElement.parentPath!);
    if (compositeParentPath == "") { return false; }
    const compositeParent = itemState.get(VeFns.veidFromPath(compositeParentPath).itemId);
    return compositeParent != null && isPage(compositeParent) &&
      asPageItem(compositeParent).arrangeAlgorithm == ArrangeAlgorithm.Document;
  };

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    (store.perVe.getMouseIsOver(vePath()) || store.perVe.getMouseIsOverDocumentRowSide(vePath())) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  // Check if this image is currently focused (via focusPath)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    return focusPath === vePath();
  };

  const renderShadowMaybe = () =>
    <Show when={!props.suppressLocalShadow &&
      !(props.visualElement.flags & VisualElementFlags.Popup) &&
      !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
      !(props.visualElement.flags & VisualElementFlags.DockItem) &&
      (!(imageItem().flags & ImageFlags.HideBorder) || store.perVe.getMouseIsOver(vePath()) || isFocused())}>
      <div class={`absolute border border-transparent rounded-xs shadow-xl bg-white`}
        style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w - 2}px; height: ${quantizedBoundsPx().h - 2}px; z-index: 0;`} />
    </Show>;

  const renderFocusRingMaybe = () => {
    const ringBoundsPx = visualFrameBoundsPx();
    return <Show when={isFocused() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`${boundsStylePx(ringBoundsPx)} ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: 3;`} />
    </Show>;
  };

  const renderPopupBaseMaybe = (): JSX.Element => {
    const baseBoundsPx = visualFrameBoundsPx();
    return <Show when={props.visualElement.flags & VisualElementFlags.Popup}>
      <div class="absolute text-xl font-bold rounded-md p-8 blur-md pointer-events-none"
        style={`left: ${baseBoundsPx.x - 10}px; top: ${baseBoundsPx.y - 10}px; ` +
          `width: ${baseBoundsPx.w + 20}px; height: ${baseBoundsPx.h + 20}px; background-color: #303030d0; z-index: 0;`} />
      <div class="absolute border border-[#555] rounded-xs overflow-hidden pointer-events-none"
        style={`${boundsStylePx(baseBoundsPx)} z-index: 0;`}>
        <img class="max-w-none absolute pointer-events-none"
          style={thumbnailFitStyle()}
          src={thumbnailSrc()} />
      </div>
    </Show>;
  };

  const renderFrameMaybe = (): JSX.Element => {
    const frameBoundsPx = visualFrameBoundsPx();
    const frameInnerBoundsPx = { x: 0, y: 0, w: frameBoundsPx.w, h: frameBoundsPx.h };
    return <div class={`absolute overflow-hidden border pointer-events-none rounded-xs ${!props.suppressLocalShadow && store.perVe.getMouseIsOver(vePath()) ? 'shadow-md' : ''} ` +
        (imageItem().flags & ImageFlags.HideBorder ? 'border-transparent' : `border-[#555] `)}
        style={`${boundsStylePx(frameBoundsPx)} z-index: 1;`}>
        <Show when={boundsPx().w > MIN_IMAGE_WIDTH_PX}>
          <Show when={isDetailed()} fallback={notDetailedFallback()}>
            {imageItem().flags & ImageFlags.NoCrop ? renderNoCropImage() : renderCroppedImage()}
            {renderResolutionDebugMaybe()}
            <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || (isMainPoppedUp() && !(props.visualElement.flags & VisualElementFlags.Popup))}>
              <div class="absolute"
                style={`${boundsStylePx(frameInnerBoundsPx)} background-color: #dddddd88;`} />
            </Show>
            <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
              <div class="absolute"
                style={`${boundsStylePx(frameInnerBoundsPx)} ` +
                  `${highlightStyle(props.visualElement.flags)}`} />
            </Show>
            <Show when={store.perVe.getMovingItemIsOverAttach(vePath()) &&
              store.perVe.getMoveOverAttachmentIndex(vePath()) >= 0}>
              <div class="absolute bg-black"
                style={`left: ${attachInsertBarPx().x}px; top: ${attachInsertBarPx().y}px; width: ${attachInsertBarPx().w}px; height: ${attachInsertBarPx().h}px;`} />
            </Show>
            <Show when={store.perVe.getMouseIsOver(vePath()) && !store.anItemIsMoving.get() && (!isInComposite() || isInCompositeInDocumentPage())}>
              <div class="absolute"
                style={`${boundsStylePx(frameInnerBoundsPx)} background-color: #ffffff33;`} />
            </Show>
          </Show>
        </Show>
      </div>;
  };

  const notDetailedFallback = (): JSX.Element =>
    <img class="max-w-none absolute pointer-events-none"
      style={imageItem().flags & ImageFlags.NoCrop ? thumbnailFitStyle() : croppedPlaceholderStyle()}
      src={thumbnailSrc()} />;

  const titleClickHandler = (ev: MouseEvent) => {
    if (ev.button !== 0 || !canEdit() || isEditingTitle()) { return; }
    ImageFns.handleEditClick(props.visualElement, store, { x: ev.clientX, y: ev.clientY });
  };

  const titleKeyDownHandler = (ev: KeyboardEvent) => {
    if (ev.isComposing || ev.keyCode == 229) { return; }
    if (ev.key == "Enter" || ev.key == "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      commitActiveTextEdit(store, ev.key == "Escape", "image-title-exit-edit");
      return;
    }
    edit_keyDownHandler(store, props.visualElement, ev);
  };

  const renderTitleMaybe = (): JSX.Element => {
    const titleBoundsPx = visualFrameBoundsPx();
    return <Show when={(props.visualElement.flags & VisualElementFlags.Popup) && boundsPx().w > MIN_IMAGE_WIDTH_PX}>
      <div class="absolute flex items-center justify-center pointer-events-none"
        style={`left: ${titleBoundsPx.x}px; top: ${titleBoundsPx.y + titleBoundsPx.h - 50}px; width: ${titleBoundsPx.w}px; height: 50px; z-index: 4;`}>
        <div id={vePath() + ":title"}
          class={`rounded-sm px-2 py-1 text-center text-xl font-bold text-white ${imageItem().title.trim() || isEditingTitle() ? "bg-black/70" : ""} ${canEdit() ? "pointer-events-auto select-text cursor-text" : "pointer-events-none"}`}
          style="min-width: 1em; min-height: 1.5em; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; outline: none;"
          contentEditable={isEditingTitle()}
          spellcheck={isEditingTitle()}
          onmousedown={ev => {
            if (ev.button == 0 && canEdit()) { ev.stopPropagation(); }
          }}
          onClick={titleClickHandler}
          onKeyDown={titleKeyDownHandler}
          onKeyUp={ev => edit_keyUpHandler(store, ev)}
          onInput={ev => edit_inputListener(store, ev)}>
          {appendNewlineIfEmpty(imageItem().title)}
        </div>
      </div>
    </Show>;
  };

  const renderAttachmentsAndDetailMaybe = (): JSX.Element => {
    const detailBoundsPx = visualFrameBoundsPx();
    return <Show when={isDetailed() && boundsPx().w > MIN_IMAGE_WIDTH_PX}>
      <div class="absolute pointer-events-none"
        style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; z-index: 2;`}>
        <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachment =>
          <VisualElement_Desktop visualElement={attachment.get()} suppressLocalShadow={props.suppressLocalShadow} />
        }</For>
        <Show when={showMoveOutOfCompositeArea()}>
          <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} vePath={vePath()} />
        </Show>
        <div class="absolute" style={boundsStylePx(detailBoundsPx)}>
          <Show when={linkHasTriangle(props.visualElement.linkItemMaybe) &&
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
      </div>
    </Show>;
  };

  const tooSmallFallback = (): JSX.Element =>
    <div class={`absolute overflow-hidden border pointer-events-none rounded-xs ` +
      (imageItem().flags & ImageFlags.HideBorder ? "border-transparent" : "border-[#555] ")}
      style={`left: 0px; top: 0px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; z-index: 1;`} />;

  // Get parent page for popup positioning checks
  const getParentPage = () => {
    if (!(props.visualElement.flags & VisualElementFlags.Popup)) return null;
    if (!props.visualElement.parentPath) return null;
    const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath);
    const parentItem = itemState.get(parentVeid.itemId);
    if (!parentItem) return null;
    return asPageItem(parentItem);
  };

  const hasChildChanges = () => {
    if (!(props.visualElement.flags & VisualElementFlags.Popup)) return false;
    const parentPage = getParentPage();
    if (!parentPage) return false;
    if (parentPage.arrangeAlgorithm === "spatial-stretch") {
      return ImageFns.childPopupPositioningHasChanged(parentPage, imageItem());
    } else {
      return ImageFns.childCellPopupPositioningHasChanged(parentPage, imageItem());
    }
  };

  const hasStoredPosition = () => {
    if (!(props.visualElement.flags & VisualElementFlags.Popup)) return false;
    const parentPage = getParentPage();
    if (!parentPage) return false;
    if (parentPage.arrangeAlgorithm === "spatial-stretch") {
      return ImageFns.hasStoredPopupPositioning(imageItem());
    } else {
      return ImageFns.hasStoredCellPopupPositioning(imageItem());
    }
  };

  const popupActionLayout = () => {
    const actionAnchorBoundsPx = visualFrameBoundsPx();
    return calcPopupActionStripLayout<PopupImageActionKey>([
      ...(hasChildChanges() ? [{ key: "child", label: "pin here" } as const] : []),
      ...(hasStoredPosition() ? [{ key: "default", label: "use default" } as const] : []),
    ],
    boundsPx().x + actionAnchorBoundsPx.x + actionAnchorBoundsPx.w,
    boundsPx().y + actionAnchorBoundsPx.y + (props.visualElement.flags & VisualElementFlags.Fixed ? store.topToolbarHeightPx() : 0),
    {
      fontSizePx: 10,
      gapPx: 4,
      heightPx: 18,
      horizontalPaddingPx: 8,
      minActionWidthPx: 54,
      rightInsetPx: 8,
    });
  };

  const popupActionLayoutLocal = () => {
    const layout = popupActionLayout();
    return {
      ...layout,
      boundsPx: {
        x: layout.boundsPx.x - quantizedBoundsPx().x,
        y: layout.boundsPx.y - rootTopPx(),
        w: layout.boundsPx.w,
        h: layout.boundsPx.h,
      },
      actions: layout.actions.map((action) => ({
        ...action,
        boundsPx: {
          x: action.boundsPx.x - quantizedBoundsPx().x,
          y: action.boundsPx.y - rootTopPx(),
          w: action.boundsPx.w,
          h: action.boundsPx.h,
        },
      })),
    };
  };

  const renderPopupActionStripMaybe = () =>
    <PopupActionStrip
      background="rgba(255, 255, 255, 0.95)"
      borderColor="rgba(255, 255, 255, 0.78)"
      fixed={false}
      layout={popupActionLayoutLocal()}
      shadow="0 1px 2px rgba(0, 0, 0, 0.15)"
      textColor="rgba(51, 65, 85, 0.82)"
      zIndexStyle={"z-index: 5;"}
    />;


  // Placeholders are very low resolution, so are blurred to hide JPEG block artifacts. The blur is applied only
  // whilst the placeholder is shown: the same img element shows the image once it is loaded, at which point the
  // filter is removed. The placeholder is enlarged by the extent of the blur so its soft edges are clipped by the
  // (overflow hidden) frame.
  const croppedPlaceholderStyle = (): string => {
    const placeholderSizePx = imagePlaceholderSizePx(imageItem().thumbnail);
    if (placeholderSizePx == null) {
      return `left: 0px; top: 0px; ${thumbnailFitStyle()}`;
    }
    const blurPx = PLACEHOLDER_BLUR_SIGMA * imageWidthToRequestPx(false) / placeholderSizePx.w;
    const marginPx = Math.ceil(blurPx * 3);
    return `left: -${marginPx}px; top: -${marginPx}px; ` +
      `width: calc(100% + ${marginPx * 2}px); height: calc(100% + ${marginPx * 2}px); ` +
      `object-fit: cover; object-position: center center; filter: blur(${blurPx.toFixed(1)}px);`;
  };

  const renderCroppedImage = (): JSX.Element =>
    <img src={imgSrcSignal.get()}
      class="max-w-none absolute pointer-events-none"
      style={isShowingThumbnail.get()
        ? croppedPlaceholderStyle()
        : `left: ${-(Math.round((imageWidthToRequestPx(false) - quantizedBoundsPx().w) / 2.0) + BORDER_WIDTH_PX)}px; ` +
          `top: ${-(Math.round((imageWidthToRequestPx(false) / imageAspect() - quantizedBoundsPx().h) / 2.0) + BORDER_WIDTH_PX)}px; `}
      width={isShowingThumbnail.get() ? undefined : imageWidthToRequestPx(false)}
      onLoad={IMAGE_RESOLUTION_DEBUG ? recordNaturalWidth : undefined} />;

  const renderNoCropImage = (): JSX.Element =>
    <img src={imgSrcSignal.get()}
      class="max-w-none absolute pointer-events-none"
      style={popupNoCropFrameFollowsImage() ? imageFitStyle("fill", true) : imageFitStyle("contain")}
      onLoad={IMAGE_RESOLUTION_DEBUG ? recordNaturalWidth : undefined} />;

  const renderResolutionDebugMaybe = (): JSX.Element => {
    if (!IMAGE_RESOLUTION_DEBUG) { return <></>; }
    // The width, in device pixels, that the whole image (not just the visible part of it, if cropped) is displayed at.
    const displayedWidthDevicePx = () => Math.round(
      (imageItem().flags & ImageFlags.NoCrop ? imageSizePx(false).w : imageWidthToRequestPx(false)) * store.devicePixelRatio.get());
    const ratio = () => loadedNaturalWidthPx.get() / Math.max(1, displayedWidthDevicePx());
    const kindLetter = () => shownImageKind.get() == "placeholder" ? "P" : shownImageKind.get() == "interim" ? "I" : "F";
    const color = () => ratio() >= 0.95 ? "#16a34a" : ratio() >= 0.5 ? "#d97706" : "#dc2626";
    return (
      <div class="absolute pointer-events-none whitespace-nowrap"
        style={`left: 2px; top: 2px; z-index: 3; padding: 0px 3px; border-radius: 2px; ` +
          `font: 10px/14px ui-monospace, monospace; color: #ffffff; background-color: ${color()};`}>
        <div>{`${kindLetter()} ${Math.round(ratio() * 100)}%`}</div>
        <div>{`${loadedNaturalWidthPx.get()}/${displayedWidthDevicePx()}`}</div>
      </div>
    );
  };

  return (
    <div class={positionClass()}
      style={`left: ${quantizedBoundsPx().x}px; top: ${rootTopPx()}px; width: ${quantizedBoundsPx().w}px; height: ${quantizedBoundsPx().h}px; ${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={boundsPx().w > MIN_IMAGE_WIDTH_PX} fallback={tooSmallFallback()}>
        {renderPopupBaseMaybe()}
        {renderShadowMaybe()}
        {renderFrameMaybe()}
        {renderAttachmentsAndDetailMaybe()}
        {renderFocusRingMaybe()}
        {renderTitleMaybe()}
        {renderPopupActionStripMaybe()}
      </Show>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(quantizedBoundsPx().w, quantizedBoundsPx().h)} />
      </Show>
    </div>
  );
}
