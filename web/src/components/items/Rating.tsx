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
import { asRatingItem } from "../../items/rating-item";
import { COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, LINE_HEIGHT_PX } from "../../constants";
import { VisualElementProps } from "../VisualElement";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { useStore } from "../../store/StoreProvider";
import { FEATURE_COLOR } from "../../style";
import { isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { BoundingBox } from "../../util/geometry";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Rating_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const ratingItem = () => asRatingItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const naturalHeightPx = () => LINE_HEIGHT_PX;
  const naturalWidthPx = () => LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const starSizeProp = () => ratingItem().rating / 5 * 1.2;
  const showTriangleDetail = () => (boundsPx().h / LINE_HEIGHT_PX) > 0.5;

  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();


  // TODO (LOW): perhaps different rendering for non-detailed element, or no rendering at all.
  return (
    <div class={`absolute`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)}`}>
      <div class={`fas fa-star text-gray-400 absolute`}
           style={`font-size: ${FONT_SIZE_PX * 1.2 * scale()}px; line-height: ${boundsPx().h}px; ` +
                  `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                  `text-align: center; vertical-align: bottom;`} />
      <div class={`fas fa-star text-yellow-400 absolute`}
           style={`font-size: ${FONT_SIZE_PX * starSizeProp() * scale()}px; line-height: ${boundsPx().h}px; ` +
                  `width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; ` +
                  `text-align: center; vertical-align: bottom;`} />
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-sm`}
             style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.flags & VisualElementFlags.Detailed  && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)) &&
                  showTriangleDetail()}>
        <InfuLinkTriangle />
      </Show>
    </div>
  );
}
