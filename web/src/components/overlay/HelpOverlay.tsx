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

import { Component } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../constants";
import { HelpContent } from "../HelpContent";


/**
 * Modal: drawn over the toolbar too, and a mouse down anywhere outside the panel closes it. Esc and ? close it
 * (see key.ts).
 */
export const HelpOverlay: Component = () => {
  const store = useStore();

  const close = () => { store.overlay.helpOverlayVisible.set(false); };
  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); };
  const eatTouchEvent = (ev: TouchEvent) => { ev.stopPropagation(); };
  const backdropMouseDown = (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.target == ev.currentTarget) { close(); }
  };

  return (
    <div class="fixed left-0 top-0 bottom-0 right-0 flex items-center justify-center p-[10px]"
      style={`background-color: #00000030; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY + 1}; cursor: default;`}
      onMouseDown={backdropMouseDown}
      onMouseUp={eatMouseEvent}
      onMouseMove={eatMouseEvent}
      onDblClick={eatMouseEvent}
      onTouchStart={eatTouchEvent}
      onTouchEnd={eatTouchEvent}
      onTouchMove={eatTouchEvent}
      onTouchCancel={eatTouchEvent}>
      <div class="bg-white border border-slate-300 rounded-md shadow-lg flex flex-col select-text"
        style="width: 560px; max-width: 100%; max-height: 100%;"
        role="dialog" aria-label="Help">
        <div class="flex items-center justify-between px-4 pt-3 pb-2 border-b border-slate-200">
          <div class="font-bold text-lg">Help</div>
          <button onClick={close} title="Close (Esc)"
            class="text-slate-500 hover:text-slate-700 text-xl leading-none cursor-pointer">&times;</button>
        </div>
        <div class="px-4 py-3 overflow-y-auto min-h-0">
          <HelpContent />
        </div>
      </div>
    </div>
  );
}
