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
import { MembershipChange, changeCollectionMembers, toggleCollectionMember } from "../items/collection-mode";
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
import { resolvedPathTargetIdForItem } from "../util/item-path";
import { IS_MAC } from "../util/platform";
import { Uid, isUid } from "../util/uid";
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
  const current = store.overlay.selectedVeids.get();
  const ve = selectableVeMaybe(hitVe, compositeVe => selectionIsInComposite(current, compositeVe));
  if (ve == null) { return false; }
  const containerVe = VesCache.current.readNode(ve.parentPath!)!;
  const ordered = childrenAreOrdered(containerVe)!;
  const siblings = ordered ? orderedChildVeids(containerVe) : [];
  const clickedVeid = VeFns.veidFromVe(ve);
  if (ordered && indexOfVeid(siblings, clickedVeid) < 0) { return false; }

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
 * The shift-click anchor in collection mode: the item last clicked with a modifier, and what that click did to it.
 * Shift-click does the same to every item from there to the one clicked, as shift-clicking checkboxes does in mail
 * clients. There is no selection to keep it in step with, so it lasts until the next modifier click.
 */
let collectionAnchor: { veid: Veid, containerId: Uid, change: MembershipChange } | null = null;

/**
 * A click with a selection modifier, in collection mode: toggles the clicked item's membership instead of selecting it.
 * Shift-click in an ordered container applies the last click's change to the range from that item. Returns false if
 * nothing there can be selected, and the click should be handled as one without the modifier.
 *
 * The item is the one under the pointer, a composite's member included: a sweep (the marquee) toggles the whole
 * composite. With no selection to show, the click-twice drill-in of applySelectionClick would depend on clicks the
 * user can no longer see.
 */
export function applyCollectionClick(store: StoreContextModel, hitVe: VisualElement, selectionClick: SelectionClick): boolean {
  // An attachment, such as a table's second and later columns, can't be selected: a selection is of siblings, for a
  // group move. Membership has no such need, so in the mode an attachment toggles on its own, with no range.
  if (VeFns.treeItem(hitVe).relationshipToParent == RelationshipToParent.Attachment) {
    if ((hitVe.flags & VisualElementFlags.Popup) || isPlaceholder(hitVe.displayItem) || !isUid(hitVe.displayItem.id)) {
      return false;
    }
    collectionAnchor = null;
    toggleCollectionMember(store, hitVe.displayItem.id);
    return true;
  }
  const ve = selectableVeMaybe(hitVe, () => true);
  if (ve == null || !isUid(ve.displayItem.id)) { return false; }
  const containerVe = VesCache.current.readNode(ve.parentPath!)!;
  const containerId = containerVe.displayItem.id;
  const clickedVeid = VeFns.veidFromVe(ve);

  if (selectionClick == "range" && childrenAreOrdered(containerVe) && collectionAnchor?.containerId == containerId) {
    const siblings = orderedChildVeids(containerVe);
    const anchorIdx = indexOfVeid(siblings, collectionAnchor.veid);
    const clickedIdx = indexOfVeid(siblings, clickedVeid);
    if (anchorIdx >= 0 && clickedIdx >= 0) {
      // A row not rendered has a veid of the child itself, which for a link is the link, not the item it shows.
      const ids = siblings.slice(Math.min(anchorIdx, clickedIdx), Math.max(anchorIdx, clickedIdx) + 1)
        .map(veid => { const item = itemState.get(veid.itemId); return item == null ? veid.itemId : resolvedPathTargetIdForItem(item); })
        .filter(isUid);
      changeCollectionMembers(store, collectionAnchor.change, ids);
      collectionAnchor = { veid: clickedVeid, containerId, change: collectionAnchor.change };
      return true;
    }
  }
  collectionAnchor = { veid: clickedVeid, containerId, change: toggleCollectionMember(store, ve.displayItem.id) };
  return true;
}


/**
 * What a click on hitVe selects, following the marquee: a composite for any of its children, and otherwise only a
 * child of a page or table, not an attachment, popup or page background. An embedded interactive page is a root of
 * its own children, but selected as an item of the page it is in.
 *
 * A composite's member is selected instead when selectsMember says so for the composite. Outside collection mode,
 * that is once the selection is in that composite: the composite alone, or some of its members. So a first click
 * picks the composite, as on any page, and a second drills in to the member. Members could not be selected at all
 * before, which kept a single note in a composite out of a collection.
 */
function selectableVeMaybe(hitVe: VisualElement, selectsMember: (compositeVe: VisualElement) => boolean): VisualElement | null {
  let ve = hitVe;
  if ((ve.flags & VisualElementFlags.InsideCompositeOrDoc) && ve.parentPath != null) {
    const parentVe = VesCache.current.readNode(ve.parentPath);
    if (parentVe != null && isComposite(parentVe.displayItem) && !selectsMember(parentVe)) {
      ve = parentVe;
    }
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

/** The composite selected on its own, or members of it: a click on one of its members then selects the member. */
function selectionIsInComposite(current: Array<Veid>, compositeVe: VisualElement): boolean {
  if (current.length == 0) { return false; }
  const compositeVeid = VeFns.veidFromVe(compositeVe);
  if (current.length == 1 && VeFns.compareVeids(current[0], compositeVeid) == 0) { return true; }
  const compositeId = compositeVe.displayItem.id;
  return current.every(veid => itemState.get(veid.linkIdMaybe ?? veid.itemId)?.parentId == compositeId);
}

/**
 * Whether the children of containerVe are shown in an order a range can be taken from, or null if they can't be
 * selected by clicking. A composite's members are stacked in order. A calendar page places items by date, so, as on
 * a free-form page, shift-click adds or removes the item rather than taking a range. The marquee still leaves
 * calendar pages out.
 */
function childrenAreOrdered(containerVe: VisualElement): boolean | null {
  if (isTable(containerVe.displayItem) || isComposite(containerVe.displayItem)) { return true; }
  const arrangeAlgorithm = pageArrangeAlgorithmMaybe(containerVe);
  if (arrangeAlgorithm == null) { return null; }
  return arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch && arrangeAlgorithm != ArrangeAlgorithm.Calendar;
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
