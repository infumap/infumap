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
import { isPage } from "../../items/page-item";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { BoundingBox } from "../../util/geometry";

/**
 * A translucent fill, the hue of the toolbar button's border. Outlines were used first, because in the
 * select-then-Add flow the blue selection fill showed on the same items. Clicks now change membership without
 * selecting, so the two rarely meet, and a fill reads better and needs no per-shape fitting.
 */
const COLLECTION_MARK_DIRECT_FILL = "rgba(22, 163, 74, 0.32)";
/** Covered through a member above. */
const COLLECTION_MARK_INHERITED_FILL = "rgba(22, 163, 74, 0.13)";
/**
 * A page box is opaque and dark, with a white title: a translucent fill barely shows on it, and a strong one washes
 * the title out. There the fill recolours instead (`mix-blend-mode: color`): the box takes the green hue and keeps
 * its lightness, so the title stays white. Partly, for an item covered through a member above.
 */
const COLLECTION_MARK_PAGE_BOX_HUE = "rgb(22, 163, 74)";
const COLLECTION_MARK_DIRECT_PAGE_BOX_OPACITY = 1;
const COLLECTION_MARK_INHERITED_PAGE_BOX_OPACITY = 0.5;

/** A page drawn as a box, without its children (Page_Opaque). */
function isPageBox(ve: VisualElement): boolean {
  return isPage(ve.displayItem) && !(ve.flags & VisualElementFlags.LineItem) &&
    !(ve.flags & VisualElementFlags.EmbeddedInteractiveRoot) &&
    (!(ve.flags & VisualElementFlags.Detailed) || !(ve.flags & VisualElementFlags.ShowChildren));
}

/** Roots and chrome are where the user is, not items in it, and a moving item is drawn by the drag. */
const UNMARKED_FLAGS = VisualElementFlags.TopLevelRoot | VisualElementFlags.Popup | VisualElementFlags.UmbrellaPage |
  VisualElementFlags.IsDock | VisualElementFlags.IsTrash | VisualElementFlags.ListPageRoot |
  VisualElementFlags.Moving | VisualElementFlags.Preview;

export function collectionMarkable(visualElement: VisualElement): boolean {
  return (visualElement.flags & UNMARKED_FLAGS) == 0;
}

/**
 * Whether an item shown inside ve (a page, table, composite or the item an attachment hangs on) is already under a
 * fill. Translucent fills stack, so an item covered only through such a container is left unfilled: the container's
 * fill is over it already.
 */
function insideFilledItem(ve: VisualElement): boolean {
  let path = ve.parentPath;
  while (path != null) {
    const ancestor = VesCache.current.readNode(path);
    if (ancestor == null || !collectionMarkable(ancestor)) { return false; }
    if (collectionMark(ancestor.displayItem.id) != null) { return true; }
    path = ancestor.parentPath;
  }
  return false;
}

/**
 * A fill over an item showing how the collection being curated covers it. Drawn by the visual element dispatchers as
 * a sibling of the item, at its bounds, so every kind of item is marked the same way. Purely visual, with no hit
 * target.
 */
export function CollectionMark(props: { visualElement: VisualElement, boundsPx: BoundingBox, lineItem: boolean }) {
  const itemId = () => props.visualElement.displayItem.id;
  createEffect(() => {
    const release = retainCollectionMark(itemId());
    onCleanup(release);
  });
  /** The fill's CSS, or null for none. */
  const fill = () => {
    const mark = collectionMark(itemId());
    if (mark == null) { return null; }
    const direct = mark.kind == "direct";
    if (!direct && insideFilledItem(props.visualElement)) { return null; }
    if (isPageBox(props.visualElement)) {
      const opacity = direct ? COLLECTION_MARK_DIRECT_PAGE_BOX_OPACITY : COLLECTION_MARK_INHERITED_PAGE_BOX_OPACITY;
      return `background-color: ${COLLECTION_MARK_PAGE_BOX_HUE}; mix-blend-mode: color; opacity: ${opacity};`;
    }
    return `background-color: ${direct ? COLLECTION_MARK_DIRECT_FILL : COLLECTION_MARK_INHERITED_FILL};`;
  };
  return (
    <Show when={fill()}>{fill =>
      <div class={`absolute pointer-events-none ${props.lineItem ? "" : "rounded-item"}`}
        style={`left: ${props.boundsPx.x}px; top: ${props.boundsPx.y}px; ` +
          `width: ${props.boundsPx.w}px; height: ${props.boundsPx.h}px; ` +
          fill() +
          // The item's own stacking level: drawn after it in the same parent, so above it, and below anything
          // stacked over it.
          (props.lineItem ? "" : VeFns.zIndexStyle(props.visualElement))} />
    }</Show>
  );
}
