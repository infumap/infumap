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

import { Component, For, Show, createMemo } from "solid-js";
import { Colors, linearGradient, FOCUS_RING_BOX_SHADOW, PAGE_TITLE_TEXT_SHADOW, opaquePageLightenAlpha } from "../../style";
import { rgbArrayToRgbaFunc, rgbHexToArray } from "../../util/color";
import { itemCanEdit, itemCanResize } from "../../items/base/capabilities-item";
import { VeFns, VisualElementFlags, isVeTranslucentPage } from "../../layout/visual-element";
import { Z_INDEX_LOCAL_SHADOW, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { VisualElement_Desktop } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { appendNewlineIfEmpty } from "../../util/string";
import { useStore } from "../../store/StoreProvider";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { PageVisualElementProps } from "./Page";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";
import { autoMovedIntoViewWarningStyle, createPageTitleEditHandlers, desktopStackRootStyle, pageIsFocusedOpenPopupSource, shouldShowFocusRingForVisualElement, highlightStyle } from "./helper";
import { linkHasTriangle } from "../../layout/link-triangle";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

const OPAQUE_TITLE_MAX_FONT_SIZE_PX = 12;
const OPAQUE_TITLE_PAD_X_FRAC = 0.08;
const OPAQUE_TITLE_MAX_HEIGHT_FRAC = 0.85;
const OPAQUE_TITLE_LINE_HEIGHT = 1.5;
// Fainter than the default, which is prominent against the strong page color.
const OPAQUE_RESIZE_TRIANGLE_COLOR = "rgba(255, 255, 255, 0.25)";
// The border is a darker shade of the page color, so the edge sits with the fill rather than outlining it.
const OPAQUE_BORDER_DARKEN_FACTOR = 0.7;

export const Page_Opaque: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  const pageFns = () => props.pageFns;
  const canEditPage = () => itemCanEdit(pageFns().pageItem());
  const canResizePage = () => itemCanResize(pageFns().pageItem()) && pageFns().hasResizeHitbox();
  const titleEditHandlers = createPageTitleEditHandlers(store, () => props.visualElement);

  const titlePadXPx = () => pageFns().boundsPx().w * OPAQUE_TITLE_PAD_X_FRAC;
  const titleFontSizePx = createMemo((): number => pageFns().calcPaddedTitleInBoxFontSizePx(
    OPAQUE_TITLE_MAX_FONT_SIZE_PX, titlePadXPx(), pageFns().boundsPx().h * OPAQUE_TITLE_MAX_HEIGHT_FRAC, OPAQUE_TITLE_LINE_HEIGHT));

  const renderBoxTitle = () =>
    <div id={VeFns.veToPath(props.visualElement) + ":title"}
      class={`absolute flex font-bold text-white ${titleEditHandlers.isEditingTitle() ? "pointer-events-auto select-text cursor-text" : ""}`}
      style={`left: 0px; ` +
        `top: 0px; ` +
        `width: ${pageFns().boundsPx().w}px; ` +
        `height: ${pageFns().boundsPx().h}px;` +
        `padding-left: ${titlePadXPx()}px; padding-right: ${titlePadXPx()}px; ` +
        `font-size: ${titleFontSizePx()}px; ` +
        `line-height: ${OPAQUE_TITLE_LINE_HEIGHT}; ` +
        `text-shadow: ${PAGE_TITLE_TEXT_SHADOW}; ` +
        `justify-content: center; align-items: center; text-align: center;` +
        `z-index: ${titleEditHandlers.isEditingTitle() ? Z_INDEX_LOCAL_HIGHLIGHT : 1};` +
        `outline: 0px solid transparent;`}
      contentEditable={canEditPage() && titleEditHandlers.isEditingTitle()}
      spellcheck={canEditPage() && titleEditHandlers.isEditingTitle()}
      onKeyDown={titleEditHandlers.titleKeyDownHandler}
      onKeyUp={titleEditHandlers.titleKeyUpHandler}
      onInput={titleEditHandlers.titleInputListener}>
      {appendNewlineIfEmpty(pageFns().pageItem().title)}
    </div>;

  const renderHoverOverMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(pageFns().vePath()) && !store.anItemIsMoving.get()}>
      <>
        <Show when={!pageFns().isInComposite() && pageFns().clickBoundsPx() != null}>
          <div class={`absolute rounded-xs pointer-events-none`}
            style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
              `background-color: #ffffff33;`} />
        </Show>
        <Show when={pageFns().hasPopupClickBoundsPx()}>
          <div class={`absolute rounded-xs pointer-events-none`}
            style={`left: ${pageFns().popupClickBoundsPx()!.x}px; top: ${pageFns().popupClickBoundsPx()!.y}px; width: ${pageFns().popupClickBoundsPx()!.w}px; height: ${pageFns().popupClickBoundsPx()!.h}px; ` +
              `background-color: ${pageFns().isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
        </Show>
      </>
    </Show>;

  const renderMovingOverMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(pageFns().vePath()) && pageFns().clickBoundsPx() != null}>
      <div class={'absolute rounded-xs pointer-events-none'}
        style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
          'background-color: #ffffff33;'} />
    </Show>;

  const renderMovingOverAttachMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttach(pageFns().vePath()) &&
      store.perVe.getMoveOverAttachmentIndex(pageFns().vePath()) >= 0}>
      <div class={'absolute bg-black pointer-events-none'}
        style={`left: ${pageFns().attachInsertBarPx().x}px; top: ${pageFns().attachInsertBarPx().y}px; ` +
          `width: ${pageFns().attachInsertBarPx().w}px; height: ${pageFns().attachInsertBarPx().h}px;`} />
    </Show>;

  const renderMovingOverAttachCompositeMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttachComposite(pageFns().vePath())}>
      <div class={`absolute border border-black pointer-events-none`}
        style={`left: ${pageFns().attachCompositeBoundsPx().x}px; top: ${pageFns().attachCompositeBoundsPx().y}px; width: ${pageFns().attachCompositeBoundsPx().w}px; height: ${pageFns().attachCompositeBoundsPx().h}px;`} />
    </Show>;

  const renderPopupSelectedOverlayMaybe = () =>
    <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || pageFns().isPoppedUp()}>
      <div class='absolute pointer-events-none'
        style={`left: ${pageFns().innerBoundsPx().x}px; top: ${pageFns().innerBoundsPx().y}px; width: ${pageFns().innerBoundsPx().w}px; height: ${pageFns().innerBoundsPx().h}px; ` +
          'background-color: #dddddd88;'} />
    </Show>;

  const renderIsLinkMaybe = () =>
    <Show when={linkHasTriangle(props.visualElement.linkItemMaybe) && pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const vePath = () => VeFns.veToPath(props.visualElement);

  // Check if this page is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() ||
      pageIsFocusedOpenPopupSource(store, () => props.visualElement) ||
      (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  // Check if this opaque page is inside a translucent page (child of translucent)
  const isInsideTranslucentPage = () => {
    const parentPath = props.visualElement.parentPath;
    if (!parentPath) return false;
    const parentVes = VesCache.render.getNode(parentPath);
    if (!parentVes) return false;
    return isVeTranslucentPage(parentVes.get());
  };

  const renderShadowMaybe = () =>
    <Show when={!props.suppressLocalShadow &&
      !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-xs overflow-hidden shadow-xl`}
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `z-index: ${Z_INDEX_LOCAL_SHADOW};`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && !pageFns().isInComposite() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const renderHighlightMaybe = () =>
    <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `${highlightStyle(props.visualElement.flags)}` +
          `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
    </Show>;

  const lightenAlpha = () => {
    const sizeBased = opaquePageLightenAlpha(Math.sqrt(pageFns().boundsPx().w * pageFns().boundsPx().h));
    return isInsideTranslucentPage() ? Math.max(0.33, sizeBased) : sizeBased;
  };

  const borderColor = () =>
    rgbArrayToRgbaFunc(rgbHexToArray(Colors[pageFns().pageItem().backgroundColorIndex]).map(c => Math.round(c * OPAQUE_BORDER_DARKEN_FACTOR)));

  return (
    <div class="absolute"
      style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ${desktopStackRootStyle(props.visualElement)}`}>
      {renderShadowMaybe()}
      <div class={`absolute border rounded-xs ${props.suppressLocalShadow ? "" : "hover:shadow-md"}`}
        style={`left: 0px; ` +
          `top: 0px; ` +
          `width: ${pageFns().boundsPx().w}px; ` +
          `height: ${pageFns().boundsPx().h}px; ` +
          `border-color: ${borderColor()}; ` +
          `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, lightenAlpha())}; ` +
          `z-index: 1;`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderBoxTitle()}
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderMovingOverAttachCompositeMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} suppressLocalShadow={props.suppressLocalShadow} />
          }</For>
          <Show when={pageFns().showMoveOutOfCompositeArea()}>
            <CompositeMoveOutHandle boundsPx={pageFns().moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(pageFns().vePath())} vePath={pageFns().vePath()} />
          </Show>
          {renderIsLinkMaybe()}
          <Show when={pageFns().showTriangleDetail() && canResizePage()}>
            <InfuResizeTriangle color={OPAQUE_RESIZE_TRIANGLE_COLOR} />
          </Show>
        </Show>
      </div>
      {renderHighlightMaybe()}
      {renderFocusRingMaybe()}
      <Show when={store.perVe.getAutoMovedIntoView(pageFns().vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(pageFns().boundsPx().w, pageFns().boundsPx().h)} />
      </Show>
    </div>
  );
}
