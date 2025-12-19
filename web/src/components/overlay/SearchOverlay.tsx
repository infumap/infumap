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

import { Accessor, Component, For, Match, Setter, Show, Switch, createSignal, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { CursorEventState } from "../../input/state";
import { SearchResult, server } from "../../server";
import { ItemType } from "../../items/base/item";
import { Uid } from "../../util/uid";
import { switchToItem, switchToPage } from "../../layout/navigation";
import { VeFns } from "../../layout/visual-element";
import { createBooleanSignal, createNumberSignal } from "../../util/signals";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { initiateLoadItemMaybe } from "../../layout/load";
import { isInside } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { isPage } from "../../items/page-item";
import { MOUSE_RIGHT} from "../../input/mouse_down";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";

export const SearchOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;

  interface SearchResultSignal {
    get: Accessor<Array<SearchResult> | null>,
    set: Setter<Array<SearchResult> | null>,
  }

  function createResultSignal(): SearchResultSignal {
    let [uidAccessor, uidSetter] = createSignal<Array<SearchResult> | null>(null, { equals: false });
    return { get: uidAccessor, set: uidSetter };
  }

  const resultsSignal = createResultSignal();
  const [currentPage, setCurrentPage] = createSignal(1);
  const [hasMorePages, setHasMorePages] = createSignal(false);

  const boxBoundsPx = () => {
    return ({
      x: 15,
      y: 5 + store.topToolbarHeightPx(),
      w: 420,
      h: 80
    });
  }

  const boxBoundsRelativeToDesktopPx = () => {
    const r = boxBoundsPx();
    r.y -= store.topToolbarHeightPx();
    return r;
  }

  let overResultsDiv = false;
  const resultsDivMouseDownListener = () => { overResultsDiv = true; }
  const resultsDivMouseUpListener = () => { overResultsDiv = false; }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (ev.button === MOUSE_RIGHT) {
      store.overlay.searchOverlayVisible.set(false);
      return;
    }
    if (isInside(CursorEventState.getLatestDesktopPx(store), boxBoundsRelativeToDesktopPx())) { return; }
    if (overResultsDiv) { return; }
    store.overlay.searchOverlayVisible.set(false);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  onMount(() => {
    textElement?.focus();
  });

  let searchedFor = null;

  const handleSearchClick = async () => {
    const pageIdMaybe = isGlobalSearchSignal.get() ? null : store.history.currentPageVeid()!.itemId;
    const result = await server.search(pageIdMaybe, textElement!.value, store.general.networkStatus, currentPage());
    searchedFor = textElement!.value;
    resultsSignal.set(result);
    setHasMorePages(result.length === 10);
  };

  const handleNextPage = async () => {
    setCurrentPage(p => p + 1);
    await handleSearchClick();
  };

  const handlePrevPage = async () => {
    if (currentPage() > 1) {
      setCurrentPage(p => p - 1);
      await handleSearchClick();
    }
  };

  const switchToItm = async (selectedId: Uid) => {
    const selectedItem = itemState.get(selectedId)!;
    if (!isPage(selectedItem)) {
      switchToItem(store, selectedId, true);
      return;
    }
    switchToPage(store, VeFns.veidFromId(selectedId), true, true, false);
  }

  const handleInputKeyDown = async (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.code == "Enter") {
      if (currentSelectedResult.get() != -1) {
        const selectedId = currentSelectedId()!;
        store.overlay.searchOverlayVisible.set(false);
        await initiateLoadItemMaybe(store, selectedId);
        switchToItm(selectedId);
      } else {
        await handleSearchClick();
      }
    }
    if (resultsSignal.get() == null) { return; }
    if (ev.code == "ArrowUp") {
      if (currentSelectedResult.get() == -1 && resultsSignal.get()!.length > 0) {
        currentSelectedResult.set(resultsSignal.get()!.length-1);
        return;
      }
      if (currentSelectedResult.get() > 0) {
        currentSelectedResult.set(currentSelectedResult.get() - 1);
      }
      return;
    }
    if (ev.code == "ArrowDown") {
      if (currentSelectedResult.get() == -1 && resultsSignal.get()!.length > 0) {
        currentSelectedResult.set(0);
        return;
      }
      if (currentSelectedResult.get() < resultsSignal.get()!.length-1) {
        currentSelectedResult.set(currentSelectedResult.get() + 1);
      }
      return;
    }
    currentSelectedResult.set(-1);
  }

  const itemTypeIcon = (itemType: string) => {
    return (
      <Switch>
        <Match when={itemType == ItemType.Page}><i class="fa fa-folder" /></Match>
        <Match when={itemType == ItemType.Table}><i class="fa fa-table" /></Match>
        <Match when={itemType == ItemType.Note}><i class="fa fa-sticky-note" /></Match>
        <Match when={itemType == ItemType.File}><i class="fa fa-file" /></Match>
        <Match when={itemType == ItemType.Image}><i class="fa fa-image" /></Match>
        <Match when={itemType == ItemType.Link}><i class="fa fa-link" /></Match>
        <Match when={itemType == ItemType.Password}><i class="fa fa-eye-slash" /></Match>
        <Match when={itemType == ItemType.Rating}><i class="fa fa-star" /></Match>
      </Switch>
    );
  };

  const _containingPageId = (result: SearchResult) => {
    for (let i=result.path.length-2; i>=0; --i) {
      if (result.path[i].itemType == ItemType.Page) {
        return result.path[i].id;
      }
    }
    return result.path[0].id;
  };

  const resultClickHandler = (resultItemId: Uid) => {
    return async (_ev: MouseEvent) => {
      await initiateLoadItemMaybe(store, resultItemId);
      store.overlay.searchOverlayVisible.set(false);
      switchToItm(resultItemId);
    }
  };

  const isGlobalSearchSignal = createBooleanSignal(true);
  const toggleScope = () => { isGlobalSearchSignal.set(!isGlobalSearchSignal.get()); };

  const currentSelectedResult = createNumberSignal(-1);
  const currentSelectedId = () => {
    if (currentSelectedResult.get() == -1) { return null; }
    const result = resultsSignal.get()![currentSelectedResult.get()]!;
    return result.path[result.path.length-1].id;
  };
  const _currentSelectedPageId = () => {
    if (currentSelectedResult.get() == -1) { return null; }
    const result =  resultsSignal.get()![currentSelectedResult.get()]!;
    return _containingPageId(result);
  };


  const shortenTextMaybe = (text: string): string => {
    if (text == null) { return ''; }
    if (text.length <= 60) {
      return text;
    }
    const idx = text.toLowerCase().indexOf(searchedFor!.toLowerCase());
    if (idx == -1) { return text; } // should never occur.
    let startIdx = 0;
    let prefix = "";
    if (idx > 30) { startIdx = idx - 30; prefix = "..."; }
    let endIdx = idx + searchedFor!.length + 30;
    let postfix = ""
    if (endIdx > text.length) { endIdx = text.length; }
    else { postfix = "..."; }
    return prefix + text.substring(startIdx, endIdx) + postfix;
  };

  const handleCopyId = (resultItemId: Uid) => {
    return async (_ev: MouseEvent) => {
      navigator.clipboard.writeText(resultItemId);
      store.overlay.toolbarTransientMessage.set({ text: "file id → clipboard", type: TransientMessageType.Info });
      setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
    }
  }

  return (
    <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-hidden"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border border-gray-400 rounded-lg bg-white shadow-lg"
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
        <div class="px-3 py-2">
          <div class="flex items-center justify-between mb-2 text-xs text-gray-600">
            <span class="font-medium">Search scope</span>
            <div class="flex items-center space-x-3">
              <label class="flex items-center cursor-pointer">
                <input type="radio" name="scope" checked={isGlobalSearchSignal.get()} onClick={toggleScope} class="mr-1.5" />
                Global
              </label>
              <label class="flex items-center cursor-pointer">
                <input type="radio" name="scope" checked={!isGlobalSearchSignal.get()} onClick={toggleScope} class="mr-1.5" />
                Below current page
              </label>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <input ref={textElement}
                   class="border border-gray-300 rounded-md flex-1 px-3 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                   autocomplete="on"
                   placeholder="Search..."
                   value={""}
                   type="text"
                   onKeyDown={handleInputKeyDown} />
            <button class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 transition-colors"
                    onclick={handleSearchClick}>
              <i class="fa fa-search text-gray-600" />
            </button>
          </div>
        </div>
      </div>
      <Show when={resultsSignal.get() != null}>
        <div onmousedown={resultsDivMouseDownListener}
             onmouseup={resultsDivMouseUpListener}
             class="absolute border border-gray-400 rounded-lg bg-white shadow-lg text-sm"
             style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y + 88}px; width: ${boxBoundsPx().w}px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
          <Show when={resultsSignal.get()!.length > 0}>
            <div class="max-h-80 overflow-y-auto">
              <For each={resultsSignal.get()}>{result =>
                <div class="flex items-start border-b border-gray-100 last:border-b-0">
                  <div class="shrink-0 w-8 flex justify-center pt-3">
                    <i class="fa fa-hashtag text-gray-400 hover:text-blue-500 cursor-pointer text-xs" 
                       onMouseDown={handleCopyId(result.path[result.path.length-1].id)} />
                  </div>
                  <div class={`flex-1 p-3 cursor-pointer hover:bg-gray-50 transition-colors ` +
                              `${currentSelectedId() == null ? "" : (currentSelectedId() == result.path[result.path.length-1].id ? "bg-blue-50" : "")}`}
                       onclick={resultClickHandler(result.path[result.path.length-1].id)}>
                    <div class="flex items-center flex-wrap gap-2">
                      <For each={result.path}>{pathElement =>
                        <Show when={pathElement.itemType != "composite"}>
                          <div class="flex items-center text-gray-600">
                            <span class="text-xs">{itemTypeIcon(pathElement.itemType)}</span>
                            <span class="ml-1 text-sm">{shortenTextMaybe(pathElement.title!)}</span>
                          </div>
                        </Show>
                      }</For>
                    </div>
                  </div>
                </div>
              }</For>
            </div>
            <div class="flex justify-between items-center p-3 border-t border-gray-200 bg-gray-50">
              <button
                class="px-3 py-1.5 rounded-md hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
                disabled={currentPage() === 1}
                onClick={handlePrevPage}>
                Previous
              </button>
              <span class="text-sm text-gray-600">Page {currentPage()}</span>
              <button
                class="px-3 py-1.5 rounded-md hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
                disabled={!hasMorePages()}
                onClick={handleNextPage}>
                Next
              </button>
            </div>
          </Show>
          <Show when={resultsSignal.get()!.length == 0}>
            <div class="p-4 text-center text-gray-500 text-sm">[no results found]</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
