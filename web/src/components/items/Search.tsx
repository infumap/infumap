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

import { Component, Show } from "solid-js";
import { arrangeNow } from "../../layout/arrange";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { closestCaretPositionToClientPx, setCaretPosition } from "../../util/caret";
import { ItemType } from "../../items/base/item";


const EMPTY_SEARCH_EDIT_TEXT = "\u200B";


export const Search_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const isListPageMainRoot = () =>
    !!(props.visualElement.flags & VisualElementFlags.ListPageRoot) ||
    props.visualElement.linkItemMaybe?.id == LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  const searchItem = () => props.visualElement.displayItem;
  const queryText = () => store.perItem.getSearchQuery(searchItem().id);
  const isEditing = () => store.overlay.textEditInfo()?.itemPath == vePath();
  const editingDomId = () => vePath() + ":title";
  const editableQueryText = () => queryText() == "" ? EMPTY_SEARCH_EDIT_TEXT : queryText();

  const queryInputMouseDown = (ev: MouseEvent) => {
    if (isEditing()) {
      ev.stopPropagation();
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    store.overlay.setTextEditInfo(store.history, { itemPath: vePath(), itemType: ItemType.Search });
    const el = document.getElementById(editingDomId());
    const closestIdx = el instanceof HTMLElement
      ? closestCaretPositionToClientPx(el, { x: ev.clientX, y: ev.clientY })
      : queryText().length;
    arrangeNow(store, "search-enter-edit-mode");
    const freshEl = document.getElementById(editingDomId());
    if (freshEl instanceof HTMLElement) {
      freshEl.focus();
      setCaretPosition(freshEl, closestIdx);
    } else {
      console.warn("Could not enter search edit mode because the text element no longer exists", { itemPath: vePath() });
      store.overlay.setTextEditInfo(store.history, null);
    }
  };

  const inputListener = (_ev: InputEvent) => {
    // Commit happens through the shared text-edit exit path in mouse_down.ts.
    // Updating reactive state on every keystroke here causes the contentEditable
    // subtree to rerender while the browser is editing it.
  };

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
  };

  const renderSearchWorkspace = () => {
    const topInsetPx = 25;
    const sideInsetPx = 26;
    const controlsHeightPx = 50;
    const resultsTopGapPx = 25;
    const buttonWidthPx = 92;
    const controlsGapPx = 10;
    const controlsWidthPx = Math.min(
      760,
      Math.max(320, boundsPx().w - sideInsetPx * 2),
    );
    const inputWidthPx = Math.max(120, controlsWidthPx - buttonWidthPx - controlsGapPx);
    const lowerTopPx = topInsetPx + controlsHeightPx + resultsTopGapPx;
    return (
      <div class="absolute bg-white"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `${desktopStackRootStyle(props.visualElement)}`}>
        <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
          <div class="absolute pointer-events-none"
            style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
        </Show>
        <div class="absolute"
          style={`left: ${Math.max(0, Math.round((boundsPx().w - controlsWidthPx) / 2))}px; top: ${topInsetPx}px; width: ${controlsWidthPx}px;`}>
          <div class="flex items-center gap-[10px]">
            <div
              class="border border-[#999] rounded-xs bg-white overflow-hidden"
              style={`width: ${inputWidthPx}px; height: ${controlsHeightPx}px;`}
              onMouseDown={queryInputMouseDown}>
              <div class="flex items-center h-full overflow-hidden whitespace-nowrap px-2.5"
                style="font-size: 16px;">
                <Show when={isEditing()} fallback={
                  <span class={`outline-hidden ${queryText() == "" ? "text-slate-500" : "text-black"}`}>
                    {queryText() == "" ? "Search..." : queryText()}
                  </span>
                }>
                  <span id={editingDomId()}
                    class="outline-hidden text-black"
                    style="display: inline-block; min-width: 1px; white-space: nowrap; font-size: 16px;"
                    contentEditable={isEditing() ? true : undefined}
                    spellcheck={isEditing()}
                    onKeyDown={keyDownHandler}
                    onInput={inputListener}>
                    {editableQueryText()}<span></span>
                  </span>
                </Show>
              </div>
            </div>
            <button
              class="border border-[#999] rounded-xs bg-white text-black"
              style={`width: ${buttonWidthPx}px; height: ${controlsHeightPx}px;`}
              type="button"
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              }}
              >
              Search
            </button>
          </div>
        </div>
        <div class="absolute border-t border-slate-300"
          style={`left: 0px; top: ${lowerTopPx}px; width: ${boundsPx().w}px; height: ${Math.max(0, boundsPx().h - lowerTopPx)}px;`} />
        <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
          <div class="absolute pointer-events-none rounded-xs"
            style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
        </Show>
      </div>
    );
  };

  if (isListPageMainRoot()) {
    return renderSearchWorkspace();
  }

  return (
    <div class="absolute rounded-xs border border-slate-300 bg-white text-slate-500 overflow-hidden"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `pointer-events: none; ${desktopStackRootStyle(props.visualElement)}`}>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
      </Show>
      <div class="absolute flex items-center gap-2 px-3"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
        <i class="fa fa-search text-slate-400" />
        <span class="truncate italic">[search]</span>
      </div>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
