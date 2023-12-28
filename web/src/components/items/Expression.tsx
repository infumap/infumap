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
import { VisualElementProps } from "../VisualElement";
import { useStore } from "../../store/StoreProvider";
import { ExpressionFns, asExpressionItem } from "../../items/expression-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { asPageItem, isPage } from "../../items/page-item";
import { FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_SHADOW } from "../../constants";
import { asXSizableItem } from "../../items/base/x-sizeable-item";

// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Expression_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = ExpressionFns.asExpressionMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentDisplayItem = itemState.get(parentVeid.itemId)!;

      let parentCanonicalItem = VeFns.canonicalItemFromVeid(parentVeid);
      if (parentCanonicalItem == null) {
        // case where link is virtual (not in itemState). happens in list selected page case.
        parentCanonicalItem = itemState.get(parentVeid.itemId)!;
      }

      if (isPage(parentDisplayItem)) {
        cloned.spatialWidthGr = asPageItem(parentDisplayItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(parentCanonicalItem).spatialWidthGr;
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return ExpressionFns.calcSpatialDimensionsBl(expressionItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX*2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const outerClass = (shadow: boolean) => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return 'absolute rounded-sm bg-white';
    } else {
      return `absolute border border-slate-700 rounded-sm ${shadow ? "shadow-lg" : ""} bg-white`;
    }
  };

  const renderShadow = () =>
  <div class={`${outerClass(true)}`}
       style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />;

  const renderDetailed = () =>
    <>
    </>;

  return (
    <>
    {renderShadow()}
    <div class={`${outerClass(false)}`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
                `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : ''}`}>
      <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
        {renderDetailed()}
      </Show>
    </div>
  </>
  );
}


export const Expression_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const expressionItem = () => asExpressionItem(props.visualElement.displayItem);

  return null;
}