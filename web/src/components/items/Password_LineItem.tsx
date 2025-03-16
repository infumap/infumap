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
import { asPasswordItem } from "../../items/password-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_ITEMS_OVERLAY } from "../../constants";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";


export const PasswordLineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - 1.9 * oneBlockWidthPx()
    : boundsPx().w - 2.9 * oneBlockWidthPx();

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const isVisible = () => store.currentVisiblePassword.get() == passwordItem().id;
  const VisibleClickHandler = () => {
    if (!isVisible()) {
      store.currentVisiblePassword.set(passwordItem().id);
    } else {
      store.currentVisiblePassword.set(null);
    }
  }

  const renderHighlightsMaybe = () =>
    <Switch>
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

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-eye-slash`} />
      </div>
    </Show>;

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
        <Match when={store.overlay.textEditInfo() != null && store.overlay.textEditInfo()?.itemPath == vePath()}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
                class="text-slate-800"
                style={`margin-left: ${oneBlockWidthPx()*PADDING_PROP}px; outline: 0px solid transparent;`}
                contentEditable={true}
                spellcheck={false}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {passwordItem().text}<span></span>
          </span>
        </Match>
        <Match when={!store.overlay.textEditInfo() || store.overlay.textEditInfo()?.itemPath != vePath()}>
          <Show when={isVisible()} fallback={
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
                  class="text-slate-800"
                  style={`margin-left: ${oneBlockWidthPx()*PADDING_PROP}px`}>••••••••••••</span>
          }>
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
                  class="text-slate-800"
                  style={`margin-left: ${oneBlockWidthPx()*PADDING_PROP}px`}>{passwordItem().text}<span></span></span>
          </Show>
        </Match>
      </Switch>
    </div>;

  const renderCopyIcon = () =>
    <div class="absolute text-center text-slate-600"
         style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*1.05}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                `transform: scale(${smallScale()}); transform-origin: top left;`}
         onmousedown={eatMouseEvent}
         onmouseup={eatMouseEvent}
         onclick={copyClickHandler}>
      <i class={`fas fa-copy cursor-pointer`} />
    </div>;

  const renderShowIcon = () =>
    <div class="absolute text-center text-slate-600"
         style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*1.8}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                `transform: scale(${smallScale()}); transform-origin: top left;`}
         onmousedown={eatMouseEvent}
         onmouseup={eatMouseEvent}
         onclick={VisibleClickHandler}>
      <i class={`fas ${isVisible() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
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
      {renderIconMaybe()}
      {renderText()}
      {renderCopyIcon()}
      {renderShowIcon()}
      {renderLinkMarkingMaybe()}
    </>
  );
}
