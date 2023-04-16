/*
  Copyright (C) 2023 The Infumap Authors
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
import { asRatingItem } from "../../store/desktop/items/rating-item";
import { GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";
import { ITEM_TYPE_RATING } from "../../store/desktop/items/base/item";
import { HTMLDivElementWithData } from "../../util/html";
import { VisualElement_Concrete } from "../../store/desktop/visual-element";


export const Rating: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const ratingItem = () => asRatingItem(desktopStore.getItem(props.visualElement.itemId)!);
  // refer to: visual-element.ts
  const boundsPx_cache = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    (nodeElement!.data as VisualElement_Concrete) = {
      itemType: ITEM_TYPE_RATING,
      itemId: props.visualElement.itemId,
      parentId: ratingItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes()
    };
    return currentBoundsPx;
  };
  const boundsPx = props.visualElement.boundsPx;

  return (
    <div ref={nodeElement}
         id={props.visualElement.itemId}
         class={`absolute border border-slate-700 rounded-sm shadow-lg`}
         style={`left: ${boundsPx_cache().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={props.visualElement.isInteractive}>
        <i class={`fas fa-star text-yellow-400`} />
      </Show>
    </div>
  );
}


export const RatingInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const desktopStore = useDesktopStore();
  let nodeElement: HTMLDivElementWithData | undefined;

  const ratingItem = () => asRatingItem(desktopStore.getItem(props.visualElement.itemId)!);
  // refer to: visual-element.ts
  const boundsPx_cache = () => {
    let currentBoundsPx = props.visualElement.boundsPx();
    if (nodeElement == null) { return currentBoundsPx; }
    (nodeElement!.data as VisualElement_Concrete) = {
      itemType: ITEM_TYPE_RATING,
      itemId: props.visualElement.itemId,
      parentId: ratingItem().parentId,
      boundsPx: currentBoundsPx,
      childAreaBoundsPx: null,
      hitboxes: props.visualElement.hitboxes()
    };
    return currentBoundsPx;
  };
  const boundsPx = props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(desktopStore.getItem(props.parentVisualElement.itemId)!).spatialWidthGr.get() / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div ref={nodeElement}
           id={props.visualElement.itemId}
           class="absolute text-center"
           style={`left: ${boundsPx_cache().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-star text-yellow-400`} />
      </div>
    </>
  );
}
