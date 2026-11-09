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

import { asContainerItem } from "../items/base/container-item";
import { isComposite } from "../items/composite-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { isPlaceholder } from "../items/placeholder-item";
import { isTable } from "../items/table-item";
import { arrangeNow } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags, isEmptyVeid, veFlagIsRoot } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { IS_MAC } from "../util/platform";
import { Uid } from "../util/uid";
import { CursorEventState, SelectionClick } from "./state";


/**
 * The anchor of shift-click ranges: the item last clicked with a selection modifier, and the selection that click
 * left. Anything else that changes the selection (a marquee, shift + up/down, Escape, a plain click) sets a new array,
 * so the anchor is stale once the selection is no longer that same array.
 */
let anchor: { veid: Veid, selection: Array<Veid> } | null = null;


/**
 * The selection change a click makes with the modifiers held now: Cmd (Ctrl off a Mac) adds or removes the clicked
 * item, and Shift selects the range from the anchor to it.
 */
export function selectionClickFromModifiers(): SelectionClick | null {
  const state = CursorEventState.get();
  if (IS_MAC ? state.metaDown : state.ctrlDown) { return "toggle"; }
  if (state.shiftDown) { return "range"; }
  return null;
}

/** Whether ve is one of the selected items. */
export function veIsSelected(store: StoreContextModel, ve: VisualElement): boolean {
  return indexOfVeid(store.overlay.selectedVeids.get(), VeFns.veidFromVe(ve)) >= 0;
}

/**
 * Change the selection for a click on hitVe made with a selection modifier held. Returns false if nothing there can be
 * selected, and the click should be handled as one without the modifier.
 *
 * A selection is only ever of children of one container, as a group move takes its items from a single parent, so a
 * click in another container starts a new selection there.
 */
export function applySelectionClick(store: StoreContextModel, hitVe: VisualElement, selectionClick: SelectionClick): boolean {
  const ve = selectableVeMaybe(hitVe);
  if (ve == null) { return false; }
  const containerVe = VesCache.current.readNode(ve.parentPath!)!;
  const ordered = childrenAreOrdered(containerVe)!;
  const siblings = ordered ? orderedChildVeids(containerVe) : [];
  const clickedVeid = VeFns.veidFromVe(ve);
  if (ordered && indexOfVeid(siblings, clickedVeid) < 0) { return false; }

  const current = store.overlay.selectedVeids.get();
  const containerId = containerVe.displayItem.id;
  const sameContainer = current.length > 0 &&
    current.every(veid => itemState.get(veid.linkIdMaybe ?? veid.itemId)?.parentId == containerId);
  // The row a list page shows is drawn as selected, so the selection starts with it, as it would in other systems.
  const start = sameContainer ? current : listPageCursorVeids(store, containerVe, siblings);

  let next: Array<Veid>;
  let anchorVeid = clickedVeid;
  // A range of items in a free-form page means nothing, so shift-click adds or removes the item there, as in Finder.
  if (selectionClick == "toggle" || !ordered) {
    next = indexOfVeid(start, clickedVeid) >= 0
      ? start.filter(veid => VeFns.compareVeids(veid, clickedVeid) != 0)
      : [...start, clickedVeid];
    // Rows are moved in the order they are selected in (see stackedGroupMoveStartPositionsGr).
    if (ordered) { next = siblings.filter(veid => indexOfVeid(next, veid) >= 0); }
  } else {
    const clickedIdx = indexOfVeid(siblings, clickedVeid);
    let anchorIdx = anchor != null && anchor.selection === current ? indexOfVeid(siblings, anchor.veid) : -1;
    if (anchorIdx < 0 && start.length > 0) {
      // A selection made some other way has no anchor: extend it to the clicked item, from its far end.
      const startIndices = start.map(veid => indexOfVeid(siblings, veid)).filter(idx => idx >= 0);
      const first = Math.min(...startIndices);
      const last = Math.max(...startIndices);
      anchorIdx = Math.abs(clickedIdx - first) >= Math.abs(clickedIdx - last) ? first : last;
    }
    if (anchorIdx < 0) { anchorIdx = clickedIdx; }
    anchorVeid = siblings[anchorIdx];
    next = siblings.slice(Math.min(anchorIdx, clickedIdx), Math.max(anchorIdx, clickedIdx) + 1);
  }

  store.overlay.selectedVeids.set(next);
  store.overlay.selectionRootPath.set(ve.parentPath!);
  anchor = { veid: anchorVeid, selection: next };
  arrangeNow(store, "mouse-up-selection-click");
  return true;
}


/**
 * What a click on hitVe selects, following the marquee: a composite for any of its children, and otherwise only a
 * child of a page or table, not an attachment, popup or page background. An embedded interactive page is a root of
 * its own children, but selected as an item of the page it is in.
 */
function selectableVeMaybe(hitVe: VisualElement): VisualElement | null {
  let ve = hitVe;
  if ((ve.flags & VisualElementFlags.InsideCompositeOrDoc) && ve.parentPath != null) {
    const parentVe = VesCache.current.readNode(ve.parentPath);
    if (parentVe != null && isComposite(parentVe.displayItem)) { ve = parentVe; }
  }
  if (ve.parentPath == null || (ve.flags & VisualElementFlags.Popup) || isPlaceholder(ve.displayItem)) { return null; }
  if (veFlagIsRoot(ve.flags) && !(ve.flags & VisualElementFlags.EmbeddedInteractiveRoot)) { return null; }
  const containerVe = VesCache.current.readNode(ve.parentPath);
  if (containerVe == null || childrenAreOrdered(containerVe) == null) { return null; }
  const treeItem = VeFns.treeItem(ve);
  if (treeItem.relationshipToParent != RelationshipToParent.Child || treeItem.parentId != containerVe.displayItem.id) {
    return null;
  }
  return ve;
}

/**
 * Whether the children of containerVe are shown in an order a range can be taken from, or null if they can't be
 * selected by clicking. Calendar pages are left out, as they are by the marquee.
 */
function childrenAreOrdered(containerVe: VisualElement): boolean | null {
  if (isTable(containerVe.displayItem)) { return true; }
  const arrangeAlgorithm = pageArrangeAlgorithmMaybe(containerVe);
  if (arrangeAlgorithm == null || arrangeAlgorithm == ArrangeAlgorithm.Calendar) { return null; }
  return arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch;
}

function pageArrangeAlgorithmMaybe(ve: VisualElement): string | null {
  if (!isPage(ve.displayItem)) { return null; }
  return ve.linkItemMaybe?.overrideArrangeAlgorithm || asPageItem(ve.displayItem).arrangeAlgorithm;
}

/**
 * The children of containerVe in the order they are shown, which is the order of computed_children in every ordered
 * arrangement. Long lists and tables only render the rows in view, so the others don't have a visual element to take a
 * veid from.
 */
function orderedChildVeids(containerVe: VisualElement): Array<Veid> {
  const renderedVeids = new Map<Uid, Veid>();
  for (const child of VesCache.render.getChildren(VeFns.veToPath(containerVe))()) {
    const childVe = child.get();
    renderedVeids.set(VeFns.treeItem(childVe).id, VeFns.veidFromVe(childVe));
  }
  return asContainerItem(containerVe.displayItem).computed_children
    .filter(id => { const item = itemState.get(id); return item != null && !isPlaceholder(item); })
    .map(id => renderedVeids.get(id) ?? VeFns.veidFromId(id));
}

function listPageCursorVeids(store: StoreContextModel, containerVe: VisualElement, siblings: Array<Veid>): Array<Veid> {
  if (pageArrangeAlgorithmMaybe(containerVe) != ArrangeAlgorithm.List) { return []; }
  const cursorVeid = store.perItem.getSelectedListPageItem(VeFns.actualVeidFromVe(containerVe));
  return !isEmptyVeid(cursorVeid) && indexOfVeid(siblings, cursorVeid) >= 0 ? [cursorVeid] : [];
}

function indexOfVeid(veids: Array<Veid>, veid: Veid): number {
  return veids.findIndex(v => VeFns.compareVeids(v, veid) == 0);
}
