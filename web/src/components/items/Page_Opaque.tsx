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
import { FEATURE_COLOR_DARK, linearGradient } from "../../style";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { Z_INDEX_SHADOW, Z_INDEX_HIGHLIGHT } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { VisualElement_Desktop } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { appendNewlineIfEmpty } from "../../util/string";
import { useStore } from "../../store/StoreProvider";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { PageVisualElementProps } from "./Page";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Page_Opaque: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const store = useStore();

  const pageFns = () => props.pageFns;

  const opaqueTitleInBoxScale = createMemo((): number => pageFns().calcTitleInBoxScale("xs"));

  const renderBoxTitle = () =>
    <div id={VeFns.veToPath(props.visualElement) + ":title"}
      class={`flex font-bold text-white`}
      style={`left: ${pageFns().boundsPx().x}px; ` +
        `top: ${pageFns().boundsPx().y}px; ` +
        `width: ${pageFns().boundsPx().w}px; ` +
        `height: ${pageFns().boundsPx().h}px;` +
        `font-size: ${12 * opaqueTitleInBoxScale()}px; ` +
        `justify-content: center; align-items: center; text-align: center;` +
        `outline: 0px solid transparent;`}
      contentEditable={store.overlay.textEditInfo() != null}
      spellcheck={store.overlay.textEditInfo() != null}>
      {appendNewlineIfEmpty(pageFns().pageItem().title)}
    </div>;

  const renderHoverOverMaybe = () =>
    <Show when={store.perVe.getMouseIsOver(pageFns().vePath()) && !store.anItemIsMoving.get()}>
      <>
        <Show when={!pageFns().isInComposite()}>
          <div class={`absolute rounded-xs`}
            style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
              `background-color: #ffffff33;`} />
        </Show>
        <Show when={pageFns().hasPopupClickBoundsPx()}>
          <div class={`absolute rounded-xs`}
            style={`left: ${pageFns().popupClickBoundsPx()!.x}px; top: ${pageFns().popupClickBoundsPx()!.y}px; width: ${pageFns().popupClickBoundsPx()!.w}px; height: ${pageFns().popupClickBoundsPx()!.h}px; ` +
              `background-color: ${pageFns().isInComposite() ? '#ffffff33' : '#ffffff55'};`} />
        </Show>
      </>
    </Show>;

  const renderMovingOverMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOver(pageFns().vePath())}>
      <div class={'absolute rounded-xs'}
        style={`left: ${pageFns().clickBoundsPx()!.x}px; top: ${pageFns().clickBoundsPx()!.y}px; width: ${pageFns().clickBoundsPx()!.w}px; height: ${pageFns().clickBoundsPx()!.h}px; ` +
          'background-color: #ffffff33;'} />
    </Show>;

  const renderMovingOverAttachMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttach(pageFns().vePath())}>
      <div class={'absolute rounded-xs'}
        style={`left: ${pageFns().attachBoundsPx().x}px; top: ${pageFns().attachBoundsPx().y}px; width: ${pageFns().attachBoundsPx().w}px; height: ${pageFns().attachBoundsPx().h}px; ` +
          'background-color: #ff0000;'} />
    </Show>;

  const renderMovingOverAttachCompositeMaybe = () =>
    <Show when={store.perVe.getMovingItemIsOverAttachComposite(pageFns().vePath())}>
      <div class={`absolute rounded-xs`}
        style={`left: ${pageFns().attachCompositeBoundsPx().x}px; top: ${pageFns().attachCompositeBoundsPx().y}px; width: ${pageFns().attachCompositeBoundsPx().w}px; height: ${pageFns().attachCompositeBoundsPx().h}px; ` +
          `background-color: ${FEATURE_COLOR_DARK};`} />
    </Show>;

  const renderPopupSelectedOverlayMaybe = () =>
    <Show when={(props.visualElement.flags & VisualElementFlags.Selected) || pageFns().isPoppedUp()}>
      <div class='absolute'
        style={`left: ${pageFns().innerBoundsPx().x}px; top: ${pageFns().innerBoundsPx().y}px; width: ${pageFns().innerBoundsPx().w}px; height: ${pageFns().innerBoundsPx().h}px; ` +
          'background-color: #dddddd88;'} />
    </Show>;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && pageFns().showTriangleDetail()}>
      <InfuLinkTriangle />
    </Show>;

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-xs shadow-xl overflow-hidden`}
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderHighlightMaybe = () =>
    <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: ${pageFns().boundsPx().x}px; top: ${pageFns().boundsPx().y}px; ` +
          `width: ${pageFns().boundsPx().w}px; height: ${pageFns().boundsPx().h}px; ` +
          `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
          `z-index: ${Z_INDEX_HIGHLIGHT};`} />
    </Show>;

  return (
    <>
      {renderShadowMaybe()}
      {renderHighlightMaybe()}
      <div class={`absolute border border-[#555] rounded-xs hover:shadow-md`}
        style={`left: ${pageFns().boundsPx().x}px; ` +
          `top: ${pageFns().boundsPx().y}px; ` +
          `width: ${pageFns().boundsPx().w}px; ` +
          `height: ${pageFns().boundsPx().h}px; ` +
          `background-image: ${linearGradient(pageFns().pageItem().backgroundColorIndex, 0.0)}; ` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderBoxTitle()}
          {renderHoverOverMaybe()}
          {renderMovingOverMaybe()}
          {renderMovingOverAttachMaybe()}
          {renderMovingOverAttachCompositeMaybe()}
          {renderPopupSelectedOverlayMaybe()}
          <For each={VesCache.getAttachmentsVes(VeFns.veToPath(props.visualElement))()}>{attachmentVe =>
            <VisualElement_Desktop visualElement={attachmentVe.get()} />
          }</For>
          <Show when={pageFns().showMoveOutOfCompositeArea()}>
            <div class={`absolute rounded-xs`}
              style={`left: ${pageFns().moveOutOfCompositeBox().x}px; top: ${pageFns().moveOutOfCompositeBox().y}px; width: ${pageFns().moveOutOfCompositeBox().w}px; height: ${pageFns().moveOutOfCompositeBox().h}px; ` +
                `background-color: ${FEATURE_COLOR_DARK};`} />
          </Show>
          {renderIsLinkMaybe()}
          <Show when={pageFns().showTriangleDetail()}>
            <InfuResizeTriangle />
          </Show>
        </Show>
      </div>
    </>
  );
}
