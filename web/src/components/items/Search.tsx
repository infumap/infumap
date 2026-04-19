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

import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { FIND_HIGHLIGHT_COLOR } from "../../style";
import { VisualElementProps } from "../VisualElement";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { closestCaretPositionToClientPx, setCaretPosition } from "../../util/caret";
import { ItemType } from "../../items/base/item";
import { server } from "../../server";
import { VisualElement_Desktop } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../../layout/load";
import { itemState } from "../../store/ItemState";
import { asContainerItem, isContainer } from "../../items/base/container-item";
import { asLinkItem, isLink, LinkFns } from "../../items/link-item";
import {
  SEARCH_WORKSPACE_BUTTON_WIDTH_PX,
  SEARCH_WORKSPACE_CONTROLS_GAP_PX,
  SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX,
  SEARCH_WORKSPACE_TOP_INSET_PX,
  calcSearchWorkspaceControlsWidthPx,
  calcSearchWorkspaceInputWidthPx,
  calcSearchWorkspaceResultsBoundsPx,
  calcSearchWorkspaceResultsTopPx,
} from "../../items/search-item";


const EMPTY_SEARCH_EDIT_TEXT = "\u200B";
const normalizeSearchText = (text: string): string =>
  text.replace(/\u200B/g, "").replace(/\n/g, "").trim();


export const Search_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const [pendingCaretIdx, setPendingCaretIdx] = createSignal<number | null>(null);
  const [forceNonEditing, setForceNonEditing] = createSignal(false);
  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const isListPageMainRoot = () =>
    !!(props.visualElement.flags & VisualElementFlags.ListPageRoot) ||
    props.visualElement.linkItemMaybe?.id == LIST_PAGE_MAIN_ITEM_LINK_ITEM;
  const searchItem = () => props.visualElement.displayItem;
  const queryText = () => store.perItem.getSearchQuery(searchItem().id);
  const isEditing = () => store.overlay.textEditInfo()?.itemPath == vePath() && !forceNonEditing();
  const editingDomId = () => vePath() + ":title";
  const editableQueryText = () => queryText() == "" ? EMPTY_SEARCH_EDIT_TEXT : queryText();
  const clearSelectedResultRow = () => store.perItem.setSearchSelectedResultIndex(searchItem().id, -1);
  const exitEditMode = (editingElMaybe?: HTMLElement | null) => {
    if (!isEditing()) {
      return;
    }

    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    setForceNonEditing(true);
    setPendingCaretIdx(null);
    store.overlay.autoFocusSearchInput.set(false);
    if (editingEl instanceof HTMLElement) {
      editingEl.contentEditable = "false";
    }
    blurEditingDomMaybe(editingEl instanceof HTMLElement ? editingEl : null);
    store.overlay.setTextEditInfo(store.history, null);
    arrangeNow(store, "search-exit-edit");
  };
  const readQueryTextFromDom = (elMaybe?: HTMLElement | null) => {
    const el = elMaybe ?? document.getElementById(editingDomId());
    if (!(el instanceof HTMLElement)) {
      return queryText();
    }
    return normalizeSearchText(el.innerText);
  };
  const blurEditingDomMaybe = (editingElMaybe?: HTMLElement | null) => {
    const selection = window.getSelection();
    if (selection != null) {
      selection.removeAllRanges();
    }
    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    if (editingEl instanceof HTMLElement) {
      editingEl.blur();
      return;
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  const commitEditingQuery = (editingElMaybe?: HTMLElement | null): string => {
    const editingEl = editingElMaybe ?? document.getElementById(editingDomId());
    const nextQuery = isEditing() ? readQueryTextFromDom(editingEl instanceof HTMLElement ? editingEl : null) : queryText();
    store.perItem.setSearchQuery(searchItem().id, nextQuery);
    exitEditMode(editingEl instanceof HTMLElement ? editingEl : null);
    return nextQuery;
  };
  const requestEditMode = (caretIdx: number) => {
    setForceNonEditing(false);
    setPendingCaretIdx(caretIdx);
    clearSelectedResultRow();
    if (!isEditing()) {
      store.overlay.setTextEditInfo(store.history, { itemPath: vePath(), itemType: ItemType.Search });
    }
  };
  const warmResultItemDetails = async (resultItemId: string) => {
    await initiateLoadItemMaybe(store, resultItemId);

    let targetItem = itemState.get(resultItemId);
    if (!targetItem) {
      return;
    }

    if (isLink(targetItem)) {
      const linkItem = asLinkItem(targetItem);
      const linkedToId = LinkFns.getLinkToId(linkItem);
      if (linkedToId && !linkItem.linkTo.startsWith("http")) {
        await initiateLoadItemMaybe(store, linkedToId, targetItem.parentId);
        targetItem = itemState.get(linkedToId) ?? targetItem;
      }
    }

    if (isContainer(targetItem) && !asContainerItem(targetItem).childrenLoaded) {
      await initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(targetItem, null));
    }
  };

  const warmSearchResults = async (result: Array<{ path: Array<{ id: string }> }>) => {
    const resultIds = [...new Set(result
      .map(r => r.path[r.path.length - 1]?.id)
      .filter((id): id is string => !!id))];
    await Promise.all(resultIds.map(id => warmResultItemDetails(id)));
  };

  const runSearch = async (selectFirstResultRow: boolean, editingElMaybe?: HTMLElement | null) => {
    const text = commitEditingQuery(editingElMaybe);
    if (text == "") {
      store.perItem.setSearchResults(searchItem().id, null);
      clearSelectedResultRow();
      requestArrange(store, "search-clear-results");
      return;
    }

    const result = await server.search(null, text, store.general.networkStatus);
    store.perItem.setSearchResults(searchItem().id, result);
    store.perItem.setSearchSelectedResultIndex(searchItem().id, selectFirstResultRow && result.length > 0 ? 0 : -1);
    requestArrange(store, "search-results");
    void warmSearchResults(result);
  };

  const queryInputMouseDown = (ev: MouseEvent) => {
    if (isEditing()) {
      ev.stopPropagation();
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    const el = document.getElementById(editingDomId());
    const closestIdx = el instanceof HTMLElement
      ? closestCaretPositionToClientPx(el, { x: ev.clientX, y: ev.clientY })
      : queryText().length;
    requestEditMode(closestIdx);
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
        void runSearch(true, ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null);
        return;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        exitEditMode(ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null);
        return;
    }
  };

  createEffect(() => {
    if (!isListPageMainRoot() || pendingCaretIdx() == null || !isEditing()) {
      return;
    }
    const caretIdx = pendingCaretIdx()!;
    const raf = requestAnimationFrame(() => {
      const freshEl = document.getElementById(editingDomId());
      if (freshEl instanceof HTMLElement) {
        freshEl.focus();
        setCaretPosition(freshEl, caretIdx);
      } else {
        console.warn("Could not enter search edit mode because the text element no longer exists", { itemPath: vePath() });
      }
      setPendingCaretIdx(null);
      store.overlay.autoFocusSearchInput.set(false);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    if (!isListPageMainRoot()) {
      return;
    }
    if (!store.overlay.autoFocusSearchInput.get()) {
      return;
    }
    if (forceNonEditing()) {
      return;
    }
    if (pendingCaretIdx() != null) {
      return;
    }
    requestEditMode(queryText().length);
  });

  const renderSearchWorkspace = () => {
    const controlsWidthPx = calcSearchWorkspaceControlsWidthPx(boundsPx().w);
    const inputWidthPx = calcSearchWorkspaceInputWidthPx(boundsPx().w);
    const lowerTopPx = calcSearchWorkspaceResultsTopPx();
    return (
      <div class="absolute bg-white"
        style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `${desktopStackRootStyle(props.visualElement)}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
          <div class="absolute pointer-events-none"
            style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `background-color: ${FIND_HIGHLIGHT_COLOR};`} />
        </Show>
        <div class="absolute border-b border-slate-300 bg-white"
          style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${lowerTopPx}px;`}>
          <div class="absolute"
            style={`left: ${Math.max(0, Math.round((boundsPx().w - controlsWidthPx) / 2))}px; top: ${SEARCH_WORKSPACE_TOP_INSET_PX}px; width: ${controlsWidthPx}px;`}>
            <div class="flex items-center gap-[10px]">
              <div
                class="border border-[#999] rounded-xs bg-white overflow-hidden"
                style={`width: ${inputWidthPx}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
                onMouseDown={queryInputMouseDown}>
                <div class="relative flex items-center h-full overflow-hidden whitespace-nowrap px-2.5"
                  style="font-size: 16px;">
                  <Show when={!isEditing() && queryText() == ""}>
                    <div class="absolute inset-y-0 left-[10px] flex items-center text-slate-500 pointer-events-none">
                      Search...
                    </div>
                  </Show>
                  <span id={editingDomId()}
                    class={`outline-hidden ${!isEditing() && queryText() == "" ? "text-transparent" : "text-black"}`}
                    style="display: inline-block; min-width: 1px; white-space: nowrap; font-size: 16px;"
                    contentEditable={isEditing() ? true : undefined}
                    spellcheck={isEditing()}
                    onKeyDown={keyDownHandler}
                    onInput={inputListener}>
                    {isEditing() ? editableQueryText() : (queryText() == "" ? EMPTY_SEARCH_EDIT_TEXT : queryText())}<span></span>
                  </span>
                </div>
              </div>
              <button
                class="border border-[#999] rounded-xs bg-white text-black cursor-pointer"
                style={`width: ${SEARCH_WORKSPACE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
                type="button"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  void runSearch(false);
                }}
                onMouseUp={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                }}
                >
                Search
              </button>
            </div>
          </div>
        </div>
        <For each={VesCache.render.getChildren(vePath())()}>{childVe =>
          <VisualElement_Desktop visualElement={childVe.get()} />
        }</For>
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
