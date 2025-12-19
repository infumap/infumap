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
import { asExpressionItem, ExpressionFns } from "../../items/expression-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_ITEMS_OVERLAY, Z_INDEX_HIGHLIGHT } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { getTextStyleForNote } from "../../layout/text";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";


export const Expression_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x + oneBlockWidthPx() * PADDING_PROP
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - oneBlockWidthPx() * PADDING_PROP
    : boundsPx().w - oneBlockWidthPx();
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const infuTextStyle = () => getTextStyleForNote(expressionItem().flags);

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
  }

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
                    `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Match>
      <Match when={store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; ` +
                    `width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px; ` +
                    `z-index: ${Z_INDEX_ITEMS_OVERLAY}; ` +
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

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left; ` +
                  `background-color: #fff1e4; font-weight: bold; margin-top: ${-2}px;`}>
        ∑
      </div>
    </Show>;

  const renderText = () =>
    <>
      <div class={'absolute'}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  'background-color: #fff1e4;'} />
      <div class={`absolute overflow-hidden whitespace-nowrap ` +
                  ((store.overlay.textEditInfo() != null && store.overlay.textEditInfo()?.itemPath == vePath()) ? '' : `text-ellipsis `) +
                  `${infuTextStyle().alignClass} `}
          style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                 `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                 `transform: scale(${scale()}); transform-origin: top left; padding-right: 2px;`}>
        <Switch>
          <Match when={store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath()}>
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
                  class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
                  style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
              {ExpressionFns.expressionFormatMaybe(props.visualElement.evaluatedTitle != null
                ? props.visualElement.evaluatedTitle
                : expressionItem().title, expressionItem().format)}<span></span>
            </span>
          </Match>
          <Match when={store.overlay.textEditInfo() != null}>
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
                  class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
                  style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                         `outline: 0px solid transparent;`}
                  contentEditable={store.overlay.textEditInfo() != null ? true : undefined}
                  spellcheck={store.overlay.textEditInfo() != null}
                  onKeyDown={keyDownHandler}>
              {ExpressionFns.expressionFormatMaybe(expressionItem().title, expressionItem().format)}<span></span>
            </span>
          </Match>
        </Switch>
      </div>
    </>;

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
      {renderText()}
      {renderIconMaybe()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
