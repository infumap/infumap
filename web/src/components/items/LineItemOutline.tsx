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
import { PADDING_PROP } from "../../constants";
import { ItemIconRenderContext } from "../../items/base/icon-item";
import { Item } from "../../items/base/item";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { CompositeFns, asCompositeItem, isComposite } from "../../items/composite-item";
import { isLink } from "../../items/link-item";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { isPassword } from "../../items/password-item";
import { isQueryItem } from "../../items/query-item";
import { VisualElementFlags } from "../../layout/visual-element";
import { itemState } from "../../store/ItemState";
import { SELECTED_DARK, SELECTED_LIGHT } from "../../style";
import { VisualElementProps } from "../VisualElement";


const OUTLINE_COLOR = "#ddd";

// Approximate average character width of line item text, relative to the row height.
const CHAR_WIDTH_PROP = 0.31;

/**
 * Number of characters of text the line item would show, used to size its outline bar.
 */
function displayedTextLength(item: Item): number {
  if (isComposite(item)) {
    const composite = asCompositeItem(item);
    if (CompositeFns.showTitle(composite)) { return composite.title.length; }
    if (composite.computed_children.length == 0) { return 0; }
    const topItem = itemState.get(composite.computed_children[0]);
    return topItem && isTitledItem(topItem) ? asTitledItem(topItem).title.length : 0;
  }
  if (isTitledItem(item)) { return asTitledItem(item).title.length; }
  if (isQueryItem(item)) { return "Query".length; }
  if (isPassword(item)) { return 8; }
  if (isLink(item)) { return 12; }
  return 0;
}

/**
 * Whether the line item for the item shows text, and so is drawn as an outline when too small for it to be legible.
 * Other line items (e.g. dividers, ratings) remain recognizable when small, so are drawn as normal.
 */
export function lineItemHasTextOutline(item: Item): boolean {
  return isTitledItem(item) || isQueryItem(item) || isPassword(item) || isLink(item);
}

function showsIconBlock(item: Item): boolean {
  if (isNote(item)) { return NoteFns.showsIcon(asNoteItem(item), ItemIconRenderContext.Line); }
  return true;
}

/**
 * A line item too small for its text to be legible, drawn as an icon box and a bar the approximate length of its text.
 * The line item analog of the outlines drawn for children of (non-interactive) spatial and document pages.
 */
export const LineItemOutline: Component<VisualElementProps> = (props: VisualElementProps) => {
  const boundsPx = () => props.visualElement.boundsPx;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx?.w ?? boundsPx().h;
  const hasIconBlock = () => showsIconBlock(props.visualElement.displayItem);
  const iconSizePx = () => boundsPx().h * 0.6;
  const textLeftPx = () => hasIconBlock() ? oneBlockWidthPx() : oneBlockWidthPx() * PADDING_PROP;
  const barHeightPx = () => boundsPx().h * 0.4;
  const barWidthPx = () => Math.min(
    displayedTextLength(props.visualElement.displayItem) * boundsPx().h * CHAR_WIDTH_PROP,
    Math.max(0, boundsPx().w - textLeftPx() - oneBlockWidthPx() * PADDING_PROP));

  return (
    <div class="absolute pointer-events-none"
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px;`}>
      <Show when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
          style={`left: 1px; top: 0px; width: ${Math.max(0, boundsPx().w - 3)}px; height: ${boundsPx().h}px; ` +
            `background-color: ${props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT};`} />
      </Show>
      <Show when={hasIconBlock()}>
        <div class="absolute"
          style={`left: ${(oneBlockWidthPx() - iconSizePx()) / 2}px; top: ${(boundsPx().h - iconSizePx()) / 2}px; ` +
            `width: ${iconSizePx()}px; height: ${iconSizePx()}px; background-color: ${OUTLINE_COLOR};`} />
      </Show>
      <Show when={barWidthPx() > 0}>
        <div class="absolute"
          style={`left: ${textLeftPx()}px; top: ${(boundsPx().h - barHeightPx()) / 2}px; ` +
            `width: ${barWidthPx()}px; height: ${barHeightPx()}px; background-color: ${OUTLINE_COLOR};`} />
      </Show>
    </div>
  );
}
