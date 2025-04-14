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
import { ATTACH_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, Z_INDEX_SHADOW } from "../../constants";
import { BoundingBox } from "../../util/geometry";
import { asCompositeItem } from "../../items/composite-item";
import { CompositeFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { useStore } from "../../store/StoreProvider";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };

  const showTriangleDetail = () => { return boundsPx().w / LINE_HEIGHT_PX > (0.5 * asCompositeItem(props.visualElement.displayItem).spatialWidthGr / GRID_SIZE); }

  const showBorder = () => !(asCompositeItem(props.visualElement.displayItem).flags & CompositeFlags.HideBorder);

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) && showBorder()}>
      <div class={`absolute border border-transparent rounded-sm shadow-lg overflow-hidden`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
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
      <div class={`absolute border ` +
                  `${showBorder() ? "border-slate-700" : "border-transparent"} ` +
                  `rounded-sm ` +
                  `bg-white`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)} ` +
                  `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? "background-color: #eee;" : ""}` +
                  `outline: 0px solid transparent; ` +
                  `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}
          contentEditable={store.overlay.textEditInfo() != null}
          onKeyUp={keyUpHandler}
          onKeyDown={keyDownHandler}
          onInput={inputListener}>
        <For each={props.visualElement.childrenVes}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
        <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
          <div class={`absolute rounded-sm`}
               style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                      `background-color: #ff0000;`} />
        </Show>
        <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
                    !(props.visualElement.flags & VisualElementFlags.Popup) &&
                    showTriangleDetail()}>
          <InfuLinkTriangle />
        </Show>
      </div>
      <Show when={showTriangleDetail()}>
        <div class={`absolute border border-transparent pointer-events-none`}
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
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
