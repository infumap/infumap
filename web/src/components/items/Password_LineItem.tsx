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
import { PasswordFns, asPasswordItem } from "../../items/password-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn, shouldShowFocusRingForVisualElement } from "./helper";
import { LINE_HEIGHT_PX, PADDING_PROP, Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { SELECTED_DARK, SELECTED_LIGHT, FOCUS_RING_BOX_SHADOW } from "../../style";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { itemState } from "../../store/ItemState";


export const PasswordLineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const passwordItem = () => asPasswordItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(passwordItem());
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const iconScale = () => scale() * 0.92;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx?.w ?? 0;

  const isInCalendarPage = () => {
    if (props.visualElement.parentPath) {
      try {
        const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath);
        const parentItem = itemState.get(parentVeid.itemId);
        if (parentItem && isPage(parentItem)) {
          return asPageItem(parentItem).arrangeAlgorithm === ArrangeAlgorithm.Calendar;
        }
      } catch (e) {
        // If path parsing fails, continue to fallback
      }
    }
    return false;
  };

  const shouldShowIcon = () => PasswordFns.showsIcon(passwordItem()) && !isInCalendarPage();
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;
  const shouldShowLinkMarking = () => props.visualElement.linkItemMaybe != null &&
    (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
    showTriangleDetail();
  const shouldReserveLeadingBlock = () => shouldShowIcon() || shouldShowLinkMarking();
  const emoji = () => PasswordFns.emoji(passwordItem());
  const trailingControlsWidthPx = () => oneBlockWidthPx() * 1.9;

  const leftPx = () => shouldReserveLeadingBlock()
    ? boundsPx().x + oneBlockWidthPx()
    : boundsPx().x + oneBlockWidthPx() * PADDING_PROP;
  const widthPx = () => shouldReserveLeadingBlock()
    ? boundsPx().w - oneBlockWidthPx() - trailingControlsWidthPx()
    : boundsPx().w - oneBlockWidthPx() * PADDING_PROP - trailingControlsWidthPx();

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    navigator.clipboard.writeText(passwordItem().text);
  }
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
        <div class="absolute border border-slate-300 rounded-xs pointer-events-none"
          style={`left: ${highlightBoundsPx().x + 2}px; top: ${highlightBoundsPx().y + 2}px; ` +
            `width: ${highlightBoundsPx().w - 4}px; height: ${highlightBoundsPx().h - 4}px; ` +
            `z-index: ${Z_INDEX_LOCAL_OVERLAY}; ` +
            `background-color: #0044ff0a;`} />
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

  const renderIconMaybe = () =>
    <Show when={shouldShowIcon()}>
      <div class="absolute text-center"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y + Math.max(boundsPx().h * 0.02, 0.5)}px; ` +
          `width: ${oneBlockWidthPx() / iconScale()}px; height: ${boundsPx().h / iconScale()}px; ` +
          `transform: scale(${iconScale()}); transform-origin: top left;`}>
        <Show when={emoji()} fallback={<i class={`fas fa-eye-slash`} />}>
          <span class="inline-block leading-none"
            style={`font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; transform: translateY(1px);`}>
            {emoji()}
          </span>
        </Show>
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
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        store.overlay.setTextEditInfo(store.history, null, true);
        return;
    }
  }

  const renderText = () =>
    <div class="absolute overflow-hidden whitespace-nowrap"
      style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
        `width: ${widthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
        `transform: scale(${scale()}); transform-origin: top left;`}>
      <Switch>
        <Match when={store.overlay.textEditInfo() != null && store.overlay.textEditInfo()?.itemPath == vePath()}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class="text-slate-800"
            style={`margin-left: ${oneBlockWidthPx() * PADDING_PROP}px; outline: 0px solid transparent;`}
            contentEditable={canEdit() ? true : undefined}
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
              style={`margin-left: ${oneBlockWidthPx() * PADDING_PROP}px`}>••••••••••••</span>
          }>
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
              class="text-slate-800"
              style={`margin-left: ${oneBlockWidthPx() * PADDING_PROP}px`}>{passwordItem().text}<span></span></span>
          </Show>
        </Match>
      </Switch>
    </div>;

  const renderCopyIcon = () =>
    <div class="absolute text-center text-slate-600"
      style={`left: ${boundsPx().x + boundsPx().w - oneBlockWidthPx() * 1.05}px; top: ${boundsPx().y + boundsPx().h * PADDING_PROP}px; ` +
        `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h / smallScale()}px; ` +
        `transform: scale(${smallScale()}); transform-origin: top left;`}
      onmousedown={eatMouseEvent}
      onmouseup={eatMouseEvent}
      onclick={copyClickHandler}>
      <i class={`fas fa-copy cursor-pointer`} />
    </div>;

  const renderShowIcon = () =>
    <div class="absolute text-center text-slate-600"
      style={`left: ${boundsPx().x + boundsPx().w - oneBlockWidthPx() * 1.8}px; top: ${boundsPx().y + boundsPx().h * PADDING_PROP}px; ` +
        `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h / smallScale()}px; ` +
        `transform: scale(${smallScale()}); transform-origin: top left;`}
      onmousedown={eatMouseEvent}
      onmouseup={eatMouseEvent}
      onclick={VisibleClickHandler}>
      <i class={`fas ${isVisible() ? 'fa-eye-slash' : 'fa-eye'} cursor-pointer`} />
    </div>;

  const renderLinkMarkingMaybe = () =>
    <Show when={shouldShowLinkMarking()}>
      <div class="absolute text-center text-slate-600"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
          `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h / scale()}px; ` +
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
      <Show when={store.history.getFocusPathMaybe() === vePath() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
        <div class="absolute pointer-events-none"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
    </>
  );
}
