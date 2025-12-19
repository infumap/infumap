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
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { useStore } from "../../store/StoreProvider";
import { asFlipCardItem } from "../../items/flipcard-item";
import { linearGradient, stripedGradient } from "../../style";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { GRID_SIZE, LINE_HEIGHT_PX, Z_INDEX_MOVING, Z_INDEX_SHADOW } from "../../constants";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";


export const FlipCard_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  
  const flipCardItem = () => asFlipCardItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const blockWidthPx = () => boundsPx().w / (flipCardItem().spatialWidthGr / GRID_SIZE);
  const viewportBoundsPx = () => props.visualElement.viewportBoundsPx!;
  const vePath= () => VeFns.veToPath(props.visualElement);

  const titleScale = () => (boundsPx().h - viewportBoundsPx().h) / LINE_HEIGHT_PX;

  const renderIsLinkMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null &&
                !((props.visualElement.flags & VisualElementFlags.Popup) && (props.visualElement.actualLinkItemMaybe == null))
    }>
      <InfuLinkTriangle />
    </Show>;

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`absolute border border-transparent rounded-xs shadow-xl overflow-hidden`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderHeader = () =>
    <div class={`absolute`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h - viewportBoundsPx().h}px;`}>
      <div id={VeFns.veToPath(props.visualElement) + ":title"}
          class="absolute font-bold"
          style={`left: 0px; top: 0px; width: ${boundsPx().w / titleScale()}px; height: ${(boundsPx().h - viewportBoundsPx().h) / titleScale()}px; ` +
                 `line-height: ${LINE_HEIGHT_PX}px; transform: scale(${titleScale()}); transform-origin: top left; ` +
                 `overflow-wrap: break-word;` +
                 `background-image: ${store.perItem.getFlipCardVisibleSide(VeFns.veidFromVe(props.visualElement)) == 0 ? linearGradient(flipCardItem().backgroundColorIndex, 0.636) : stripedGradient(flipCardItem().backgroundColorIndex, 0.636)}; ` +
                 `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}` +
                 `outline: 0px solid transparent;`}
          spellcheck={store.overlay.textEditInfo() != null}
          contentEditable={store.overlay.textEditInfo() != null}>
        <div class="flex flex-row flex-nowrap">
          <div style="flex-grow: 1"></div>
          <div style="flex-grow: 0; margin-right: 6px;"><i class={`fa fa-${store.perVe.getFlipCardIsEditing(vePath()) ? 'minus' : 'pen'}`} /></div>
          <div style={`flex-grow: 0; margin-right: 3px;`}><i class="fa fa-retweet" /></div>
        </div>
      </div>
      {renderIsLinkMaybe()}
    </div>;

  const renderPage = () =>
    <div 
        class={`absolute border border-[#999] rounded-xs hover:shadow-md`}
        style={`left: ${viewportBoundsPx().x}px; ` +
               `top: ${viewportBoundsPx().y}px; ` +
               `width: ${viewportBoundsPx().w}px; ` +
               `height: ${viewportBoundsPx().h}px; ` +
               `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <div class="absolute"
           style={`left: ${0}px; top: ${0}px; ` +
                  `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
        <For each={props.visualElement.childrenVes}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
        <InfuResizeTriangle />
      </div>
      <Show when={store.perVe.getMouseIsOver(vePath()) && !store.perVe.getFlipCardIsEditing(vePath())}>
          <div class="absolute"
               style={`left: ${0}px; top: ${0}px; ` +
                      `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px; ` +
                      'background-color: #44444411;' +
                      `z-index: ${Z_INDEX_MOVING};`}>
          </div>
        </Show>
    </div>;

  return (
    <>
      {renderShadowMaybe()}
      {renderPage()}
      {renderHeader()}
    </>
  );
}
