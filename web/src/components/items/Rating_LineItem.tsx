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
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn, lineItemTextClippedWidthCssPx } from "./helper";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, Z_INDEX_LOCAL_HIGHLIGHT, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { linkHasTriangle } from "../../layout/link-triangle";
import { SELECTED_DARK, SELECTED_LIGHT, FIND_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";


const MAX_RATING = 5;

export const Rating_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const ratingItem = () => asRatingItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const starSizeProp = () => ratingItem().rating / MAX_RATING * 1.2;
  const ratingType = () => ratingItem().ratingType;
  const clampedRating = () => Math.max(0, Math.min(MAX_RATING, Math.round(ratingItem().rating)));
  const oneBlockWidthPx = () => props.visualElement.blockSizePx?.w ?? 0;
  const boundsPx = () => props.visualElement.boundsPx;
  const glyphBoundsPx = () => ({
    ...props.visualElement.boundsPx,
    w: oneBlockWidthPx(),
  });
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;
  const valueWidthPx = () => Math.max(0, boundsPx().w - oneBlockWidthPx());

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute pointer-events-none"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: ${FIND_HIGHLIGHT_COLOR}; ` +
                    `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
      </Match>
      <Match when={store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; ` +
                    `width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px; ` +
                    `z-index: ${Z_INDEX_LOCAL_OVERLAY}; ` +
                    `background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-xs"
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

  const renderGlyph = () =>
    <div class={`absolute`}
         style={`left: ${glyphBoundsPx().x}px; top: ${glyphBoundsPx().y}px; width: ${glyphBoundsPx().w}px; height: ${glyphBoundsPx().h}px;`}>
      <Show when={ratingType() == "Star"}>
        <div class={`fas fa-star text-gray-400 absolute`}
             style={`font-size: ${FONT_SIZE_PX * 1.2 * scale()}px; line-height: ${glyphBoundsPx().h}px; `+
                    `width: ${glyphBoundsPx().w-2}px; height: ${glyphBoundsPx().h-2}px; ` +
                    `text-align: center; vertical-align: bottom;`} />
        <div class={`fas fa-star text-yellow-400 absolute`}
             style={`font-size: ${FONT_SIZE_PX * starSizeProp() * scale()}px; line-height: ${glyphBoundsPx().h}px; ` +
                    `width: ${glyphBoundsPx().w-2}px; height: ${glyphBoundsPx().h-2}px; ` +
                    `text-align: center; vertical-align: bottom;`} />
      </Show>

      <Show when={ratingType() == "Number"}>
        <div class="absolute rounded-full bg-slate-300 text-center text-gray-800"
             style={`left: ${(glyphBoundsPx().w - (Math.min(glyphBoundsPx().w, glyphBoundsPx().h) - 2)) / 2}px; ` +
                    `top: ${(glyphBoundsPx().h - (Math.min(glyphBoundsPx().w, glyphBoundsPx().h) - 2)) / 2}px; ` +
                    `width: ${Math.min(glyphBoundsPx().w, glyphBoundsPx().h) - 2}px; ` +
                    `height: ${Math.min(glyphBoundsPx().w, glyphBoundsPx().h) - 2}px; ` +
                    `font-size: ${FONT_SIZE_PX * 1.0 * scale()}px; ` +
                    `line-height: ${Math.min(glyphBoundsPx().w, glyphBoundsPx().h) - 2}px;`}>
          {ratingItem().rating}
        </div>
      </Show>

      <Show when={ratingType() == "HorizontalBar"}>
        <div class="absolute bg-slate-300"
             style={`left: ${3*scale()}px; right: ${3*scale()}px; top: ${glyphBoundsPx().h/2 - 6*scale()}px; height: ${12*scale()}px;`} />
        <div class="absolute bg-blue-700"
             style={`left: ${3*scale()}px; top: ${glyphBoundsPx().h/2 - 6*scale()}px; height: ${12*scale()}px; width: ${Math.max(0, Math.min(1, ratingItem().rating/MAX_RATING)) * (glyphBoundsPx().w-6*scale())}px;`} />
      </Show>

      <Show when={ratingType() == "VerticalBar"}>
        <div class="absolute bg-slate-300"
             style={`top: ${2*scale()}px; bottom: ${2*scale()}px; left: ${glyphBoundsPx().w/2 - 6*scale()}px; width: ${12*scale()}px;`} />
        <div class="absolute bg-blue-700"
             style={`left: ${glyphBoundsPx().w/2 - 6*scale()}px; bottom: ${2*scale()}px; width: ${12*scale()}px; height: ${Math.max(0, Math.min(1, ratingItem().rating/MAX_RATING)) * (glyphBoundsPx().h-4*scale())}px;`} />
      </Show>
    </div>;

  // The value is repeated in the title column, in a form that can be read and compared at a glance down a list.
  const renderValueMaybe = () =>
    <Show when={valueWidthPx() > 0}>
      <div class="absolute overflow-hidden whitespace-nowrap pointer-events-none"
           style={`left: ${boundsPx().x + oneBlockWidthPx()}px; top: ${boundsPx().y}px; ` +
                  `width: ${lineItemTextClippedWidthCssPx(props.visualElement, valueWidthPx(), scale())}px; height: ${boundsPx().h / scale()}px; ` +
                  `line-height: ${LINE_HEIGHT_PX}px; ` +
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <span class="text-slate-600">{clampedRating()} / {MAX_RATING}</span>
      </div>
    </Show>;

  const renderLinkMarkingMaybe = () =>
    <Show when={linkHasTriangle(props.visualElement.linkItemMaybe) && showTriangleDetail()}>
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
      <Show when={store.history.getFocusPathMaybe() === vePath()}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
      {renderGlyph()}
      {renderValueMaybe()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
