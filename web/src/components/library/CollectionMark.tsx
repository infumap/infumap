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

import { Show, createEffect, onCleanup } from "solid-js";
import { collectionMark, retainCollectionMark } from "../../items/collection-marks";
import { VeFns, VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { BoundingBox } from "../../util/geometry";

/** Direct members: the colour of the collection-mode bar. Green is the hue furthest from the blue selection. */
export const COLLECTION_MARK_DIRECT_COLOR = "#16a34a";
/** Covered through a member above. */
export const COLLECTION_MARK_INHERITED_COLOR = "#86efac";
const COLLECTION_MARK_WIDTH_PX = 2;

/**
 * Around a desktop item, outside it with a white gap: inside, it collided with the focus ring (inset at the same edge)
 * and could not be seen on a green page. A row's neighbours touch it, so a line item's mark stays inside.
 */
function markBoxShadow(color: string, lineItem: boolean): string {
  return lineItem
    ? `inset 0 0 0 ${COLLECTION_MARK_WIDTH_PX}px ${color}`
    : `0 0 0 1px #ffffff, 0 0 0 ${COLLECTION_MARK_WIDTH_PX + 1}px ${color}`;
}

/** Roots and chrome are where the user is, not items in it, and a moving item is drawn by the drag. */
const UNMARKED_FLAGS = VisualElementFlags.TopLevelRoot | VisualElementFlags.Popup | VisualElementFlags.UmbrellaPage |
  VisualElementFlags.IsDock | VisualElementFlags.IsTrash | VisualElementFlags.ListPageRoot |
  VisualElementFlags.Moving | VisualElementFlags.Preview;

export function collectionMarkable(visualElement: VisualElement): boolean {
  return (visualElement.flags & UNMARKED_FLAGS) == 0;
}

/**
 * An outline over an item showing how the collection being curated covers it. Drawn by the visual element
 * dispatchers as a sibling of the item, at its bounds, so every kind of item is marked the same way. An outline,
 * never a fill: the item selection is a blue fill and both can show on the same item. Purely visual, with no hit
 * target.
 */
export function CollectionMark(props: { visualElement: VisualElement, boundsPx: BoundingBox, lineItem: boolean }) {
  const itemId = () => props.visualElement.displayItem.id;
  createEffect(() => {
    const release = retainCollectionMark(itemId());
    onCleanup(release);
  });
  const color = () => {
    const mark = collectionMark(itemId());
    return mark == null ? null : mark.kind == "direct" ? COLLECTION_MARK_DIRECT_COLOR : COLLECTION_MARK_INHERITED_COLOR;
  };
  return (
    <Show when={color()}>{color =>
      <div class={`absolute pointer-events-none ${props.lineItem ? "" : "rounded-item"}`}
        style={`left: ${props.boundsPx.x}px; top: ${props.boundsPx.y}px; ` +
          `width: ${props.boundsPx.w}px; height: ${props.boundsPx.h}px; ` +
          `box-shadow: ${markBoxShadow(color(), props.lineItem)};` +
          // The item's own stacking level: drawn after it in the same parent, so above it, and below anything
          // stacked over it.
          (props.lineItem ? "" : VeFns.zIndexStyle(props.visualElement))} />
    }</Show>
  );
}
