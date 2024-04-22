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

import { Component, onMount } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { TableFns, asTableItem } from "../../items/table-item";
import { getTextStyleForNote, measureLineCount } from "../../layout/text";
import { NoteFlags } from "../../items/base/flags-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asPageItem, isPage } from "../../items/page-item";
import { FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { serverOrRemote } from "../../server";
import { rearrangeWithDisplayId } from "../../layout/arrange";
import { PasswordFns, asPasswordItem } from "../../items/password-item";


const passwordVisualElement = (store: StoreContextModel) => VesCache.get(store.overlay.passwordEditOverlayInfo()!.itemPath)!.get();
const passwordItem = (store: StoreContextModel) => asPasswordItem(passwordVisualElement(store).displayItem);


export const PasswordEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLTextAreaElement | undefined;

  const passwordVeBoundsPx = () => {
    const r = VeFns.veBoundsRelativeToDestkopPx(store, passwordVisualElement(store));
    r.y += store.topToolbarHeight();
    return r;
  }
  const editBoxBoundsPx = () => {
    if (passwordVisualElement(store)!.flags & VisualElementFlags.InsideTable) {
      const sBl = sizeBl();
      const nbPx = passwordVeBoundsPx();
      return ({
        x: nbPx.x, y: nbPx.y,
        w: nbPx.w, h: nbPx.h * sBl.h,
      });
    }
    return passwordVeBoundsPx();
  };
  const passwordItemOnInitialize = passwordItem(store);

  const sizeBl = () => {
    const passwordVe = passwordVisualElement(store)!;
    if (passwordVe.flags & VisualElementFlags.InsideTable) {
      let tableVe;
      if (passwordVe.col == 0) {
        tableVe = VesCache.get(passwordVe.parentPath!)!.get();
      } else {
        const itemVe = VesCache.get(passwordVisualElement(store).parentPath!)!.get();
        tableVe = VesCache.get(itemVe.parentPath!)!.get();
      }
      const tableItem = asTableItem(tableVe.displayItem);
      const widthBl = TableFns.columnWidthBl(tableItem, passwordVe.col!);
      let lineCount = measureLineCount(passwordItem(store).text, widthBl, NoteFlags.None);
      if (lineCount < 1) { lineCount = 1; }
      return ({ w: widthBl, h: lineCount });
    }

    if (passwordVe.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = PasswordFns.asPasswordMeasurable(ItemFns.cloneMeasurableFields(passwordVisualElement(store).displayItem));
      const canonicalItem = VeFns.canonicalItem(VesCache.get(passwordVisualElement(store).parentPath!)!.get());
      if (isPage(canonicalItem)) {
        cloned.spatialWidthGr = asPageItem(canonicalItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(canonicalItem).spatialWidthGr;
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }

    if (passwordVe.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(passwordVisualElement(store).linkItemMaybe!);
    }

    return PasswordFns.calcSpatialDimensionsBl(passwordItem(store));
  };

  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (editBoxBoundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (editBoxBoundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const HACK_ADJUST_TEXTAREA_HEIGHT = 2.5;

  const style = () => getTextStyleForNote(NoteFlags.None);

  onMount(() => {
    textElement!.focus();
  });

  const textAreaMouseDownHandler = async (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.user.getUserMaybe() != null && passwordItemOnInitialize.ownerId == store.user.getUser().userId) {
        serverOrRemote.updateItem(passwordItem(store));
        store.overlay.setPasswordEditOverlayInfo(store.history, null);
      }
    }
  };

  const textAreaOnInputHandler = () => {
    passwordItem(store).text = textElement!.value;
    rearrangeWithDisplayId(store, passwordItem(store).id);
  };

  return (
    <div class={`absolute rounded border`}
         style={`left: ${passwordVeBoundsPx().x}px; top: ${passwordVeBoundsPx().y}px; width: ${passwordVeBoundsPx().w}px; height: ${passwordVeBoundsPx().h}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY}`}>
      <textarea ref={textElement}
                class={`overflow-hidden whitespace-pre-wrap`}
                style={`position: absolute; ` +
                       `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4) * textBlockScale()}px; ` +
                       `width: ${naturalWidthPx()}px; ` +
                       `height: ${naturalHeightPx() * heightScale()/widthScale() + HACK_ADJUST_TEXTAREA_HEIGHT * 1}px;` +
                       `font-size: ${style().fontSize}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                       `overflow-wrap: break-word; resize: none; padding: 0;`}
                value={passwordItem(store).text}
                disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != passwordItem(store).ownerId}
                onMouseDown={textAreaMouseDownHandler}
                onInput={textAreaOnInputHandler} />
    </div>
  );
}
