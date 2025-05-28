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

import { Component, createSignal, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { CursorEventState } from "../../input/state";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { isInside } from "../../util/geometry";

export const FindOverlay: Component = () => {
  const store = useStore();
  let textElement: HTMLInputElement | undefined;
  const [searchText, setSearchText] = createSignal("");
  const [currentMatch, setCurrentMatch] = createSignal(0);
  const [totalMatches, setTotalMatches] = createSignal(0);

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
      store.overlay.findOverlayVisible.set(false);
      return;
    }
    if (isInside(CursorEventState.getLatestDesktopPx(store), boxBoundsRelativeToDesktopPx())) { return; }
    if (overResultsDiv) { return; }
    store.overlay.findOverlayVisible.set(false);
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

  const handleFind = () => {
    const text = textElement!.value;
    setSearchText(text);
    // TODO: Implement actual text search functionality
    // This would need to be integrated with the text rendering system
    setTotalMatches(0); // Placeholder
    setCurrentMatch(0);
  };

  const handleNext = () => {
    if (currentMatch() < totalMatches()) {
      setCurrentMatch(c => c + 1);
      // TODO: Navigate to next match
    }
  };

  const handlePrev = () => {
    if (currentMatch() > 1) {
      setCurrentMatch(c => c - 1);
      // TODO: Navigate to previous match
    }
  };

  const handleInputKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.code === "Enter") {
      if (ev.shiftKey) {
        handlePrev();
      } else {
        handleNext();
      }
    } else if (ev.code === "Escape") {
      store.overlay.findOverlayVisible.set(false);
    }
  };

  return (
    <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border border-gray-400 rounded-lg bg-white shadow-lg"
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
        <div class="flex items-center justify-between px-3 py-2 h-full">
          <input ref={textElement}
                 class="border border-gray-300 rounded-md flex-1 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                 placeholder="Find in page..."
                 type="text"
                 onKeyDown={handleInputKeyDown}
                 onInput={(e) => {
                   setSearchText(e.currentTarget.value);
                   handleFind();
                 }} />
          <div class="flex items-center ml-3 space-x-1">
            <button class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={currentMatch() <= 1}
                    onClick={handlePrev}>
              <i class="fa fa-chevron-up text-xs text-gray-600" />
            </button>
            <span class="text-xs text-gray-600 min-w-[40px] text-center">
              {totalMatches() > 0 ? `${currentMatch()}/${totalMatches()}` : '0/0'}
            </span>
            <button class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={currentMatch() >= totalMatches()}
                    onClick={handleNext}>
              <i class="fa fa-chevron-down text-xs text-gray-600" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}; 