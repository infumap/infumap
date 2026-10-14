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
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { VisualElementProps } from "../VisualElement";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn, shouldShowFocusRingForVisualElement } from "./helper";
import { SELECTED_DARK, SELECTED_LIGHT, FIND_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { LINE_HEIGHT_PX, Z_INDEX_LOCAL_HIGHLIGHT, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { linkHasTriangle } from "../../layout/link-triangle";


const DIVIDER_COLOR = "#64748b";
const DIVIDER_LINE_WIDTH_PX = 1;
const DIVIDER_INSET_BL = 0.18;

/**
 * A divider separates rows, so is drawn as a horizontal rule across the row whatever its direction.
 */
export const Divider_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const oneBlockWidthPx = () => props.visualElement.blockSizePx?.w ?? 0;
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const showTriangleDetail = () => scale() > 0.5;
  const insetPx = () => Math.min(oneBlockWidthPx() * DIVIDER_INSET_BL, boundsPx().w / 4);

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
          style={`left: ${highlightBoundsPx().x + 2}px; top: ${highlightBoundsPx().y + 2}px; ` +
            `width: ${highlightBoundsPx().w - 4}px; height: ${highlightBoundsPx().h - 4}px; ` +
            `z-index: ${Z_INDEX_LOCAL_OVERLAY}; background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-xs"
            style={`left: ${lineHighlightBoundsPx()!.x + 2}px; top: ${lineHighlightBoundsPx()!.y + 2}px; ` +
              `width: ${lineHighlightBoundsPx()!.w - 4}px; height: ${lineHighlightBoundsPx()!.h - 4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
          style={`left: ${boundsPx().x + 1}px; top: ${boundsPx().y}px; width: ${boundsPx().w - 3}px; height: ${boundsPx().h}px; ` +
            `background-color: ${props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT};`} />
      </Match>
    </Switch>;

  const renderLinkMarkingMaybe = () =>
    <Show when={linkHasTriangle(props.visualElement.linkItemMaybe) && showTriangleDetail()}>
      <div class="absolute text-center text-slate-600"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
          `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
          `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>;

  return (
    <>
      {renderHighlightsMaybe()}
      <Show when={store.history.getFocusPathMaybe() === vePath() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
      <div class="absolute pointer-events-none"
        style={`left: ${boundsPx().x + insetPx()}px; top: ${boundsPx().y + boundsPx().h / 2 - DIVIDER_LINE_WIDTH_PX / 2}px; ` +
          `width: ${Math.max(0, boundsPx().w - 2 * insetPx())}px; height: ${DIVIDER_LINE_WIDTH_PX}px; background-color: ${DIVIDER_COLOR};`} />
      {renderLinkMarkingMaybe()}
    </>
  );
}
