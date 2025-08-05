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
import { asFileItem } from "../../items/file-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_ITEMS_OVERLAY, Z_INDEX_HIGHLIGHT } from "../../constants";
import { cloneBoundingBox } from "../../util/geometry";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { ClickState } from "../../input/state";
import { appendNewlineIfEmpty } from "../../util/string";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";


export const FileLineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const fileItem = () => asFileItem(props.visualElement.displayItem);
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
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDown = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(true); }
    ev.preventDefault();
  };
  const aHrefClick = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUp = (ev: MouseEvent) => { ev.preventDefault(); };

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute pointer-events-none"
             style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                    `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: rgba(255, 255, 0, 0.4); ` +
                    `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Match>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm pointer-events-none"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; ` +
                    `width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px; ` +
                    `z-index: ${Z_INDEX_ITEMS_OVERLAY}; ` +
                    `background-color: #0044ff0a;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; ` +
                      `width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm pointer-events-none"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; ` +
                    `width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px; ` +
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

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-file`} />
    </div>;

  const inputListener = (_ev: InputEvent) => {
    // fullArrange is not required in the line item case, because the ve geometry does not change.
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
  }

  const renderText = () =>
    <div class="absolute overflow-hidden whitespace-nowrap"
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <Switch>
        <Match when={store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath()}>
          <a id={VeFns.veToPath(props.visualElement) + ":title"}
             href={""}
             class={`text-green-800`}
             style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`}
             onClick={aHrefClick}
             onMouseDown={aHrefMouseDown}
             onMouseUp={aHrefMouseUp}>
           {fileItem().title}
          </a>
        </Match>
        <Match when={store.overlay.textEditInfo() != null}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
                style={`outline: 0px solid transparent;`}
                contentEditable={store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {appendNewlineIfEmpty(fileItem().title)}<span></span>
          </span>
        </Match>
      </Switch>
    </div>;

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
      <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
        {renderIcon()}
      </Show>
      {renderText()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
