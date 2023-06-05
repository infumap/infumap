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

import { Component } from "solid-js";
import { asRatingItem } from "../../store/desktop/items/rating-item";
import { FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX } from "../../constants";
import { VisualElementOnDesktopProps } from "../VisualElementOnDesktop";
import { VisualElementInTableProps } from "../VisualElementInTable";
import { asTableItem } from "../../store/desktop/items/table-item";


export const Rating: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  const ratingItem = () => asRatingItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const naturalHeightPx = () => LINE_HEIGHT_PX;
  const naturalWidthPx = () => LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const heightScale = () => boundsPx().h / naturalHeightPx();
  const scale = () => Math.min(heightScale(), widthScale());
  const starSizeProp = () => ratingItem().rating / 5 * 1.2;

  return (
    <div class={`absolute`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <div class={`fas fa-star text-gray-400 absolute`} style={`font-size: ${FONT_SIZE_PX * 1.2 * scale()}px; line-height: ${boundsPx().h}px; width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; text-align: center; vertical-align: bottom;`} />
      <div class={`fas fa-star text-yellow-400 absolute`} style={`font-size: ${FONT_SIZE_PX * starSizeProp() * scale()}px; line-height: ${boundsPx().h}px; width: ${boundsPx().w-2}px; height: ${boundsPx().h-2}px; text-align: center; vertical-align: bottom;`} />
    </div>
  );
}


export const RatingInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  const _ratingItem = () => asRatingItem(props.visualElement.item);
  const boundsPx = () => props.visualElement.boundsPx;
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const oneBlockWidthPx = () => {
    const widthBl = asTableItem(props.parentVisualElement.item).spatialWidthGr / GRID_SIZE;
    return boundsPx().w / widthBl;
  }

  return (
    <>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-star text-yellow-400`} />
      </div>
    </>
  );
}
