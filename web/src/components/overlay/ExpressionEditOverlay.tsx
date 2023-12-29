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
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { ExpressionFns, asExpressionItem } from "../../items/expression-item";
import { TableFns, asTableItem } from "../../items/table-item";
import { measureLineCount } from "../../layout/text";
import { NoteFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asPageItem, isPage } from "../../items/page-item";
import { GRID_SIZE, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { asXSizableItem } from "../../items/base/x-sizeable-item";



export const ExpressionEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLTextAreaElement | undefined;

  const expressionVisualElement = () => VesCache.get(store.overlay.expressionEditOverlayInfo.get()!.itemPath)!.get();
  const expressionVeBoundsPx = () => VeFns.veBoundsRelativeToDestkopPx(store, expressionVisualElement());
  const editBoxBoundsPx = () => {
    if (expressionVisualElement()!.flags & VisualElementFlags.InsideTable) {
      const sBl = sizeBl();
      const nbPx = expressionVeBoundsPx();
      return ({
        x: nbPx.x, y: nbPx.y,
        w: nbPx.w, h: nbPx.h * sBl.h,
      });
    }
    return expressionVeBoundsPx();
  };
  const expressionItem = () => asExpressionItem(expressionVisualElement().displayItem);
  const expressionItemOnInitialize = expressionItem();

  const sizeBl = () => {
    const noteVe = expressionVisualElement()!;
    if (noteVe.flags & VisualElementFlags.InsideTable) {
      let tableVe;
      if (noteVe.col == 0) {
        tableVe = VesCache.get(noteVe.parentPath!)!.get();
      } else {
        const itemVe = VesCache.get(expressionVisualElement().parentPath!)!.get();
        tableVe = VesCache.get(itemVe.parentPath!)!.get();
      }
      const tableItem = asTableItem(tableVe.displayItem);
      const widthBl = TableFns.columnWidthBl(tableItem, noteVe.col!);
      let lineCount = measureLineCount(expressionItem().title, widthBl, NoteFlags.None);
      if (lineCount < 1) { lineCount = 1; }
      return ({ w: widthBl, h: lineCount });
    }

    if (noteVe.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = ExpressionFns.asExpressionMeasurable(ItemFns.cloneMeasurableFields(expressionVisualElement().displayItem));
      const canonicalItem = VeFns.canonicalItem(VesCache.get(expressionVisualElement().parentPath!)!.get());
      if (isPage(canonicalItem)) {
        cloned.spatialWidthGr = asPageItem(canonicalItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(canonicalItem).spatialWidthGr;
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }

    if (noteVe.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(expressionVisualElement().linkItemMaybe!);
    }

    return ExpressionFns.calcSpatialDimensionsBl(expressionItem());
  };

  return (
    <div></div>
    // <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
    //      style={`background-color: #00000000; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
    //      onmousedown={mouseDownListener}
    //      onmousemove={mouseMoveListener}
    //      onmouseup={mouseUpListener}
    //      onKeyDown={keyDownListener}>
    //   <div class={`absolute rounded border`}
    //        style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
    //     <textarea ref={textElement}
    //               class={`rounded overflow-hidden resize-none whitespace-pre-wrap ${style().isCode ? 'font-mono' : ''} ${style().alignClass}`}
    //               style={`position: absolute; ` +
    //                       `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
    //                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4) * textBlockScale()}px; ` +
    //                       `width: ${naturalWidthPx()}px; ` +
    //                       `height: ${naturalHeightPx() * heightScale()/widthScale() + HACK_ADJUST_TEXTAREA_HEIGHT * style().lineHeightMultiplier}px;` +
    //                       `font-size: ${style().fontSize}px; ` +
    //                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * style().lineHeightMultiplier}px; ` +
    //                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
    //                       `overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;` +
    //                       `${style().isBold ? ' font-weight: bold; ' : ""}`}
    //               value={noteItem().title}
    //               disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != noteItem().ownerId}
    //               onMouseDown={textAreaMouseDownHandler}
    //               onInput={textAreaOnInputHandler} />
    //   </div>
    //   </div>
  )
}