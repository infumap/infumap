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
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { MOD } from "../../util/platform";
import { Key } from "../HelpContent";

const HINT_WIDTH_PX = 280;
const HINT_GAP_PX = 6;
const HINT_MARGIN_PX = 8;
const HINT_APPROX_HEIGHT_PX = 110;

/**
 * Explains a new text file item to a user who types into its "paste text" placeholder, where typing does nothing.
 * New users took the item for somewhere to write and didn't read the placeholder. It lets pointer events through
 * and doesn't take focus, so the paste it asks for still goes to the item.
 */
export const PasteTextHint: Component = () => {
  const store = useStore();

  const path = () => {
    const hintPath = store.overlay.pasteTextHintPath.get();
    return hintPath != null && store.overlay.textEditInfo()?.itemPath == hintPath ? hintPath : null;
  };

  // Measured from the DOM when shown, not tracked after. The item doesn't move while its title is being edited.
  const positionPx = (hintPath: string): { x: number, y: number, above: boolean } | null => {
    const titleEl = document.getElementById(hintPath + ":title");
    const desktopEl = document.getElementById("desktop");
    if (titleEl == null || desktopEl == null) { return null; }
    const titleRect = titleEl.getBoundingClientRect();
    const desktopRect = desktopEl.getBoundingClientRect();
    const x = Math.max(HINT_MARGIN_PX,
      Math.min(titleRect.left - desktopRect.left, desktopRect.width - HINT_WIDTH_PX - HINT_MARGIN_PX));
    // Above the title only if the hint (about 110px tall) doesn't fit below it and there is more room above.
    const roomBelowPx = desktopRect.bottom - titleRect.bottom;
    const roomAbovePx = titleRect.top - desktopRect.top;
    const above = roomBelowPx < HINT_APPROX_HEIGHT_PX && roomAbovePx > roomBelowPx;
    const y = above ? roomAbovePx - HINT_GAP_PX : titleRect.bottom - desktopRect.top + HINT_GAP_PX;
    return { x, y, above };
  };

  return (
    <Show when={path()}>{hintPath =>
      <Show when={positionPx(hintPath())}>{pos =>
        <div class="absolute pointer-events-none border rounded bg-slate-50 shadow-lg text-sm p-[8px] leading-snug"
             style={`left: ${pos().x}px; top: ${pos().y}px; width: ${HINT_WIDTH_PX}px; ` +
                    `${pos().above ? "transform: translateY(-100%); " : ""}` +
                    `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}>
          <div class="font-semibold mb-[3px]">This is a text file</div>
          <div class="text-slate-700">
            Its content is pasted in, not typed. Paste text (<Key>{MOD}</Key> <Key>V</Key>) to fill it, then give it a title.
          </div>
          <div class="text-slate-700 mt-[4px]">To write text, use a note (<Key>N</Key>).</div>
        </div>
      }</Show>
    }</Show>
  );
}
