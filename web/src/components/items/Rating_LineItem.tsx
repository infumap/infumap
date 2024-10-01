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

import { Component, Match, Show, Switch } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VisualElementProps } from "../VisualElement";
import { asRatingItem } from "../../items/rating-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createLineHighlightBoundsPxFn } from "./helper";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, Z_INDEX_ITEMS_OVERLAY } from "../../constants";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";


export const Rating_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const ratingItem = () => asRatingItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const starSizeProp = () => ratingItem().rating / 5 * 1.2;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const boundsPx = () => {
    let result = props.visualElement.boundsPx;
    result.w = oneBlockWidthPx();
    return result;
  }
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm pointer-events-none"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; ` +
                    `width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px; ` +
                    `z-index: ${Z_INDEX_ITEMS_OVERLAY}; ` +
                    `background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; ` +
                      `width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-3}px; height: ${boundsPx().h}px; ` +
                    `background-color: ${props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT};`} />
      </Match>
    </Switch>;

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
      <div class={`absolute`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <div class={`fas fa-star text-gray-400 absolute`}
             style={`font-size: ${FONT_SIZE_PX * 1.2 * scale()}px; line-height: ${boundsPx().h}px; `+
                    `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                    `text-align: center; vertical-align: bottom;`} />
        <div class={`fas fa-star text-yellow-400 absolute`}
             style={`font-size: ${FONT_SIZE_PX * starSizeProp() * scale()}px; line-height: ${boundsPx().h}px; ` +
                    `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                    `text-align: center; vertical-align: bottom;`} />
      </div>
      {renderLinkMarkingMaybe()}
    </>
  );
}
