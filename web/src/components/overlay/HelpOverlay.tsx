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
import { DIALOG_BACKDROP_CLASS, DIALOG_SURFACE_CLASS, DialogHeader } from "../library/dialogStyle";


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
    <div class={`fixed left-0 top-0 bottom-0 right-0 flex items-center justify-center p-[10px] ${DIALOG_BACKDROP_CLASS}`}
      style={`z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY + 1}; cursor: default;`}
      onMouseDown={backdropMouseDown}
      onMouseUp={eatMouseEvent}
      onMouseMove={eatMouseEvent}
      onDblClick={eatMouseEvent}
      onTouchStart={eatTouchEvent}
      onTouchEnd={eatTouchEvent}
      onTouchMove={eatTouchEvent}
      onTouchCancel={eatTouchEvent}>
      <div class={`flex flex-col overflow-hidden select-text ${DIALOG_SURFACE_CLASS}`}
        style="width: 560px; max-width: 100%; max-height: 100%;"
        role="dialog" aria-label="Help">
        <DialogHeader title="Help" closeLabel="Close help (Esc)" onClose={close} />
        <div class="px-3 py-3 overflow-y-auto min-h-0">
          <HelpContent />
        </div>
      </div>
    </div>
  );
}
