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
import { VisualElementProps, VisualElement_Desktop } from "../VisualElement";
import { GRID_SIZE, LINE_HEIGHT_PX, Z_INDEX_POPUP, Z_INDEX_SHADOW, Z_INDEX_HIGHLIGHT } from "../../constants";
import { BoundingBox } from "../../util/geometry";
import { asCompositeItem } from "../../items/composite-item";
import { CompositeFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { VesCache } from "../../layout/ves-cache";

import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { useStore } from "../../store/StoreProvider";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    }
  };

  const showTriangleDetail = () => { return boundsPx().w / LINE_HEIGHT_PX > (0.5 * asCompositeItem(props.visualElement.displayItem).spatialWidthGr / GRID_SIZE); }

  const showBorder = () => !(asCompositeItem(props.visualElement.displayItem).flags & CompositeFlags.HideBorder);

  const shadowClass = () => {
    if (isPopup()) {
      return `${positionClass()} border border-transparent rounded-xs overflow-hidden blur-md bg-slate-700 pointer-events-none`;
    }
    return `${positionClass()} border border-transparent rounded-xs shadow-xl overflow-hidden`;
  };

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) && showBorder()}>
      <div class={shadowClass()}
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `z-index: ${isPopup() ? Z_INDEX_POPUP : Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const keyUpHandler = (ev: KeyboardEvent) => {
    edit_keyUpHandler(store, ev);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    edit_keyDownHandler(store, props.visualElement, ev);
  }

  const inputListener = (ev: InputEvent) => {
    edit_inputListener(store, ev);
  }

  return (
    <>
      {renderShadowMaybe()}
      <div class={`${positionClass()} border ` +
        `${showBorder() ? "border-[#999]" : "border-transparent"} ` +
        `rounded-xs ` +
        `bg-white  hover:shadow-md`}
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)} ` +
          `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? "background-color: #eee;" : ""}` +
          `outline: 0px solid transparent; ` +
          `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
        contentEditable={store.overlay.textEditInfo() != null}
        onKeyUp={keyUpHandler}
        onKeyDown={keyDownHandler}
        onInput={inputListener}>
        <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
          <div class="absolute pointer-events-none rounded-xs"
            style={`left: 0px; top: 0px; ` +
              `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
              `z-index: ${Z_INDEX_HIGHLIGHT};`} />
        </Show>
        <For each={VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
          <div class={`absolute border border-black`}
            style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px;`} />
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
          !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
          showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
      </div>
      <Show when={showTriangleDetail()}>
        <div class={`${positionClass()} border border-transparent pointer-events-none`}
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)} ` +
            `outline: 0px solid transparent; ` +
            `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
          <div class="absolute"
            style={"width: 0px; height: 0px; bottom: 0px; right: 0px;" +
              `${VeFns.zIndexStyle(props.visualElement)}`}>
            <InfuResizeTriangle />
          </div>
        </div>
      </Show>
    </>
  );
};
