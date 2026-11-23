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

import { Component, For, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { VisualElement_Desktop } from "../VisualElement";
import { AttachmentsOverflowMarker } from "./HiddenAttachmentsMarker";


/**
 * The attachments of an item in a calendar page, drawn along the right of its line (see
 * arrangeCalendarItemAttachments), and the insertion bar while an item is dragged over the strip they occupy. The line
 * item components don't draw attachments, so this is rendered by the page, after the item. Attachment bounds are
 * relative to the item, as for a spatial item.
 */
export const CalendarItemAttachments: Component<{ itemVe: VisualElement }> = props => {
  const store = useStore();
  const vePath = () => VeFns.veToPath(props.itemVe);
  const boundsPx = () => props.itemVe.boundsPx;
  const insertIndex = () => store.perVe.getMoveOverAttachmentIndex(vePath());
  const showInsertBar = () => store.perVe.getMovingItemIsOverAttach(vePath()) && insertIndex() >= 0;
  const insertBarLeftPx = () => {
    const blockSizePx = props.itemVe.attachmentBlockSizePx ?? boundsPx().h;
    // At position 0, align with the right edge of the item.
    return boundsPx().w - insertIndex() * blockSizePx + (insertIndex() == 0 ? -4 : -2);
  };

  return (
    <div class="absolute pointer-events-none"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: 0px; height: 0px;`}>
      <For each={VesCache.render.getAttachments(vePath())()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <AttachmentsOverflowMarker visualElement={props.itemVe} />
      <Show when={showInsertBar()}>
        <div class="absolute bg-black"
          style={`left: ${insertBarLeftPx()}px; top: 0px; width: 4px; height: ${boundsPx().h}px;`} />
      </Show>
    </div>
  );
}
