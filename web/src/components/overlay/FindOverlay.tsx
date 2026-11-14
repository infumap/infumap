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
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { isInside } from "../../util/geometry";
import { performFind, navigateToNextMatch, navigateToPreviousMatch, closeFindOverlay } from "../../layout/find-on-page";
import { DIALOG_INPUT_CLASS, DIALOG_SURFACE_CLASS, dialogIconButtonClass } from "../library/dialogStyle";

export const FindOverlay: Component = () => {
  const store = useStore();
  let textElement: HTMLInputElement | undefined;
  let debounceTimer: number | undefined;

  const boxBoundsPx = () => ({
    x: window.innerWidth - 435,
    y: 5 + store.topToolbarHeightPx(),
    w: 420,
    h: 50
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
         style={`background-color: #00000010; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class={`absolute ${DIALOG_SURFACE_CLASS}`}
           style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px;`}>
        <div class="flex items-center gap-2 p-3 h-full">
          <input ref={textElement}
                 class={`min-w-0 flex-1 ${DIALOG_INPUT_CLASS}`}
                 placeholder="Find in page…" aria-label="Find in page"
                 type="text"
                 onKeyDown={handleInputKeyDown}
                 onInput={(e) => {
                   handleFindDebounced(e.currentTarget.value);
                 }} />
          <span class="min-w-[40px] text-center text-[12px] text-neutral-600">
            {currentMatchDisplay()}
          </span>
          <button type="button" class={dialogIconButtonClass()} aria-label="Previous match"
                  disabled={!canGoPrev()}
                  onClick={() => navigateToPreviousMatch(store)}>
            <i class="bi-chevron-up" />
          </button>
          <button type="button" class={dialogIconButtonClass()} aria-label="Next match"
                  disabled={!canGoNext()}
                  onClick={() => navigateToNextMatch(store)}>
            <i class="bi-chevron-down" />
          </button>
        </div>
      </div>
    </div>
  );
}; 