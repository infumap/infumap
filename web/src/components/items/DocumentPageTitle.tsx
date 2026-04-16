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
import { LINE_HEIGHT_PX, NOTE_PADDING_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../../constants";
import { PageFns } from "../../items/page-item";
import { VeFns } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { PageVisualElementProps } from "./Page";
import { createPageTitleEditHandlers } from "./helper";


export const DocumentPageTitle: Component<PageVisualElementProps & { allowEditing?: boolean }> = (props) => {
  const store = useStore();

  const pageFns = () => props.pageFns;
  const allowEditing = () => !!props.allowEditing;
  const titleEditHandlers = createPageTitleEditHandlers(store, () => props.visualElement);

  const documentScale = () => {
    const totalWidthBl = pageFns().pageItem().docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
    return totalWidthBl > 0 ? pageFns().childAreaBoundsPx().w / (totalWidthBl * LINE_HEIGHT_PX) : 1.0;
  };

  const documentTextColumnLeftPx = () =>
    PAGE_DOCUMENT_LEFT_MARGIN_BL * LINE_HEIGHT_PX * documentScale();

  const documentBlockWidthPx = () =>
    Math.max(
      pageFns().pageItem().docWidthBl * LINE_HEIGHT_PX * documentScale(),
      1,
    );

  const naturalTextWidthPx = () =>
    Math.max(
      pageFns().pageItem().docWidthBl * LINE_HEIGHT_PX - (NOTE_PADDING_PX * 2),
      1,
    );

  const titleStyle = () => PageFns.documentTitleStyle();
  const textBlockScale = () =>
    Math.max((documentBlockWidthPx() - NOTE_PADDING_PX * 2) / naturalTextWidthPx(), 0);

  const titleHeightPx = () => PageFns.calcDocumentTitleHeightBl(pageFns().pageItem()) * LINE_HEIGHT_PX * documentScale();

  const handleTitleClick = (ev: MouseEvent) => {
    if (!allowEditing() || titleEditHandlers.isEditingTitle() || ev.button !== 0) { return; }
    PageFns.handleEditTitleClick(props.visualElement, store, { x: ev.clientX, y: ev.clientY });
  };

  return (
    <div class="absolute"
      style={`left: ${documentTextColumnLeftPx()}px; ` +
        `top: ${PAGE_DOCUMENT_TOP_MARGIN_PX * documentScale()}px; ` +
        `width: ${documentBlockWidthPx()}px; height: ${titleHeightPx()}px;`}>
      <span id={VeFns.veToPath(props.visualElement) + ":title"}
        class={`absolute block font-bold cursor-text ${titleStyle().alignClass}`}
        style={`left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
          `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
          `width: ${naturalTextWidthPx()}px; ` +
          `line-height: ${LINE_HEIGHT_PX * titleStyle().lineHeightMultiplier}px; ` +
          `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
          `font-size: ${titleStyle().fontSize}px; ` +
          `overflow-wrap: break-word; white-space: pre-wrap; ` +
          `outline: 0px solid transparent;`}
        spellcheck={allowEditing() && titleEditHandlers.isEditingTitle()}
        contentEditable={allowEditing() && titleEditHandlers.isEditingTitle()}
        onClick={allowEditing() ? handleTitleClick : undefined}
        onKeyDown={allowEditing() ? titleEditHandlers.titleKeyDownHandler : undefined}
        onKeyUp={allowEditing() ? titleEditHandlers.titleKeyUpHandler : undefined}
        onInput={allowEditing() ? titleEditHandlers.titleInputListener : undefined}>
        {pageFns().pageItem().title}
      </span>
    </div>
  );
}
