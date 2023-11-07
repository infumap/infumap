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
import { asRatingItem } from "../../items/rating-item";
import { FONT_SIZE_PX, LINE_HEIGHT_PX } from "../../constants";
import { VisualElementProps } from "../VisualElement";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/item";


export const Rating_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const ratingItem = () => asRatingItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const naturalHeightPx = () => LINE_HEIGHT_PX;
  const naturalWidthPx = () => LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const starSizeProp = () => ratingItem().rating / 5 * 1.2;

  // TODO (LOW): perhaps different rendering for non-detailed element, or no rendering at all.
  return (
    <div class={`absolute`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <div class={`fas fa-star text-gray-400 absolute`}
           style={`font-size: ${FONT_SIZE_PX * 1.2 * scale()}px; line-height: ${boundsPx().h}px; ` +
                  `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                  `text-align: center; vertical-align: bottom;`} />
      <div class={`fas fa-star text-yellow-400 absolute`}
           style={`font-size: ${FONT_SIZE_PX * starSizeProp() * scale()}px; line-height: ${boundsPx().h}px; ` +
                  `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                  `text-align: center; vertical-align: bottom;`} />
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.flags & VisualElementFlags.Detailed  && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM))}>
        <div style={`position: absolute; left: -4px; top: -4px; width: 8px; height: 8px; background-color: #800;`} />
      </Show>
    </div>
  );
}


export const Rating_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const ratingItem = () => asRatingItem(props.visualElement.displayItem);
  const starSizeProp = () => ratingItem().rating / 5 * 1.2;
  const oneBlockWidthPx = () => props.visualElement.oneBlockWidthPx!;
  const boundsPx = () => {
    let result = props.visualElement.boundsPx;
    result.w = oneBlockWidthPx();
    return result;
  }
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={!props.visualElement.mouseIsOverOpenPopup.get() && props.visualElement.mouseIsOver.get()}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${boundsPx().x+2}px; top: ${boundsPx().y+2}px; width: ${boundsPx().w-4}px; height: ${boundsPx().h-4}px;`} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

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
    </>
  );
}
