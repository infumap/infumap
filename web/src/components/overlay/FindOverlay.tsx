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

import { Component, createEffect, onCleanup, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { CursorEventState } from "../../input/state";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { isInside } from "../../util/geometry";
import { performFind, navigateToNextMatch, navigateToPreviousMatch, closeFindOverlay } from "../../layout/find-on-page";

export const FindOverlay: Component = () => {
  const store = useStore();
  let textElement: HTMLInputElement | undefined;
  let debounceTimer: number | undefined;

  const boxBoundsPx = () => ({
    x: window.innerWidth - 435,
    y: 5 + store.topToolbarHeightPx(),
    w: 420,
    h: 56
  });

  const boxBoundsRelativeToDesktopPx = () => {
    const r = boxBoundsPx();
    r.y -= store.topToolbarHeightPx();
    return r;
  };

  let overResultsDiv = false;
  const resultsDivMouseDownListener = () => { overResultsDiv = true; }
  const resultsDivMouseUpListener = () => { overResultsDiv = false; }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    if (ev.button === MOUSE_RIGHT) {
      closeFindOverlay(store);
      return;
    }
    if (isInside(CursorEventState.getLatestDesktopPx(store), boxBoundsRelativeToDesktopPx())) { return; }
    if (overResultsDiv) { return; }
    closeFindOverlay(store);
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
    // If there's already text from a previous find, select it all
    if (store.find.currentFindText.get()) {
      textElement!.value = store.find.currentFindText.get();
      textElement!.select();
    }
  });

  onCleanup(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  });

  const handleFindDebounced = (text: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      performFind(store, text);
    }, 300) as unknown as number;
  };

  const handleInputKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.code === "Enter") {
      if (ev.shiftKey) {
        navigateToPreviousMatch(store);
      } else {
        navigateToNextMatch(store);
      }
    } else if (ev.code === "Escape") {
      closeFindOverlay(store);
    }
  };

  // Create reactive effects for match display
  createEffect(() => {
    const matches = store.find.findMatches.get();
    const currentIndex = store.find.currentMatchIndex.get();
    if (matches.length === 0 && store.find.currentFindText.get()) {
      // No matches found
    }
  });

  const currentMatchDisplay = () => {
    const matches = store.find.findMatches.get();
    const currentIndex = store.find.currentMatchIndex.get();
    if (matches.length === 0) {
      return store.find.currentFindText.get() ? '0/0' : '';
    }
    return `${currentIndex + 1}/${matches.length}`;
  };

  const hasMatches = () => store.find.findMatches.get().length > 0;
  const canGoPrev = () => hasMatches();
  const canGoNext = () => hasMatches();

  return (
    <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-hidden"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border border-gray-400 rounded-lg bg-white shadow-lg"
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
        <div class="flex items-center justify-between px-3 py-2 h-full">
          <input ref={textElement}
                 class="border border-gray-300 rounded-md flex-1 px-3 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                 placeholder="Find in page..."
                 type="text"
                 onKeyDown={handleInputKeyDown}
                 onInput={(e) => {
                   handleFindDebounced(e.currentTarget.value);
                 }} />
          <div class="flex items-center ml-3 space-x-1">
            <button class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={!canGoPrev()}
                    onClick={() => navigateToPreviousMatch(store)}>
              <i class="fa fa-chevron-up text-xs text-gray-600" />
            </button>
            <span class="text-xs text-gray-600 min-w-[40px] text-center">
              {currentMatchDisplay()}
            </span>
            <button class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={!canGoNext()}
                    onClick={() => navigateToNextMatch(store)}>
              <i class="fa fa-chevron-down text-xs text-gray-600" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}; 