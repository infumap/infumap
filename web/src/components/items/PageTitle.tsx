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
import { VisualElementProps } from "../VisualElement";
import { PageFns, asPageItem } from "../../items/page-item";
import { hexToRGBA } from "../../util/color";
import { Colors } from "../../style";
import { LINE_HEIGHT_PX } from "../../constants";


export const PageTitle_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => PageFns.calcTitleSpatialDimensionsBl(pageItem());
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const widthScale = () => boundsPx().w / naturalWidthPx();
  const textBlockScale = () => widthScale();
  const fullTitleColor = () => `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;

  return (
    <div class="absolute pointer-events-none"
         style={`width: ${boundsPx().w}px; height: ${boundsPx().h}px; left: ${boundsPx().x}px; top: ${boundsPx().y}px;`}>
      <div class="inline-block whitespace-nowrap"
           style={`color: ${fullTitleColor()}; ` +
                  `font-size: ${PageFns.pageTitleStyle().fontSize}px; ` +
                  `${PageFns.pageTitleStyle().isBold ? "font-weight: bold;" : ""} ` +
                  `transform: scale(${textBlockScale()}); transform-origin: top left;`}>
        {pageItem().title}
      </div>
    </div>
  );
}
