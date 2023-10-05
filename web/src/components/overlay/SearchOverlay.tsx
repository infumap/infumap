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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { LastMouseMoveEventState } from "../../mouse/state";
import { desktopPxFromMouseEvent, isInside } from "../../util/geometry";
import { SearchResult, server } from "../../server";
import { ItemType } from "../../items/base/item";
import { Uid } from "../../util/uid";
import { switchToPage } from "../../layout/navigation";
import { useUserStore } from "../../store/UserStoreProvider";
import { VeFns } from "../../layout/visual-element";
import { createBooleanSignal } from "../../util/signals";

export const SearchOverlay: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  const boxBoundsPx = () => {
    return ({
      x: 10,
      y: 55,
      w: 400,
      h: 64
    });
  }

  let overResultsDiv = false;
  const resultsDivMouseDownListener = () => { overResultsDiv = true; }
  const resultsDivMouseUpListener = () => { overResultsDiv = false; }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    const desktopPx = desktopPxFromMouseEvent(ev);
    if (isInside(desktopPx, boxBoundsPx())) { return; }
    if (overResultsDiv) { return; }
    desktopStore.setSearchOverlayVisible(false);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    LastMouseMoveEventState.set(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  onMount(() => {
    textElement?.focus();
  });

  const handleSearchClick = async () => {
    const pageIdMaybe = isGlobalSearchSignal.get() ? null : desktopStore.currentPage()!.itemId;
    const result = await server.search(pageIdMaybe, textElement!.value);
    resultsSignal.set(result);
  };

  const handleInputKeyDown = async (ev: KeyboardEvent) => {
    if (ev.code == "Enter") {
      await handleSearchClick();
    }
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
  }

  const containingPageId = (result: SearchResult) => {
    for (let i=result.parentPath.length-1; i>=0; --i) {
      if (result.parentPath[i].itemType == ItemType.Page) {
        return result.parentPath[i].id;
      }
    }
    return result.parentPath[0].id;
  }

  const resultClickHandler = (id: Uid) => {
    return (_ev: MouseEvent) => {
      desktopStore.setSearchOverlayVisible(false);
      switchToPage(desktopStore, userStore, VeFns.veidFromId(id), true);
    }
  }

  const isGlobalSearchSignal = createBooleanSignal(true);

  const toggleScope = () => {
    isGlobalSearchSignal.set(!isGlobalSearchSignal.get());
  }

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px`}>
        <div class="mt-[3px]">
          <div class="inline-block ml-[8px]">
            Search scope
          </div>
          <div class="inline-block ml-[8px]">
            <input type="radio" name="scope" id="global" checked={isGlobalSearchSignal.get()} onClick={toggleScope} />
            <label for="global">Global</label>
          </div>
          <div class="inline-block ml-[8px]">
            <input type="radio" name="scope" id="page" checked={!isGlobalSearchSignal.get()} onClick={toggleScope} />
            <label for="page">Below current page</label>
          </div>
        </div>
        <input ref={textElement}
            class="border border-slate-300 rounded w-[370px] pl-1 m-[3px]"
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
             class="absolute border rounded bg-white mb-1 shadow-md border-black"
             style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y + 72}px; width: ${boxBoundsPx().w}px;`}>
          <Show when={resultsSignal.get()!.length > 0}>
            <For each={resultsSignal.get()}>{result =>
              <div class="mb-[8px] cursor-pointer" onclick={resultClickHandler(containingPageId(result))}>
                <For each={result.parentPath}>{pathElement =>
                  <>
                    <span class="ml-[8px]">{itemTypeIcon(pathElement.itemType)}</span>
                    <span>{pathElement.title}</span>
                  </>
                }</For>
                <span class="ml-[8px]">
                  {result.textContext}
                </span>
              </div>
            }</For>
          </Show>
          <Show when={resultsSignal.get()!.length == 0}>
            <div>[nothing found]</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
