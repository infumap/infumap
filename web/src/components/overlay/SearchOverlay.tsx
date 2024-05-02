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
import { switchToPage } from "../../layout/navigation";
import { VeFns } from "../../layout/visual-element";
import { createBooleanSignal, createNumberSignal } from "../../util/signals";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { initiateLoadItemMaybe } from "../../layout/load";
import { isInside } from "../../util/geometry";


export const SearchOverlay: Component = () => {
  const store = useStore();

  const boxBoundsPx = () => {
    return ({
      x: 5,
      y: 5 + store.topToolbarHeight(),
      w: 405,
      h: 64
    });
  }

  let overResultsDiv = false;
  const resultsDivMouseDownListener = () => { overResultsDiv = true; }
  const resultsDivMouseUpListener = () => { overResultsDiv = false; }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (isInside(CursorEventState.getLatestDesktopPx(store), boxBoundsPx())) { return; }
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
    const result = await server.search(pageIdMaybe, textElement!.value);
    searchedFor = textElement!.value;
    resultsSignal.set(result);
  };

  const handleInputKeyDown = async (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.code == "Enter") {
      if (currentSelectedResult.get() != -1) {
        const selectedPageId = currentSelectedPageId()!;
        store.overlay.searchOverlayVisible.set(false);
        await initiateLoadItemMaybe(store, selectedPageId);
        switchToPage(store, VeFns.veidFromId(selectedPageId), true, false, false);
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

  const containingPageId = (result: SearchResult) => {
    for (let i=result.path.length-2; i>=0; --i) {
      if (result.path[i].itemType == ItemType.Page) {
        return result.path[i].id;
      }
    }
    return result.path[0].id;
  };

  const resultClickHandler = (resultPageId: Uid) => {
    return async (_ev: MouseEvent) => {
      await initiateLoadItemMaybe(store, resultPageId);
      store.overlay.searchOverlayVisible.set(false);
      switchToPage(store, VeFns.veidFromId(resultPageId), true, false, false);
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
  const currentSelectedPageId = () => {
    if (currentSelectedResult.get() == -1) { return null; }
    const result =  resultsSignal.get()![currentSelectedResult.get()]!;
    return containingPageId(result);
  };

  const shortenTextMaybe = (text: string): string => {
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

  return (
    <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px`}>
        <div class="mt-[5px]" style="transform: scale(0.8); transform-origin: top left;">
          <div class="inline-block ml-[10px]">
            Search scope
          </div>
          <div class="inline-block ml-[14px]">
            <input type="radio" name="scope" id="global" checked={isGlobalSearchSignal.get()} onClick={toggleScope} />
            <label for="global" class="ml-[4px]">Global</label>
          </div>
          <div class="inline-block ml-[14px]">
            <input type="radio" name="scope" id="page" checked={!isGlobalSearchSignal.get()} onClick={toggleScope} />
            <label for="page" class="ml-[4px]">Below current page</label>
          </div>
        </div>
        <input ref={textElement}
               class="border border-slate-300 rounded w-[370px] pl-1 ml-[5px] mr-[5px]"
               autocomplete="on"
               value={""}
               type="text"
               onKeyDown={handleInputKeyDown} />
        <div class="inline-block">
          <i class="fa fa-search cursor-pointer" onclick={handleSearchClick} />
        </div>
      </div>
      <Show when={resultsSignal.get() != null}>
        <div onmousedown={resultsDivMouseDownListener}
             onmouseup={resultsDivMouseUpListener}
             class="absolute border rounded bg-white mb-1 shadow-md border-black text-sm pt-[5px]"
             style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y + 72}px; width: ${boxBoundsPx().w}px;`}>
          <Show when={resultsSignal.get()!.length > 0}>
            <For each={resultsSignal.get()}>{result =>
              <div class={`mb-[8px] cursor-pointer hover:bg-slate-200 ` +
                          `${currentSelectedId() == null ? "" : (currentSelectedId() == result.path[result.path.length-1].id ? "bg-slate-100" : "")}`}
                   onclick={resultClickHandler(containingPageId(result))}>
                <For each={result.path}>{pathElement =>
                  <Show when={pathElement.itemType != "composite"}>
                    <span class="ml-[12px]">{itemTypeIcon(pathElement.itemType)}</span>
                    <span class="ml-[4px]">{shortenTextMaybe(pathElement.title!)}</span>
                  </Show>
                }</For>
              </div>
            }</For>
          </Show>
          <Show when={resultsSignal.get()!.length == 0}>
            <div>[no results found]</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
