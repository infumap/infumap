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
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { VisualElement_Desktop } from "../VisualElement";
import { AttachmentsOverflowMarker } from "./HiddenAttachmentsMarker";


/**
 * The attachments of a root-like page (the top level page, a popup, the selected page of a list page or an embedded
 * interactive page), along with the overflow marker, and the insertion bar shown when an item is moved over them.
 * These straddle the top edge of the page, so are rendered outside its (clipping, scrolling) viewport, in a container
 * positioned at the top left of the page's bounds by positionStyle.
 */
export const PageAttachments: Component<{ visualElement: VisualElement, pageFns: any, positionStyle: string }> = props => {
  const store = useStore();
  const vePath = () => VeFns.veToPath(props.visualElement);

  return (
    <div class="absolute print:hidden" style={`width: 0px; height: 0px; ${props.positionStyle}`}>
      <For each={VesCache.render.getAttachments(vePath())()}>{attachmentVe =>
        <VisualElement_Desktop visualElement={attachmentVe.get()} />
      }</For>
      <AttachmentsOverflowMarker visualElement={props.visualElement} />
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath()) &&
        store.perVe.getMoveOverAttachmentIndex(vePath()) >= 0}>
        <div class="absolute bg-black pointer-events-none"
          style={`left: ${props.pageFns.attachInsertBarPx().x}px; top: ${props.pageFns.attachInsertBarPx().y}px; ` +
            `width: ${props.pageFns.attachInsertBarPx().w}px; height: ${props.pageFns.attachInsertBarPx().h}px;`} />
      </Show>
    </div>
  );
}
