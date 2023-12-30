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
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { ExpressionFns, asExpressionItem } from "../../items/expression-item";
import { TableFns, asTableItem } from "../../items/table-item";
import { getTextStyleForNote, measureLineCount } from "../../layout/text";
import { NoteFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asPageItem, isPage } from "../../items/page-item";
import { FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { server } from "../../server";
import { arrange } from "../../layout/arrange";


const expressionVisualElement = (store: StoreContextModel) => VesCache.get(store.overlay.expressionEditOverlayInfo.get()!.itemPath)!.get();
const expressionItem = (store: StoreContextModel) => asExpressionItem(expressionVisualElement(store).displayItem);


export const ExpressionEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLTextAreaElement | undefined;

  const expressionVeBoundsPx = () => {
    const r = VeFns.veBoundsRelativeToDestkopPx(store, expressionVisualElement(store));
    r.y += store.topToolbarHeight();
    return r;
  }
  const editBoxBoundsPx = () => {
    if (expressionVisualElement(store)!.flags & VisualElementFlags.InsideTable) {
      const sBl = sizeBl();
      const nbPx = expressionVeBoundsPx();
      return ({
        x: nbPx.x, y: nbPx.y,
        w: nbPx.w, h: nbPx.h * sBl.h,
      });
    }
    return expressionVeBoundsPx();
  };
  const expressionItemOnInitialize = expressionItem(store);

  const sizeBl = () => {
    const expressionVe = expressionVisualElement(store)!;
    if (expressionVe.flags & VisualElementFlags.InsideTable) {
      let tableVe;
      if (expressionVe.col == 0) {
        tableVe = VesCache.get(expressionVe.parentPath!)!.get();
      } else {
        const itemVe = VesCache.get(expressionVisualElement(store).parentPath!)!.get();
        tableVe = VesCache.get(itemVe.parentPath!)!.get();
      }
      const tableItem = asTableItem(tableVe.displayItem);
      const widthBl = TableFns.columnWidthBl(tableItem, expressionVe.col!);
      let lineCount = measureLineCount(expressionItem(store).title, widthBl, NoteFlags.None);
      if (lineCount < 1) { lineCount = 1; }
      return ({ w: widthBl, h: lineCount });
    }

    if (expressionVe.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = ExpressionFns.asExpressionMeasurable(ItemFns.cloneMeasurableFields(expressionVisualElement(store).displayItem));
      const canonicalItem = VeFns.canonicalItem(VesCache.get(expressionVisualElement(store).parentPath!)!.get());
      if (isPage(canonicalItem)) {
        cloned.spatialWidthGr = asPageItem(canonicalItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(canonicalItem).spatialWidthGr;
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }

    if (expressionVe.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(expressionVisualElement(store).linkItemMaybe!);
    }

    return ExpressionFns.calcSpatialDimensionsBl(expressionItem(store));
  };

  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (editBoxBoundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (editBoxBoundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const HACK_ADJUST_TEXTAREA_HEIGHT = 2.5;

  const style = () => getTextStyleForNote(NoteFlags.None);

  const textAreaMouseDownHandler = async (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.user.getUserMaybe() != null && expressionItemOnInitialize.ownerId == store.user.getUser().userId) {
        server.updateItem(expressionItem(store));
        store.overlay.expressionEditOverlayInfo.set(null);
      }
    }
  };

  const textAreaOnInputHandler = () => {
    expressionItem(store).title = textElement!.value;
    arrange(store);
  };

  return (
    <div class={`absolute rounded border`}
         style={`left: ${expressionVeBoundsPx().x}px; top: ${expressionVeBoundsPx().y}px; width: ${expressionVeBoundsPx().w}px; height: ${expressionVeBoundsPx().h}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY}`}>
      <textarea ref={textElement}
                class={`rounded overflow-hidden resize-none whitespace-pre-wrap`}
                style={`position: absolute; ` +
                        `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                        `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4) * textBlockScale()}px; ` +
                        `width: ${naturalWidthPx()}px; ` +
                        `height: ${naturalHeightPx() * heightScale()/widthScale() + HACK_ADJUST_TEXTAREA_HEIGHT * 1}px;` +
                        `font-size: ${style().fontSize}px; ` +
                        `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
                        `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                        `overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;`}
                value={expressionItem(store).title}
                disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != expressionItem(store).ownerId}
                onMouseDown={textAreaMouseDownHandler}
                onInput={textAreaOnInputHandler} />
    </div>
  );
}
