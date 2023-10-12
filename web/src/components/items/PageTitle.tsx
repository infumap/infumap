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


export const PageTitle_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;

  const fullTitleColor = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;
  }

  return (
    <div class="absolute" style={`color: ${fullTitleColor()}; font-size: ${PageFns.pageTitleStyle().fontSize}px; ${PageFns.pageTitleStyle().isBold ? "font-weight: bold;" : ""} width: ${boundsPx().w}px; height: ${boundsPx().h}px; left: ${boundsPx().x}px; top: ${boundsPx().y}px; text-align: center; pointer-events: none;`}>
      {pageItem().title}
    </div>
  );
}


export const PageTitle_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const pageItem = () => asPageItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const margin = 4;
  const widthPx = () => boundsPx().w - margin * 2;

  const fullTitleColor = () => {
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;
  }

  return (
    <div class="absolute overflow-hidden border-b border-slate-700" style={`margin-left: 4px; margin-right: 4px; color: ${fullTitleColor()}; font-size: ${PageFns.pageTitleStyle_List().fontSize}px; ${PageFns.pageTitleStyle_List().isBold ? "font-weight: bold;" : ""} width: ${widthPx()}px; height: ${boundsPx().h}px; left: ${boundsPx().x}px; top: ${boundsPx().y}px; pointer-events: none;`}>
      {pageItem().title}
    </div>
  );
}
