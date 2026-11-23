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

import { GRID_SIZE, LINE_HEIGHT_PX } from "../constants";
import { asAttachmentsItem, attachmentAnchorRightPxForVe, attachmentBlockSizePxForVe, calcSpatialAttachmentInsertIndex, isAttachmentsItem } from "../items/base/attachments-item";
import { itemCanCopy, itemCanEditChildren, itemCanMove } from "../items/base/capabilities-item";
import { itemCanAcceptManualChildren } from "../items/base/flags-item";
import type { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { GroupFns } from "../items/base/group-item";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { asFileItem, isFile } from "../items/file-item";
import { asTextItem, isChatAttachmentItem, isText, type TextItem } from "../items/text-item";
import { createQueryChatTurnMarkdownItem } from "../items/chat-turn-markdown";
import { queryChatCompletedActivityPlacementForComposite } from "../items/query-chat-activity-ui";
import { createPendingTextDocumentPage, isMarkdownTextDocumentPage } from "../items/text-document";
import { LinkFns, isLink } from "../items/link-item";
import { asNoteItem, isNote } from "../items/note-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PlaceholderFns } from "../items/placeholder-item";
import { calculateCalendarPosition, encodeCalendarCombinedIndex, moveCalendarDateTimeRangeToStart } from "../util/calendar-layout";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { arrangeNow } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, isTableView } from "../layout/visual-element";
import { server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { Vector, compareVector, getBoundingBoxTopLeft, vectorAdd, vectorSubtract } from "../util/geometry";
import { assert, currentUnixTimeSeconds, panic } from "../util/lang";
import { HitInfoFns } from "./hit";
import { dockListPageIconMoveTargetMaybe, moveTargetWouldCreateRelationshipCycle, resolveInternalMoveTarget, resolveMoveTargetPageVe } from "./move_target";
import { CursorEventState, ItemCopyMoveState, MouseAction, MouseActionState, itemCopyMovePendingIds } from "./state";
import { ReadOnlyDocumentHandlePress } from "./document_move_out";
import { veIsSelected } from "./click_selection";
import { dockInsertIndexAndPositionFromDockChildAreaY, getDockScrollYPx } from "../layout/arrange/dock";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { newUid } from "../util/uid";
import { isDataItem } from "../items/base/data-item";
import { justifiedInsertionFromDesktopPx } from "../layout/justified-insertion";
import { gridInsertionIndexFromDesktopPx } from "../layout/grid-insertion";
import { stackedInsertionIndexFromDesktopPx } from "../layout/stacked-insertion";
import { catalogInsertionIndexFromDesktopPx } from "../layout/catalog-display";
import { GroupMoveItem, calculateMoveToPagePositionGr, moveGroupToChildParentPreservingOffsets, movingHitIgnoreIds, stackedGroupMoveStartPositionsGr } from "./move_group";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../layout/arrange/page_list";




function captureMoveRollbackSnapshot(store: StoreContextModel, activeVisualElement: VisualElement, activeItem: PositionalItem) {
  const activeVeid = VeFns.veidFromVe(activeVisualElement);
  const selected = store.overlay.selectedVeids.get();
  const activeSelected = selected?.some(v => (
    v.itemId === activeVeid.itemId && v.linkIdMaybe === activeVeid.linkIdMaybe
  )) ?? false;

  const itemIds = activeSelected && selected != null
    ? selected.map(v => v.linkIdMaybe ? v.linkIdMaybe : v.itemId)
    : [activeItem.id];

  const seen = new Set<string>();
  const snapshot = itemIds
    .map(id => itemState.get(id))
    .filter((item): item is PositionalItem => item != null && isPositionalItem(item))
    .filter(item => {
      if (seen.has(item.id)) { return false; }
      seen.add(item.id);
      return true;
    })
    .map(item => ({
      id: item.id,
      parentId: item.parentId,
      relationshipToParent: item.relationshipToParent,
      ordering: new Uint8Array(item.ordering),
      spatialPositionGr: { ...item.spatialPositionGr },
      dateTime: item.dateTime,
      endDateTime: item.endDateTime,
      groupId: item.groupId,
      pinnedTo: item.pinnedTo,
      rollbackFlags: isNote(item)
        ? asNoteItem(item).flags
        : isFile(item)
          ? asFileItem(item).flags
          : isText(item)
            ? asTextItem(item).flags
            : isPassword(item)
              ? asPasswordItem(item).flags
              : null,
    }));

  MouseActionState.setMoveRollback(snapshot);
}

function movingChildIdFromVe(visualElement: VisualElement): string {
  return visualElement.actualLinkItemMaybe?.id ?? visualElement.displayItem.id;
}

function newOrderingAtEndOfCurrentParent(item: Item): Uint8Array {
  return item.relationshipToParent == RelationshipToParent.Attachment
    ? itemState.newOrderingAtEndOfAttachments(item.parentId)
    : itemState.newOrderingAtEndOfChildren(item.parentId);
}

function prepareShiftDragClone(cloned: Item, source: Item): void {
  cloned.endDateTime = moveCalendarDateTimeRangeToStart(
    source.dateTime,
    source.endDateTime,
    cloned.dateTime,
  ).endDateTime;
  if (isPage(cloned) && isPage(source) && isMarkdownTextDocumentPage(source.id)) {
    asPageItem(cloned).backgroundColorIndex = 0;
  }
  // One item is cloned, never a whole group (which has at least two members), so the clone leaves the group.
  // Otherwise clones of two members dropped on another page would form a second group with the same id.
  cloned.groupId = null;
  // Where the clone is dropped decides whether it is pinned.
  cloned.pinnedTo = null;
}

/**
 * Copies `source`'s descendants under its copy `cloned`, for a copy-drag of a container that can be copied but not
 * moved, such as a turn of a chat. A move clones only the dragged item; a copy of a read-only container would be empty
 * without this. Returns the copies' ids, parents first, for adding them after `cloned`.
 */
function cloneDescendantsForCopy(source: Item, cloned: Item): Array<string> {
  const ids: Array<string> = [];
  const visit = (sourceParent: Item, clonedParent: Item): void => {
    if (isContainer(clonedParent)) {
      asContainerItem(clonedParent).computed_children = [];
      asContainerItem(clonedParent).childrenLoaded = true;
      markChildrenLoadAsInitiatedOrComplete(clonedParent.id);
    }
    if (isAttachmentsItem(clonedParent)) {
      asAttachmentsItem(clonedParent).computed_attachments = [];
    }
    const childIds = isContainer(sourceParent) ? asContainerItem(sourceParent).computed_children : [];
    const attachmentIds = isAttachmentsItem(sourceParent) ? asAttachmentsItem(sourceParent).computed_attachments : [];
    for (const id of [...childIds, ...attachmentIds]) {
      const sourceItem = itemState.get(id);
      if (sourceItem == null) { continue; }
      const copy = ItemFns.fromObject(ItemFns.toObject(sourceItem), null);
      copy.id = newUid();
      keepChatAttachmentSource(sourceItem, copy);
      copy.parentId = clonedParent.id;
      copy.groupId = null;
      itemState.add(copy);
      ids.push(copy.id);
      visit(sourceItem, copy);
    }
  };
  visit(source, cloned);
  return ids;
}

/**
 * Copies what comes with `source` under its shift-drag copy `cloned`, so the copy shows the same content: its
 * attachments, and if it's a composite, its children. A composite is the one container whose children are copied: a
 * page or table copy is deliberately an empty one with the same settings (see addShiftDragClone), but an empty
 * composite keeps nothing worth having. An item whose content isn't held in the item itself (a page, table, image, file
 * or text item) is linked to rather than copied. The client can't copy a data item's content, and a page or table
 * copy would be empty, which isn't what anyone wants in the middle of copied content. Returns the new items' ids,
 * parents first, for adding them after `cloned`.
 */
function copyContentsForShiftDrag(source: Item, cloned: Item): Array<string> {
  const ids: Array<string> = [];
  const now = currentUnixTimeSeconds();
  const copyInto = (sourceParent: Item, clonedParent: Item): void => {
    if (isContainer(clonedParent)) {
      asContainerItem(clonedParent).computed_children = [];
      asContainerItem(clonedParent).childrenLoaded = true;
      markChildrenLoadAsInitiatedOrComplete(clonedParent.id);
    }
    if (isAttachmentsItem(clonedParent)) {
      asAttachmentsItem(clonedParent).computed_attachments = [];
    }
    const childIds = isContainer(sourceParent) ? asContainerItem(sourceParent).computed_children : [];
    const attachmentIds = isAttachmentsItem(sourceParent) ? asAttachmentsItem(sourceParent).computed_attachments : [];
    for (const id of [...childIds, ...attachmentIds]) {
      const sourceItem = itemState.get(id);
      if (sourceItem == null) { continue; }
      if (isContainer(sourceItem) || isDataItem(sourceItem)) {
        const link = LinkFns.createFromItem(
          sourceItem, clonedParent.id, sourceItem.relationshipToParent, new Uint8Array(sourceItem.ordering));
        itemState.add(link);
        ids.push(link.id);
        continue;
      }
      const copy = ItemFns.fromObject(ItemFns.toObject(sourceItem), null);
      copy.id = newUid();
      copy.parentId = clonedParent.id;
      copy.groupId = null;
      copy.pinnedTo = null;
      copy.creationDate = now;
      copy.lastModifiedDate = now;
      itemState.add(copy);
      ids.push(copy.id);
      copyInto(sourceItem, copy);
    }
  };
  copyInto(source, cloned);
  return ids;
}

/**
 * Adds a shift-drag copy `cloned` of `source`. A copy is added to the server on drop, with what comes with it, rather
 * than now, so an abandoned drag leaves nothing to clean up there. With `copyOnly`, `source` can be copied but not
 * moved.
 */
function addShiftDragClone(cloned: Item, source: Item, copyOnly: boolean): void {
  const pendingDescendantIds = addPendingCopy(cloned, source, copyOnly);
  MouseActionState.setItemCopyMove({ pendingDescendantIdsByItemId: new Map([[cloned.id, pendingDescendantIds]]) });
}

/** Adds `cloned` and copies of what comes with `source` to the client only. Returns the copies' ids, parents first. */
function addPendingCopy(cloned: Item, source: Item, copyOnly: boolean): Array<string> {
  itemState.add(cloned);
  if (copyOnly) {
    return cloneDescendantsForCopy(source, cloned);
  }
  if (isContainer(source) && !isComposite(source)) {
    // A page or table copy is an empty one with the same settings, which is intended: sometimes that's what's wanted.
    // Its children are marked loaded, so arrange doesn't ask the server for them while the server doesn't have it.
    asContainerItem(cloned).computed_children = [];
    asContainerItem(cloned).childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(cloned.id);
    if (isAttachmentsItem(cloned)) { asAttachmentsItem(cloned).computed_attachments = []; }
    return [];
  }
  return copyContentsForShiftDrag(source, cloned);
}

/**
 * For a Shift- or Ctrl-drag of a selected item: copies of all the selected items (Shift), or links to them (Ctrl), each
 * added next to its original, for the drag to move as a group instead of the originals. With Shift, an item that can't
 * be copied is linked to instead (see copyContentsForShiftDrag), and a link is copied, as for a single item. The copies
 * are added to the server on drop. Afterwards the active element is the dragged item's copy. Returns the copies' group,
 * or null if the drag isn't of a selection of more than one item, in which case nothing is changed.
 */
function copySelectionForMove(
  store: StoreContextModel,
  activeVisualElement: VisualElement,
  parentItem: Item,
  linkOnly: boolean,
): Array<GroupMoveItem> | null {
  const group = groupMoveItemsFromSelectionMaybe(store, activeVisualElement, parentItem);
  if (group == null || group.length < 2) { return null; }
  const activeVeid = VeFns.veidFromVe(activeVisualElement);
  const now = currentUnixTimeSeconds();

  // Copies of all the members of a group form a new group. A copy of only some of them leaves it.
  const newGroupIds = new Map<string, string>();
  for (const groupId of GroupFns.wholeGroupIds(parentItem.id, group.map(e => e.veid.linkIdMaybe ?? e.veid.itemId))) {
    newGroupIds.set(groupId, newUid());
  }

  const pending = new Map<string, Array<string>>();
  const copiedGroup: Array<GroupMoveItem> = [];
  let activeCopyVeid: Veid | null = null;
  for (const entry of group) {
    const treeItem = itemState.get(entry.veid.linkIdMaybe ?? entry.veid.itemId);
    if (treeItem == null || !isPositionalItem(treeItem)) { continue; }
    const displayItem = itemState.get(entry.veid.itemId);
    const groupId = treeItem.groupId == null ? null : newGroupIds.get(treeItem.groupId) ?? null;
    const ordering = itemState.newOrderingDirectlyAfterChild(treeItem.parentId, treeItem.id);
    let copyVeid: Veid;
    if (isLink(treeItem)) {
      const link = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(treeItem), null));
      link.id = newUid();
      link.creationDate = now;
      link.lastModifiedDate = now;
      link.ordering = ordering;
      link.groupId = groupId;
      link.pinnedTo = null;
      itemState.add(link);
      pending.set(link.id, []);
      copyVeid = { itemId: entry.veid.itemId, linkIdMaybe: link.id };
    } else if (displayItem == null) {
      continue;
    } else if (linkOnly || (isDataItem(displayItem) && !isChatAttachmentItem(displayItem))) {
      const link = LinkFns.createFromItem(displayItem, treeItem.parentId, treeItem.relationshipToParent, ordering);
      link.groupId = groupId;
      itemState.add(link);
      pending.set(link.id, []);
      copyVeid = { itemId: displayItem.id, linkIdMaybe: link.id };
    } else {
      const cloned = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(displayItem), null));
      cloned.id = newUid();
      cloned.creationDate = now;
      cloned.lastModifiedDate = now;
      cloned.dateTime = now;
      cloned.ordering = ordering;
      prepareShiftDragClone(cloned, displayItem);
      cloned.groupId = groupId;
      keepChatAttachmentSource(displayItem, cloned);
      pending.set(cloned.id, addPendingCopy(cloned, displayItem, itemCanCopy(displayItem) && !itemCanMove(displayItem)));
      copyVeid = VeFns.veidFromId(cloned.id);
    }
    if (VeFns.compareVeids(entry.veid, activeVeid) == 0) { activeCopyVeid = copyVeid; }
    copiedGroup.push({ veid: copyVeid, startPosGr: entry.startPosGr, parentId: entry.parentId });
  }

  const pendingState = { pendingDescendantIdsByItemId: pending };
  if (activeCopyVeid == null) {
    discardPendingCopies(pendingState);
    return null;
  }
  MouseActionState.setItemCopyMove(pendingState);
  MouseActionState.setActiveElementPath(VeFns.addVeidToPath(activeCopyVeid, activeVisualElement.parentPath!));
  // The copies are arranged as ordinary items, as the originals were, before the drag moves them.
  arrangeNow(store, "moving-init-copy-selection");
  return copiedGroup;
}

function discardPendingCopies(itemCopyMove: ItemCopyMoveState): void {
  for (const id of itemCopyMovePendingIds(itemCopyMove).reverse()) {
    if (itemState.get(id) != null) { itemState.delete(id); }
  }
}

/**
 * A copy of a chat attachment refers to the same attachment until it is added, when it is given the attachment's text
 * (`clientTextCopyData`). The reference is client only, so `toObject` leaves it out.
 */
function keepChatAttachmentSource(source: Item, copy: Item): void {
  if (isChatAttachmentItem(source)) {
    asTextItem(copy).chatAttachmentSource = source.chatAttachmentSource;
  }
}

/**
 * Whether a page can hold a copy for the length of a drag. Unlike a live move, nothing is changed in the page: the copy
 * is added where it is dropped. So a page that can't be changed, like a chat's, can be the start of a copy out of it.
 */
function pageCanHostPendingCopy(pageVe: VisualElement): boolean {
  return isPage(pageVe.displayItem) &&
    !!(pageVe.flags & VisualElementFlags.ShowChildren) &&
    pageVe.childAreaBoundsPx != null &&
    pageVe.viewportBoundsPx != null;
}

function moveRollbackOrderingForChild(childId: string): Uint8Array | null {
  const rollback = MouseActionState.getMoveRollback()?.find(entry => entry.id == childId);
  return rollback ? new Uint8Array(rollback.ordering) : null;
}

function normalizeMovingListPageSelectedMainVe(
  store: StoreContextModel,
  activeVisualElement: VisualElement,
  desktopPosPx: Vector,
): VisualElement {
  if (activeVisualElement.linkItemMaybe?.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM || activeVisualElement.parentPath == null) {
    return activeVisualElement;
  }

  const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath);
  const parentViewportBoundsPx = parentVe != null
    ? VeFns.veViewportBoundsRelativeToDesktopPx(store, parentVe)
    : null;
  const proxyBoundsPx = parentViewportBoundsPx != null
    ? {
      x: parentViewportBoundsPx.x + activeVisualElement.boundsPx.x,
      y: parentViewportBoundsPx.y + activeVisualElement.boundsPx.y,
      w: activeVisualElement.boundsPx.w,
      h: activeVisualElement.boundsPx.h,
    }
    : VeFns.veBoundsRelativeToDesktopPx(store, activeVisualElement);
  const movingDimensionsBl = ItemFns.calcSpatialDimensionsBl(VeFns.treeItem(activeVisualElement));
  MouseActionState.setClickOffsetProp({
    x: Math.max(0, Math.min(1, (desktopPosPx.x - proxyBoundsPx.x) / Math.max(1, movingDimensionsBl.w * LINE_HEIGHT_PX))),
    y: Math.max(0, Math.min(1, (desktopPosPx.y - proxyBoundsPx.y) / Math.max(1, movingDimensionsBl.h * LINE_HEIGHT_PX))),
  });

  const actualChildPath = VeFns.addVeidToPath(VeFns.actualVeidFromVe(activeVisualElement), activeVisualElement.parentPath);
  MouseActionState.setActiveElementPath(actualChildPath);
  return MouseActionState.readVisualElement(actualChildPath) ?? activeVisualElement;
}

function preserveListSelectionWhenMovingSelectedChild(
  store: StoreContextModel,
  listPageVe: VisualElement | null,
  movingVe: VisualElement,
  originalOrderingMaybe: Uint8Array | null,
) {
  if (!listPageVe || !isPage(listPageVe.displayItem)) { return; }
  const listPage = asPageItem(listPageVe.displayItem);
  if (listPage.arrangeAlgorithm != ArrangeAlgorithm.List) { return; }

  const movingVeid = VeFns.actualVeidFromVe(movingVe);
  const movingChildId = movingChildIdFromVe(movingVe);
  const renderedSelectedVe = VesCache.current.readSelected(VeFns.veToPath(listPageVe));
  PageFns.moveListPageSelectionOffChild(
    store,
    listPage,
    [VeFns.actualVeidFromVe(listPageVe), VeFns.veidFromVe(listPageVe), { itemId: listPage.id, linkIdMaybe: null }],
    movingVeid,
    movingChildId,
    originalOrderingMaybe,
    renderedSelectedVe != null && VeFns.compareVeids(VeFns.actualVeidFromVe(renderedSelectedVe), movingVeid) == 0,
  );
}

/** A chat attachment is copied as a text item instead, since the chat it is in can't hold a page. */
function textDocumentMaterializeMoveRequested(activeVisualElement: VisualElement, shiftDown: boolean): boolean {
  return shiftDown &&
    isText(activeVisualElement.displayItem) &&
    !isChatAttachmentItem(activeVisualElement.displayItem);
}

function orderingForPendingTextDocumentPage(startPageId: string, activeItem: PositionalItem): Uint8Array {
  if (activeItem.parentId == startPageId && activeItem.relationshipToParent == RelationshipToParent.Child) {
    return itemState.newOrderingDirectlyAfterChild(startPageId, activeItem.id);
  }
  return itemState.newOrderingAtEndOfChildren(startPageId);
}

function initiateTextDocumentMaterializeMove(
  store: StoreContextModel,
  sourceTextItem: TextItem,
  activeItem: PositionalItem,
  activeVisualElement: VisualElement,
  desktopPosPx: Vector,
): boolean {
  const user = store.user.getUserMaybe();
  if (user == null) {
    return false;
  }

  const startPageVe = resolveMoveTargetPageVe(activeVisualElement);
  if (!pageCanHostLiveMovingItem(startPageVe)) {
    return false;
  }

  const startPage = asPageItem(startPageVe.displayItem);
  const pendingPage = createPendingTextDocumentPage(
    sourceTextItem,
    user.userId,
    startPage.id,
    orderingForPendingTextDocumentPage(startPage.id, activeItem),
  );
  pendingPage.spatialPositionGr = activeItem.parentId == startPage.id && activeItem.relationshipToParent == RelationshipToParent.Child
    ? { ...activeItem.spatialPositionGr }
    : { x: 0.0, y: 0.0 };
  pendingPage.spatialWidthGr = sourceTextItem.spatialWidthGr;
  itemState.add(pendingPage);

  const { activePosGr, startPosBl, moveToPageInnerSizeBl } = calculateMoveToPagePositionGr(
    store,
    startPageVe,
    desktopPosPx,
    pendingPage,
    RelationshipToParent.Child,
    MouseActionState.getClickOffsetProp(),
  );
  pendingPage.spatialPositionGr = activePosGr;

  const startPagePath = VeFns.veToPath(startPageVe);
  MouseActionState.setMoveRollback([]);
  MouseActionState.setTextDocumentMaterializeMove({ sourceTextItem, pendingPageId: pendingPage.id });
  MouseActionState.setGroupMoveItems(undefined);
  MouseActionState.setStartPx(desktopPosPx);
  MouseActionState.setStartPosBl(startPosBl);
  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / startPageVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / startPageVe.childAreaBoundsPx!.h,
  });
  MouseActionState.setScaleDefiningElementPath(startPagePath);
  MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromId(pendingPage.id), startPagePath));
  MouseActionState.setLinkCreatedOnMoveStart(false);
  store.anItemIsMoving.set(true);
  MouseActionState.setAction(MouseAction.Moving);
  arrangeNow(store, "moving-init-text-document-materialize");
  return true;
}


/**
 * Starts a drag of a chat turn's answer as a new markdown text item, from the "as markdown" button in the header of
 * the turn's composite `compositeVe`. As with a copy out of the chat, the item is added only where it is dropped.
 */
export function moving_initiateQueryChatTurnMarkdown(store: StoreContextModel, compositeVe: VisualElement, desktopPosPx: Vector): void {
  const user = store.user.getUserMaybe();
  if (user == null) { return; }
  const composite = compositeVe.displayItem;
  const placement = queryChatCompletedActivityPlacementForComposite(store, composite.id, composite.parentId);
  if (placement == null) { return; }
  const startPageVe = resolveMoveTargetPageVe(compositeVe);
  if (!pageCanHostPendingCopy(startPageVe)) { return; }

  const startPage = asPageItem(startPageVe.displayItem);
  const item = createQueryChatTurnMarkdownItem(
    user.userId, startPage.id, itemState.newOrderingAtEndOfChildren(startPage.id), placement.activity, placement.turnNumber);
  itemState.add(item);

  // Held by its icon, rather than where the composite was pressed.
  const clickOffsetProp = { x: 0.05, y: 0.5 };
  MouseActionState.setClickOffsetProp(clickOffsetProp);
  const { activePosGr, startPosBl, moveToPageInnerSizeBl } = calculateMoveToPagePositionGr(
    store,
    startPageVe,
    desktopPosPx,
    item,
    RelationshipToParent.Child,
    clickOffsetProp,
  );
  item.spatialPositionGr = activePosGr;

  const startPagePath = VeFns.veToPath(startPageVe);
  MouseActionState.setMoveRollback([]);
  MouseActionState.setItemCopyMove({ pendingDescendantIdsByItemId: new Map([[item.id, []]]) });
  MouseActionState.setGroupMoveItems(undefined);
  MouseActionState.setStartPx(desktopPosPx);
  MouseActionState.setStartPosBl(startPosBl);
  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / startPageVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / startPageVe.childAreaBoundsPx!.h,
  });
  MouseActionState.setScaleDefiningElementPath(startPagePath);
  MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromId(item.id), startPagePath));
  MouseActionState.setLinkCreatedOnMoveStart(false);
  store.anItemIsMoving.set(true);
  MouseActionState.setAction(MouseAction.Moving);
  arrangeNow(store, "moving-init-query-chat-turn-markdown");
}

/**
 * The modifiers that change a drag of activeVisualElement: Shift to copy, Ctrl to link. For a selected item, they copy
 * or link the whole selection (copySelectionForMove).
 */
export function dragModifiers(_store: StoreContextModel, activeVisualElement: VisualElement): { shiftDown: boolean, ctrlDown: boolean } {
  // A row of a read-only document can't be moved, so a drag from its handle can only mean copy, as Shift does elsewhere.
  if (isReadOnlyDocumentHandleDrag(activeVisualElement)) {
    return { shiftDown: true, ctrlDown: false };
  }
  return { shiftDown: CursorEventState.get().shiftDown, ctrlDown: CursorEventState.get().ctrlDown };
}

/** Whether the mouse action under way started on the drag handle of a row in a read-only document. */
function isReadOnlyDocumentHandleDrag(activeVisualElement: VisualElement): boolean {
  if (MouseActionState.empty() || ReadOnlyDocumentHandlePress.get() != VeFns.veToPath(activeVisualElement)) { return false; }
  const treeItem = VeFns.treeItem(activeVisualElement);
  return itemCanCopy(treeItem) && !itemCanMove(treeItem);
}

export function moving_initiate(store: StoreContextModel, activeItem: PositionalItem, activeVisualElement: VisualElement, desktopPosPx: Vector) {
  activeVisualElement = normalizeMovingListPageSelectedMainVe(store, activeVisualElement, desktopPosPx);
  activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));
  const { shiftDown, ctrlDown } = dragModifiers(store, activeVisualElement);
  const materializeTextDocument = textDocumentMaterializeMoveRequested(activeVisualElement, shiftDown);
  const copyOnlyMove = shiftDown && itemCanCopy(activeItem) && !itemCanMove(activeItem);
  if (!itemCanMove(activeItem) && !materializeTextDocument && !copyOnlyMove) {
    return;
  }
  // With a selection modifier held, mouse down didn't clear the selection, since the press might have been a click
  // adding to it (see mouseLeftDownHandler). Dragging an item that isn't in it does.
  if (!veIsSelected(store, activeVisualElement) && store.overlay.selectedVeids.get().length > 0) {
    store.overlay.selectedVeids.set([]);
  }
  captureMoveRollbackSnapshot(store, activeVisualElement, activeItem);
  const parentItem = itemState.get(activeItem.parentId)!;
  // For a selection, the copies or links are moved as a plain group move, in place of the originals.
  const sourceActiveVisualElement = activeVisualElement;
  const copiedGroup = (shiftDown || ctrlDown) && veIsSelected(store, activeVisualElement)
    ? copySelectionForMove(store, activeVisualElement, parentItem, ctrlDown)
    : null;
  if (copiedGroup != null) {
    const activeCopySignal = MouseActionState.getActiveVisualElementSignal();
    if (activeCopySignal == null) {
      discardPendingCopies(MouseActionState.getItemCopyMove()!);
      MouseActionState.setItemCopyMove(null);
      MouseActionState.setMoveRollback(null);
      MouseActionState.setActiveElementPath(VeFns.veToPath(sourceActiveVisualElement));
      arrangeNow(store, "moving-init-copy-selection-failed");
      return;
    }
    activeVisualElement = activeCopySignal.get();
    activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));
  }
  if (materializeTextDocument && copiedGroup == null) {
    if (!initiateTextDocumentMaterializeMove(store, asTextItem(activeVisualElement.displayItem), activeItem, activeVisualElement, desktopPosPx)) {
      MouseActionState.setMoveRollback(null);
    }
    return;
  }
  const isActiveLinkItem = isLink(activeItem);
  // A data item's copy would need its content; a chat attachment's is in its chat (`clientTextCopyData`).
  const shiftWantsClone = shiftDown &&
    (!isDataItem(activeVisualElement.displayItem) || isChatAttachmentItem(activeVisualElement.displayItem));
  const shouldCreateLink = copiedGroup == null && (ctrlDown || (shiftWantsClone && isActiveLinkItem));
  const shouldClone = copiedGroup == null && shiftWantsClone && !isActiveLinkItem; // For link items, shift behaves like ctrl (create link)
  // The originals of copies stay where they are, so the list's selected item doesn't need preserving.
  if (copiedGroup == null && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const movingChild = itemState.get(movingChildIdFromVe(activeVisualElement));
    preserveListSelectionWhenMovingSelectedChild(
      store,
      MouseActionState.readVisualElement(activeVisualElement.parentPath),
      activeVisualElement,
      movingChild?.ordering ? new Uint8Array(movingChild.ordering) : null,
    );
  }
  if (isTable(parentItem) && activeItem.relationshipToParent == RelationshipToParent.Child) {
    // A copy or link is made of the active item only, unless it's part of a selection (copiedGroup).
    MouseActionState.setGroupMoveItems(copiedGroup ?? (shouldCreateLink || shouldClone
      ? undefined
      : groupMoveItemsFromSelectionMaybe(store, activeVisualElement, parentItem)));
    if (!moving_activeItemOutOfTable(store, shouldCreateLink, shouldClone)) { return; }
    MouseActionState.setAction(MouseAction.Moving); // arrange must treat the re-parented item as moving.
    arrangeNow(store, "moving-init-out-of-table");
  }
  else if (activeItem.relationshipToParent == RelationshipToParent.Attachment) {
    const hitInfo = HitInfoFns.hitForDrop(store, desktopPosPx, [], false, false);
    if (!moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Attachment, shouldCreateLink, shouldClone)) { return; }
    MouseActionState.setAction(MouseAction.Moving); // arrange must treat the re-parented item as moving.
    arrangeNow(store, "moving-init-out-of-attachment");
  }
  else if (isComposite(itemState.get(activeItem.parentId)!)) {
    const hitInfo = HitInfoFns.hitForDrop(store, desktopPosPx, [activeItem.id], false, false);
    if (!moving_activeItemToPage(store, hitInfo.overPositionableVe!, desktopPosPx, RelationshipToParent.Child, shouldCreateLink, shouldClone, copyOnlyMove)) { return; }
    MouseActionState.setAction(MouseAction.Moving); // arrange must treat the re-parented item as moving.
    arrangeNow(store, "moving-init-out-of-composite");
  }
  else {
    // A copy of a selection starts where its original is shown. The copy itself may be laid out elsewhere, e.g. in a
    // grid, where it follows the original.
    const renderedStartPosBl = spatialStartPosBlFromRenderedVe(sourceActiveVisualElement);
    MouseActionState.setStartPosBl(renderedStartPosBl ?? {
      x: activeItem.spatialPositionGr.x / GRID_SIZE,
      y: activeItem.spatialPositionGr.y / GRID_SIZE
    });

    // A copy or link is made of the active item only, unless it's part of a selection (copiedGroup).
    MouseActionState.setGroupMoveItems(copiedGroup ?? (shouldCreateLink || shouldClone
      ? undefined
      : groupMoveItemsFromSelectionMaybe(store, activeVisualElement, parentItem)));

    if (shouldClone) {
      const toClone = activeVisualElement.displayItem;
      const cloned = ItemFns.fromObject(ItemFns.toObject(toClone), null);
      cloned.id = newUid();
      cloned.creationDate = currentUnixTimeSeconds();
      cloned.lastModifiedDate = currentUnixTimeSeconds();
      cloned.dateTime = currentUnixTimeSeconds();
      cloned.ordering = newOrderingAtEndOfCurrentParent(cloned);
      prepareShiftDragClone(cloned, toClone);
      addShiftDragClone(cloned, toClone, copyOnlyMove);

      const activeParentPath = VeFns.parentPath(MouseActionState.getActiveElementPath()!);
      const newLinkVeid = VeFns.veidFromId(cloned.id);
      MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, activeParentPath));
      MouseActionState.setAction(MouseAction.Moving); // page arrange depends on this in the grid case.
      MouseActionState.setLinkCreatedOnMoveStart(false);

      // Preserve calendar page scroll position during synchronous arrange.
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      arrangeNow(store, "moving-init-clone-current-page");

      // Restore calendar page scroll position
      if (savedScrollY !== null && savedScrollX !== null) {
        store.perItem.setPageScrollYProp(parentPageVeid, savedScrollY);
        store.perItem.setPageScrollXProp(parentPageVeid, savedScrollX);
      }
    }
    else if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
      const link = LinkFns.createFromItem(
        activeVisualElement.displayItem,
        activeItem.parentId,
        RelationshipToParent.Child,
        itemState.newOrderingDirectlyAfterChild(activeItem.parentId, activeItem.id));
      link.spatialPositionGr = activeItem.spatialPositionGr;
      if (activeVisualElement.linkItemMaybe) {
        link.spatialWidthGr = activeVisualElement.linkItemMaybe.spatialWidthGr;
        link.spatialHeightGr = activeVisualElement.linkItemMaybe.spatialHeightGr;
      } else {
        if (isXSizableItem(activeVisualElement.displayItem)) {
          link.spatialWidthGr = asXSizableItem(activeVisualElement.displayItem).spatialWidthGr;
        }
        if (isYSizableItem(activeVisualElement.displayItem)) {
          link.spatialHeightGr = asYSizableItem(activeVisualElement.displayItem).spatialHeightGr;
        }
      }
      itemState.add(link);
      server.addItem(link, null);

      const activeParentPath = VeFns.parentPath(MouseActionState.getActiveElementPath()!);
      const newLinkVeid = VeFns.veidFromId(link.id);
      MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, activeParentPath));
      MouseActionState.setAction(MouseAction.Moving); // page arrange depends on this in the grid case.
      MouseActionState.setLinkCreatedOnMoveStart(true);

      // Preserve calendar page scroll position during synchronous arrange.
      const parentPageVeid = VeFns.veidFromPath(activeParentPath);
      const parentPage = itemState.get(parentPageVeid.itemId)!;
      let savedScrollY = null;
      let savedScrollX = null;
      if (isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        savedScrollY = store.perItem.getPageScrollYProp(parentPageVeid);
        savedScrollX = store.perItem.getPageScrollXProp(parentPageVeid);
      }

      arrangeNow(store, "moving-init-link-current-page");

      // Restore calendar page scroll position
      if (savedScrollY !== null && savedScrollX !== null) {
        store.perItem.setPageScrollYProp(parentPageVeid, savedScrollY);
        store.perItem.setPageScrollXProp(parentPageVeid, savedScrollX);
      }
    }

    if (MouseActionState.hitboxTypeIncludes(HitboxFlags.ContentEditable)) {
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      (document.activeElement! as HTMLElement).blur();
    }
  }

  if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    const itemDate = new Date(activeItem.dateTime * 1000);
    const month = itemDate.getMonth() + 1;
    const day = itemDate.getDate();
    store.movingItemSourceCalendarInfo.set({
      pageItemId: parentItem.id,
      combinedIndex: encodeCalendarCombinedIndex(month, day),
      year: itemDate.getFullYear(),
    });
  } else {
    store.movingItemSourceCalendarInfo.set(null);
  }

  store.anItemIsMoving.set(true);
  MouseActionState.setAction(MouseAction.Moving);
  if (shouldArrangeDocumentPageMoveOutOnStart(parentItem, activeVisualElement)) {
    const activeElementPath = MouseActionState.getActiveElementPath();
    arrangeNow(store, "moving-init-document-page-move-out");
    if (activeElementPath != null) {
      MouseActionState.setActiveElementPath(activeElementPath);
    }
  }
}

/**
 * The group moving with activeVisualElement, if it is part of the current selection set: the selected items, with
 * their start positions.
 */
function groupMoveItemsFromSelectionMaybe(
  store: StoreContextModel,
  activeVisualElement: VisualElement,
  parentItem: Item,
): Array<GroupMoveItem> | undefined {
  const selected = store.overlay.selectedVeids.get();
  const activeVeid = VeFns.veidFromVe(activeVisualElement);
  if (!selected.some(v => VeFns.compareVeids(v, activeVeid) == 0)) { return undefined; }
  // Members of a composite and items in a calendar page can be selected by clicking, but group moves place items by
  // page position, which neither uses: a dragged one moves on its own, as when nothing is selected.
  if (isComposite(parentItem) ||
    (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Calendar)) {
    return undefined;
  }

  const entries = selected
    .map(veid => ({ veid, item: itemState.get(veid.linkIdMaybe ? veid.linkIdMaybe : veid.itemId) }))
    .filter((e): e is { veid: Veid, item: PositionalItem } => e.item != null && isPositionalItem(e.item));

  // Rows of a list page or table are selected in the order they are shown (see extendRowRangeSelection), and their
  // spatial positions don't relate to that order.
  const selectedAsRows = !!(activeVisualElement.flags & VisualElementFlags.LineItem) ||
    isTable(parentItem) ||
    (isPage(parentItem) &&
      (asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List ||
        asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Table));
  if (selectedAsRows) {
    const startPositionsGr = stackedGroupMoveStartPositionsGr(entries.map(e => e.item));
    return entries.map((e, i) => ({ veid: e.veid, startPosGr: startPositionsGr[i], parentId: e.item.parentId }));
  }

  // The spatial positions of the items in the dock or a grid, justified, catalog or document page are unused, and a
  // marquee selects them in no particular order: stack them in the order they are laid out.
  const parentVe = activeVisualElement.parentPath ? VesCache.current.readNode(activeVisualElement.parentPath) : null;
  if (isPage(parentItem) && (pageLaysOutChildrenInReadingOrder(parentItem) || (parentVe && (parentVe.flags & VisualElementFlags.IsDock)))) {
    const childOrder = asPageItem(parentItem).computed_children;
    entries.sort((a, b) => childOrder.indexOf(a.item.id) - childOrder.indexOf(b.item.id));
    const startPositionsGr = stackedGroupMoveStartPositionsGr(entries.map(e => e.item));
    return entries.map((e, i) => ({ veid: e.veid, startPosGr: startPositionsGr[i], parentId: e.item.parentId }));
  }

  return entries.map(e => ({
    veid: e.veid,
    startPosGr: (() => {
      const renderedVe = VesCache.current.findNodes(e.veid)[0];
      const renderedPosBl = renderedVe ? spatialStartPosBlFromRenderedVe(renderedVe) : null;
      return renderedPosBl
        // Rendered bounds can drift off the persisted half-block grid due to scaling.
        // Snap them back before using them as the basis for a persisted group move.
        ? quantizeSpatialPosGr({ x: renderedPosBl.x * GRID_SIZE, y: renderedPosBl.y * GRID_SIZE })
        : quantizeSpatialPosGr(e.item.spatialPositionGr);
    })(),
    parentId: e.item.parentId,
  }));
}

function pageLaysOutChildrenInReadingOrder(page: Item): boolean {
  const arrangeAlgorithm = asPageItem(page).arrangeAlgorithm;
  return arrangeAlgorithm == ArrangeAlgorithm.Grid ||
    arrangeAlgorithm == ArrangeAlgorithm.Justified ||
    arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
    arrangeAlgorithm == ArrangeAlgorithm.Document;
}

function shouldArrangeDocumentPageMoveOutOnStart(parentItem: Item, activeVisualElement: VisualElement): boolean {
  return isPage(activeVisualElement.displayItem) &&
    isPage(parentItem) &&
    asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    MouseActionState.hitboxTypeIncludes(HitboxFlags.Move);
}

function spatialStartPosBlFromRenderedVe(visualElement: VisualElement): Vector | null {
  if (!(visualElement.flags & VisualElementFlags.Detailed) || !visualElement.parentPath) { return null; }

  const parentVe = VesCache.current.readNode(visualElement.parentPath);
  if (!parentVe || !isPage(parentVe.displayItem) || !parentVe.childAreaBoundsPx) { return null; }

  const parentPage = asPageItem(parentVe.displayItem);
  if (parentPage.arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch) { return null; }

  const parentInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
  return {
    x: visualElement.boundsPx.x / parentVe.childAreaBoundsPx.w * parentInnerSizeBl.w,
    y: visualElement.boundsPx.y / parentVe.childAreaBoundsPx.h * parentInnerSizeBl.h,
  };
}

function quantizeSpatialPosGr(posGr: Vector): Vector {
  return {
    x: Math.round(posGr.x / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
    y: Math.round(posGr.y / (GRID_SIZE / 2.0)) * (GRID_SIZE / 2.0),
  };
}

function pageCanHostLiveMovingItem(pageVe: VisualElement): boolean {
  if (!isPage(pageVe.displayItem)) {
    return false;
  }
  const page = asPageItem(pageVe.displayItem);
  return page.clientOnly !== true &&
    itemCanEditChildren(page) &&
    itemCanAcceptManualChildren(page) &&
    !!(pageVe.flags & VisualElementFlags.ShowChildren) &&
    pageVe.childAreaBoundsPx != null &&
    pageVe.viewportBoundsPx != null;
}

export function mouseAction_moving(deltaPx: Vector, desktopPosPx: Vector, store: StoreContextModel) {
  MouseActionState.setMoveBlockedCursor(false);
  const activeVisualElementSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVisualElementSignal) {
    store.anItemIsMoving.set(false);
    return;
  }
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));


  const ignoreIds = movingHitIgnoreIds(activeVisualElement, MouseActionState.getGroupMoveItems());

  const hitInfo = HitInfoFns.hitForDrop(store, desktopPosPx, ignoreIds, MouseActionState.usesEmbeddedInteractiveHitTesting(), false);
  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  const normalizedTableMoveDesktopPx = tableContainerVeMaybe != null
    ? TableFns.normalizeMoveOverDesktopPx(store, tableContainerVeMaybe, desktopPosPx)
    : desktopPosPx;
  const isOverTableRootAttach =
    !!(hitInfo.hitboxType & HitboxFlags.Attach) &&
    hitInfo.overVes != null &&
    isTable(hitInfo.overVes.get().displayItem);
  const shouldTreatTableHeaderAsFirstRow =
    isOverTableRootAttach &&
    tableContainerVeMaybe != null &&
    normalizedTableMoveDesktopPx.y !== desktopPosPx.y;
  const tableChildContainerDropTargetPath =
    tableContainerVeMaybe != null &&
      hitInfo.overVes != null &&
      !!(hitInfo.hitboxType & HitboxFlags.OpenPopup) &&
      !!(hitInfo.overVes.get().flags & VisualElementFlags.InsideTable) &&
      isPage(hitInfo.overVes.get().displayItem)
      ? VeFns.veToPath(hitInfo.overVes.get())
      : null;
  const dockListPageIconMoveTarget = dockListPageIconMoveTargetMaybe(hitInfo, ignoreIds);
  const resolvedMoveTarget = resolveInternalMoveTarget(hitInfo, ignoreIds);
  // A cycle-creating target is treated like any other invalid target: the item keeps
  // following the pointer within its current container, and the drop is rejected.
  const moveTargetCreatesCycle =
    moveTargetWouldCreateRelationshipCycle(hitInfo, resolvedMoveTarget, activeVisualElement, MouseActionState.getGroupMoveItems());
  if (moveTargetCreatesCycle) {
    MouseActionState.setMoveBlockedCursor(true);
  }
  const hasValidMoveTarget = resolvedMoveTarget.validity == "valid" && !moveTargetCreatesCycle;
  const hitMoveTargetVe = isPage(resolvedMoveTarget.hoverContainerVe.displayItem)
    ? resolvedMoveTarget.hoverContainerVe
    : resolvedMoveTarget.positioningPageVe;
  const hitMoveTargetPath = VeFns.veToPath(hitMoveTargetVe);
  const hoveredPageInsideTable =
    tableContainerVeMaybe != null &&
    !!(hitMoveTargetVe.flags & VisualElementFlags.InsideTable);
  const moveTargetIsDocumentPage =
    isPage(hitMoveTargetVe.displayItem) &&
    asPageItem(hitMoveTargetVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document;
  const moveTargetIsDocumentComposite =
    moveTargetIsDocumentPage && isComposite(resolvedMoveTarget.hoverContainerVe.displayItem);
  const tableContainerIsIgnored =
    tableContainerVeMaybe != null &&
    (ignoreIds.includes(tableContainerVeMaybe.displayItem.id) ||
      (tableContainerVeMaybe.linkItemMaybe != null && ignoreIds.includes(tableContainerVeMaybe.linkItemMaybe.id)));
  const tableMoveTargetPath =
    tableContainerVeMaybe != null &&
      !tableContainerIsIgnored &&
      (!isOverTableRootAttach || shouldTreatTableHeaderAsFirstRow)
      ? VeFns.veToPath(tableContainerVeMaybe)
      : null;
  const isTextDocumentMaterializeMove = MouseActionState.getTextDocumentMaterializeMove() != null;
  let attachmentDropTargetIsActive = false;

  if (!hasValidMoveTarget) {
    clearMoveOverTargetState(store);
  } else {
    // update move over element state.
    const moveOverContainerPath = tableMoveTargetPath != null
      ? tableMoveTargetPath
      : moveTargetIsDocumentPage && !moveTargetIsDocumentComposite
        ? hitMoveTargetPath
        : resolvedMoveTarget.hoverContainerPath;
    if (MouseActionState.getMoveOverContainerPath() == null ||
      MouseActionState.getMoveOverContainerPath()! != moveOverContainerPath) {
      clearMoveOverContainerState(store);

      store.perVe.setMovingItemIsOver(moveOverContainerPath, true);
      MouseActionState.setMoveOverContainerPath(moveOverContainerPath);
    }

    // update move over attach state.
    clearMoveOverAttachState(store);
    if (!isTextDocumentMaterializeMove && (hitInfo.hitboxType & HitboxFlags.Attach) && !shouldTreatTableHeaderAsFirstRow) {
      const attachVe = hitInfo.overVes!.get();
      const attachVePath = VeFns.veToPath(attachVe);
      store.perVe.setMovingItemIsOverAttach(attachVePath, true);
      MouseActionState.setMoveOverAttachHitboxPath(attachVePath);

      // Calculate which attachment slot the mouse is over
      const attachItem = asAttachmentsItem(attachVe.displayItem);
      // Attachments are laid out along the top of the item, which (unlike the contents of a page) doesn't scroll.
      const veBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, attachVe);
      const clampedIndex = calcSpatialAttachmentInsertIndex(
        veBoundsPx,
        attachmentAnchorRightPxForVe(attachVe, veBoundsPx.w),
        attachmentBlockSizePxForVe(attachVe, veBoundsPx.w),
        desktopPosPx.x,
        attachItem.computed_attachments.length,
      );

      store.perVe.setMoveOverAttachmentIndex(attachVePath, clampedIndex);
    }

    // update move over attach composite state.
    clearMoveOverAttachCompositeState(store);
    if (!isTextDocumentMaterializeMove && !moveTargetIsDocumentPage && (hitInfo.hitboxType & HitboxFlags.AttachComposite)) {
      const attachCompositeVe = hitInfo.overVes!.get();
      const attachCompositeTargetIsAlreadyInComposite =
        attachCompositeVe.displayItem.parentId != null &&
        isComposite(itemState.get(attachCompositeVe.displayItem.parentId)!);

      if (!attachCompositeTargetIsAlreadyInComposite) {
        store.perVe.setMovingItemIsOverAttachComposite(VeFns.veToPath(attachCompositeVe), true);
        MouseActionState.setMoveOverAttachCompositePath(VeFns.veToPath(attachCompositeVe));
      }
    }

    attachmentDropTargetIsActive =
      MouseActionState.getMoveOverAttachHitboxPath() != null ||
      MouseActionState.getMoveOverAttachCompositePath() != null;
    if (attachmentDropTargetIsActive && moveTargetIsDocumentPage) {
      store.perVe.setMoveOverIndex(hitMoveTargetPath, -1);
    }

    if (tableMoveTargetPath != null) {
      // Over a table, the item stays in its page until it is dropped. If the pointer got to the table without crossing
      // the page the table is in (e.g. a fast drag from a page in the dock to a table page popup), the item is still in
      // a page it has left, which keeps it inside its bounds and at its scale. Move it to the table's page, as crossing
      // that page would have.
      const tableHostPageVe = tableHostPageVeMaybe(tableContainerVeMaybe!);
      if (tableHostPageVe != null &&
        VeFns.veToPath(tableHostPageVe) != MouseActionState.getScaleDefiningElementPath() &&
        moving_activeItemToPage(store, tableHostPageVe, desktopPosPx, RelationshipToParent.Child, false, false)) {
        arrangeNow(store, "moving-enter-table-host-page");
        moving_handleOverTable(store, tableContainerVeMaybe!, desktopPosPx, tableChildContainerDropTargetPath);
        return;
      }
      moving_handleOverTable(store, tableContainerVeMaybe!, desktopPosPx, tableChildContainerDropTargetPath);
    } else {
      clearTableChildContainerDropTarget(store, tableContainerVeMaybe != null ? VeFns.veToPath(tableContainerVeMaybe) : null);
    }

    if (!dockListPageIconMoveTarget &&
      tableMoveTargetPath == null &&
      !hoveredPageInsideTable &&
      pageCanHostLiveMovingItem(hitMoveTargetVe) &&
      MouseActionState.readScaleDefiningElement()!.displayItem != hitMoveTargetVe.displayItem) {
      if (tableMoveTargetPath == null) {
        clearTableChildContainerDropTarget(store, moveOverContainerPath);
      }
      if (moving_activeItemToPage(store, hitMoveTargetVe, desktopPosPx, RelationshipToParent.Child, false, false)) {
        arrangeNow(store, "moving-enter-new-container");
        const enteredPageVe = MouseActionState.readScaleDefiningElement();
        if (enteredPageVe != null) {
          updatePageMoveOverIndex(store, enteredPageVe, desktopPosPx, hasValidMoveTarget, attachmentDropTargetIsActive, moveTargetIsDocumentComposite);
        }
      }
      return;
    }

    if (tableMoveTargetPath == null) {
      const moveOverContainerVe = MouseActionState.readMoveOverContainer()!;
      if (isComposite(moveOverContainerVe.displayItem)) {
        if (
          MouseActionState.getMoveOverAttachHitboxPath() != null ||
          MouseActionState.getMoveOverAttachCompositePath() != null
        ) {
          store.perVe.setMoveOverIndex(VeFns.veToPath(moveOverContainerVe), -1);
        } else {
          const appendToDocumentComposite = moveTargetIsDocumentComposite &&
            hitInfo.overVes?.get() == moveOverContainerVe &&
            !!(hitInfo.hitboxType & HitboxFlags.AttachComposite);
          moving_handleOverComposite(store, moveOverContainerVe, desktopPosPx, appendToDocumentComposite);
        }
      }
    }
  }

  const onePxSizeBl = MouseActionState.getOnePxSizeBl()!;
  const deltaBl = {
    x: deltaPx.x * onePxSizeBl.x,
    y: deltaPx.y * onePxSizeBl.y
  };

  let newPosBl = vectorAdd(MouseActionState.getStartPosBl()!, deltaBl);
  newPosBl.x = Math.round(newPosBl.x * 2.0) / 2.0;
  newPosBl.y = Math.round(newPosBl.y * 2.0) / 2.0;
  const inElementVe = MouseActionState.readScaleDefiningElement()!;
  const inElement = inElementVe.displayItem;
  const dimBl = PageFns.calcInnerSpatialDimensionsBl(asPageItem(inElement));
  if (newPosBl.x < 0.0) { newPosBl.x = 0.0; }
  if (newPosBl.y < 0.0) { newPosBl.y = 0.0; }
  if (newPosBl.x > dimBl.w - 0.5) { newPosBl.x = dimBl.w - 0.5; }
  if (newPosBl.y > dimBl.h - 0.5) { newPosBl.y = dimBl.h - 0.5; }
  const newPosGr = { x: newPosBl.x * GRID_SIZE, y: newPosBl.y * GRID_SIZE };

  updatePageMoveOverIndex(store, inElementVe, desktopPosPx, hasValidMoveTarget, attachmentDropTargetIsActive, moveTargetIsDocumentComposite);

  if (hasValidMoveTarget && (inElementVe.flags & VisualElementFlags.IsDock)) {
    const dockScrollYPx = getDockScrollYPx(store, inElementVe);
    const dockChildAreaYPx = desktopPosPx.y - inElementVe.boundsPx.y + dockScrollYPx;
    const indexAndPosition = dockInsertIndexAndPositionFromDockChildAreaY(
      store,
      asPageItem(inElement),
      activeItem,
      inElementVe.viewportBoundsPx!.w,
      dockChildAreaYPx,
    );
    store.perVe.setMoveOverIndexAndPosition(VeFns.veToPath(inElementVe), indexAndPosition);
  }

  if (asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch || compareVector(newPosGr, activeItem.spatialPositionGr) != 0) {
    const group = MouseActionState.getGroupMoveItems();
    if (group && group.length > 0) {
      const veidActive = VeFns.veidFromVe(activeVisualElement);
      const activeEntry = group.find(g => g.veid.itemId === veidActive.itemId && g.veid.linkIdMaybe === veidActive.linkIdMaybe);
      const deltaFromStart = {
        x: newPosGr.x - (activeEntry ? activeEntry.startPosGr.x : activeItem.spatialPositionGr.x),
        y: newPosGr.y - (activeEntry ? activeEntry.startPosGr.y : activeItem.spatialPositionGr.y),
      };
      // A group's start positions in these pages are just a stack (see groupMoveItemsFromSelectionMaybe). A drop here
      // doesn't use the items' spatial positions, so leave them for if the page is switched back to spatial.
      if (!pageLaysOutChildrenInReadingOrder(inElement)) {
        for (const g of group) {
          const itm = asPositionalItem(itemState.get(g.veid.linkIdMaybe ? g.veid.linkIdMaybe : g.veid.itemId)!);
          if (itm.parentId === activeItem.parentId) {
            itm.spatialPositionGr = { x: g.startPosGr.x + deltaFromStart.x, y: g.startPosGr.y + deltaFromStart.y };
          }
        }
      }
      arrangeNow(store, "moving-update-group-position");
    } else {
      activeItem.spatialPositionGr = newPosGr;
      arrangeNow(store, "moving-update-position");
    }
  }
}


function clearMoveOverContainerState(store: StoreContextModel): void {
  const moveOverContainerPath = MouseActionState.getMoveOverContainerPath();
  if (moveOverContainerPath == null) { return; }
  store.perVe.setMovingItemIsOver(moveOverContainerPath, false);
  clearTableChildContainerDropTarget(store, moveOverContainerPath);
  MouseActionState.setMoveOverContainerPath(null);
}

function clearMoveOverAttachState(store: StoreContextModel): void {
  const attachPath = MouseActionState.getMoveOverAttachHitboxPath();
  if (attachPath == null) { return; }
  store.perVe.setMovingItemIsOverAttach(attachPath, false);
  store.perVe.setMoveOverAttachmentIndex(attachPath, -1);
  MouseActionState.setMoveOverAttachHitboxPath(null);
}

function clearMoveOverAttachCompositeState(store: StoreContextModel): void {
  const attachCompositePath = MouseActionState.getMoveOverAttachCompositePath();
  if (attachCompositePath == null) { return; }
  store.perVe.setMovingItemIsOverAttachComposite(attachCompositePath, false);
  MouseActionState.setMoveOverAttachCompositePath(null);
}

function clearMoveOverTargetState(store: StoreContextModel): void {
  clearMoveOverAttachState(store);
  clearMoveOverAttachCompositeState(store);
  clearMoveOverContainerState(store);
}


function clearTableChildContainerDropTarget(store: StoreContextModel, tablePath: VisualElementPath | null): void {
  if (tablePath == null) { return; }
  store.perVe.setMoveOverChildContainerPath(tablePath, null);
}

/**
 * The page a moving item over tableVe would be in had it crossed the page to get there: the nearest page above the
 * table, if it can host the item spatially. A table page's popup is above the page it pops up from.
 */
function tableHostPageVeMaybe(tableVe: VisualElement): VisualElement | null {
  let ve = MouseActionState.readVisualElement(tableVe.parentPath);
  while (ve != null && !isPage(ve.displayItem)) {
    ve = MouseActionState.readVisualElement(ve.parentPath);
  }
  if (ve == null || isTableView(ve) || (ve.flags & VisualElementFlags.IsDock) || !pageCanHostLiveMovingItem(ve)) {
    return null;
  }
  return ve;
}

function moving_handleOverTable(
  store: StoreContextModel,
  overContainerVe: VisualElement,
  desktopPx: Vector,
  childContainerDropTargetPath: VisualElementPath | null,
) {
  assert(isTableView(overContainerVe), "overContainerVe is not a table view");
  const tablePath = VeFns.veToPath(overContainerVe);
  const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overContainerVe, desktopPx);
  store.perVe.setMoveOverRowNumber(tablePath, insertRow);
  store.perVe.setMoveOverChildContainerPath(tablePath, childContainerDropTargetPath);

  if (TableFns.tableAttachmentTargetAtRow(store, overContainerVe, insertRow) != null) {
    store.perVe.setMoveOverColAttachmentNumber(tablePath, attachmentPos);
  } else {
    store.perVe.setMoveOverColAttachmentNumber(tablePath, -1);
  }
}

function moving_handleOverComposite(store: StoreContextModel, overContainerVe: VisualElement, desktopPx: Vector, append: boolean) {
  assert(isComposite(overContainerVe.displayItem), "overContainerVe is not a composite");
  if (store.perItem.getCompositeIsCollapsed(VeFns.veidFromVe(overContainerVe))) {
    store.perVe.setMoveOverIndex(
      VeFns.veToPath(overContainerVe),
      asCompositeItem(overContainerVe.displayItem).computed_children.length,
    );
    return;
  }
  const activeItemId = MouseActionState.getActiveVisualElement()?.displayItem.id ?? null;
  const compositeChildren = VesCache.render.getChildren(VeFns.veToPath(overContainerVe))()
    .filter(childVe => childVe.get().displayItem.id !== activeItemId);
  const insertIndex = append
    ? compositeChildren.length
    : stackedInsertionIndexFromDesktopPx(
      store,
      compositeChildren.map(childVe => childVe.get()),
      desktopPx,
    );
  store.perVe.setMoveOverIndex(VeFns.veToPath(overContainerVe), insertIndex);
}


/**
 * With `copyOnly`, the item can be copied but not moved, like a chat attachment: its copy is added where it is dropped,
 * with its descendants, rather than now.
 */
function moving_activeItemToPage(store: StoreContextModel, moveToVe: VisualElement, desktopPx: Vector, relationshipToParent: string, shouldCreateLink: boolean, shouldClone: boolean, copyOnly: boolean = false): boolean {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return false;
  }
  const activeElement = activeSignal.get();
  const treeActiveItem = asPositionalItem(VeFns.treeItem(activeElement));
  moveToVe = resolveMoveTargetPageVe(moveToVe);
  const pendingCopy = copyOnly && shouldClone;
  if (pendingCopy ? !pageCanHostPendingCopy(moveToVe) : !pageCanHostLiveMovingItem(moveToVe)) {
    return false;
  }

  const moveToPage = asPageItem(moveToVe.displayItem);
  const clickOffsetProp = MouseActionState.getClickOffsetProp();
  const { activePosGr: newItemPosGr, startPosBl, moveToPageInnerSizeBl } = calculateMoveToPagePositionGr(
    store,
    moveToVe,
    desktopPx,
    treeActiveItem,
    relationshipToParent,
    clickOffsetProp,
  );
  const sourceParentId = treeActiveItem.parentId;
  MouseActionState.setStartPx(desktopPx);
  MouseActionState.setStartPosBl(startPosBl);
  const moveToPath = VeFns.veToPath(moveToVe);

  if (shouldClone && isPositionalItem(activeElement.displayItem)) {
    const toClone = activeElement.displayItem;
    const cloned = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(toClone), null));
    cloned.id = newUid();
    cloned.creationDate = currentUnixTimeSeconds();
    cloned.lastModifiedDate = currentUnixTimeSeconds();
    cloned.dateTime = currentUnixTimeSeconds();
    cloned.ordering = itemState.newOrderingAtEndOfChildren(moveToPage.id);
    cloned.spatialPositionGr = newItemPosGr;
    cloned.parentId = moveToPage.id;
    prepareShiftDragClone(cloned, toClone);
    keepChatAttachmentSource(toClone, cloned);
    addShiftDragClone(cloned, toClone, pendingCopy);

    const clonedVeid = VeFns.veidFromId(cloned.id);
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(clonedVeid, moveToPath));
    MouseActionState.setLinkCreatedOnMoveStart(false);


  } else if (shouldCreateLink && !isLink(activeElement.displayItem)) {
    const link = LinkFns.createFromItem(activeElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = newItemPosGr;
    if (activeElement.linkItemMaybe) {
      link.spatialWidthGr = activeElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null);
    const newLinkVeid = { itemId: activeElement.displayItem.id, linkIdMaybe: link.id };
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, moveToPath));
    MouseActionState.setLinkCreatedOnMoveStart(true);

  } else {
    preserveListSelectionWhenMovingSelectedChild(
      store,
      moveToVe,
      activeElement,
      moveRollbackOrderingForChild(movingChildIdFromVe(activeElement)),
    );

    if (relationshipToParent == RelationshipToParent.Attachment) {
      const oldActiveItemOrdering = treeActiveItem.ordering;
      const parent = asAttachmentsItem(itemState.get(treeActiveItem.parentId)!);
      const isLast = parent.computed_attachments[asAttachmentsItem(parent).computed_attachments.length - 1] == treeActiveItem.id;
      if (!isLast) {
        const placeholderItem = PlaceholderFns.create(treeActiveItem.ownerId, parent.id, RelationshipToParent.Attachment, oldActiveItemOrdering);
        itemState.add(placeholderItem);
        MouseActionState.setNewPlaceholderItem(placeholderItem);
      }
      MouseActionState.setStartAttachmentsItem(parent);
    }

    const movedGroupIds = relationshipToParent == RelationshipToParent.Child
      ? moveGroupToChildParentPreservingOffsets(
        MouseActionState.getGroupMoveItems(),
        VeFns.veidFromVe(activeElement),
        sourceParentId,
        moveToPage.id,
        newItemPosGr,
      )
      : [];

    if (movedGroupIds.length == 0) {
      treeActiveItem.spatialPositionGr = newItemPosGr;
      itemState.moveToNewParent(treeActiveItem, moveToPage.id, RelationshipToParent.Child);
    }

    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromVe(activeElement), moveToPath));
  }

  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / moveToVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToVe.childAreaBoundsPx!.h
  });

  MouseActionState.setScaleDefiningElementPath(moveToPath);
  return true;
}


function moving_activeItemOutOfTable(store: StoreContextModel, shouldCreateLink: boolean, shouldClone: boolean): boolean {
  const activeSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeSignal) {
    store.anItemIsMoving.set(false);
    return false;
  }
  const activeVisualElement = activeSignal.get();
  const tableVisualElement = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  const tableItem = asTableItem(tableVisualElement.displayItem);
  const tableBlockHeightPx = tableVisualElement.boundsPx.h / (tableItem.spatialHeightGr / GRID_SIZE);
  let itemPosInTablePx = getBoundingBoxTopLeft(activeVisualElement.boundsPx);
  itemPosInTablePx.y -= store.perItem.getTableScrollYPos(VeFns.veidFromVe(tableVisualElement)) * tableBlockHeightPx;
  const tableVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
  const tableParentVe = MouseActionState.readVisualElement(tableVe.parentPath)!;

  let moveToPage;
  let moveToPageVe;
  if (isPage(tableParentVe.displayItem)) {
    moveToPageVe = tableParentVe;
    moveToPage = asPageItem(tableParentVe.displayItem);
  } else if (isComposite(tableParentVe.displayItem)) {
    moveToPageVe = MouseActionState.readVisualElement(tableParentVe.parentPath)!;
    moveToPage = asPageItem(moveToPageVe.displayItem);
  } else {
    panic("unexpected table parent type: " + tableParentVe.displayItem.itemType);
  }

  const desktopPx = CursorEventState.getLatestDesktopPx(store);
  if (moveToPageVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
    return moving_activeItemToPage(store, moveToPageVe, desktopPx, RelationshipToParent.Child, shouldCreateLink, shouldClone);
  }

  const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToPageVe);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);

  const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);
  const itemPosInPagePx = {
    x: pagePx.x - moveToPageAbsoluteBoundsPx.x,
    y: pagePx.y - moveToPageAbsoluteBoundsPx.y
  };

  const itemPosInPageGr = {
    x: itemPosInPagePx.x / moveToPageAbsoluteBoundsPx.w * moveToPage.innerSpatialWidthGr,
    y: itemPosInPagePx.y / moveToPageAbsoluteBoundsPx.h * PageFns.calcInnerSpatialDimensionsBl(moveToPage).h * GRID_SIZE
  };

  const itemPosInPageQuantizedGr = {
    x: Math.round(itemPosInPageGr.x / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE,
    y: Math.round(itemPosInPageGr.y / (GRID_SIZE / 2.0)) / 2.0 * GRID_SIZE
  };

  if (shouldClone && isPositionalItem(activeVisualElement.displayItem)) {
    const toClone = activeVisualElement.displayItem;
    const cloned = asPositionalItem(ItemFns.fromObject(ItemFns.toObject(toClone), null));
    cloned.id = newUid();
    cloned.creationDate = currentUnixTimeSeconds();
    cloned.lastModifiedDate = currentUnixTimeSeconds();
    cloned.dateTime = currentUnixTimeSeconds();
    cloned.ordering = itemState.newOrderingAtEndOfChildren(moveToPage.id);
    cloned.spatialPositionGr = itemPosInPageQuantizedGr;
    cloned.parentId = moveToPage.id;
    prepareShiftDragClone(cloned, toClone);
    addShiftDragClone(cloned, toClone, false);

    const clonedVeid = VeFns.veidFromId(cloned.id);
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(clonedVeid, VeFns.veToPath(moveToPageVe)));
    MouseActionState.setLinkCreatedOnMoveStart(false);

  } else if (shouldCreateLink && !isLink(activeVisualElement.displayItem)) {
    const link = LinkFns.createFromItem(activeVisualElement.displayItem, moveToPage.id, RelationshipToParent.Child, itemState.newOrderingAtEndOfChildren(moveToPage.id));
    link.spatialPositionGr = itemPosInPageQuantizedGr;
    if (activeVisualElement.linkItemMaybe) {
      link.spatialWidthGr = activeVisualElement.linkItemMaybe.spatialWidthGr;
      link.spatialHeightGr = activeVisualElement.linkItemMaybe.spatialHeightGr;
    }
    itemState.add(link);
    server.addItem(link, null);
    MouseActionState.setClickOffsetProp({ x: 0.0, y: 0.0 });
    const newLinkVeid = { itemId: activeVisualElement.displayItem.id, linkIdMaybe: link.id };
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(newLinkVeid, VeFns.veToPath(moveToPageVe)));
    MouseActionState.setLinkCreatedOnMoveStart(true);

  } else {
    const movedGroupIds = moveGroupToChildParentPreservingOffsets(
      MouseActionState.getGroupMoveItems(),
      VeFns.veidFromVe(activeVisualElement),
      activeItem.parentId,
      moveToPage.id,
      itemPosInPageQuantizedGr,
    );
    if (movedGroupIds.length == 0) {
      activeItem.spatialPositionGr = itemPosInPageQuantizedGr;
      itemState.moveToNewParent(activeItem, moveToPage.id, RelationshipToParent.Child);
    }
    // Set active element to the moved item within the new page path
    MouseActionState.setActiveElementPath(VeFns.addVeidToPath(VeFns.veidFromVe(activeVisualElement), VeFns.veToPath(moveToPageVe)));
  }

  MouseActionState.setOnePxSizeBl({
    x: moveToPageInnerSizeBl.w / moveToPageVe.childAreaBoundsPx!.w,
    y: moveToPageInnerSizeBl.h / moveToPageVe.childAreaBoundsPx!.h
  });

  MouseActionState.setStartPosBl({ x: itemPosInPageQuantizedGr.x / GRID_SIZE, y: itemPosInPageQuantizedGr.y / GRID_SIZE });
  MouseActionState.setScaleDefiningElementPath(VeFns.veToPath(moveToPageVe));
  return true;
}


/**
 * Updates the insertion index (or calendar date) for the page the moving item is in. Also called directly
 * after the item enters a new page, so that a drop before the next mouse move doesn't use a stale index.
 */
function updatePageMoveOverIndex(
  store: StoreContextModel,
  inElementVe: VisualElement,
  desktopPosPx: Vector,
  hasValidMoveTarget: boolean,
  attachmentDropTargetIsActive: boolean,
  moveTargetIsDocumentComposite: boolean) {
  const inElement = inElementVe.displayItem;

  if (!hasValidMoveTarget || asPageItem(inElement).arrangeAlgorithm != ArrangeAlgorithm.Calendar) {
    store.movingItemTargetCalendarInfo.set(null);
  }

  if (hasValidMoveTarget && attachmentDropTargetIsActive &&
    (asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Grid || asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Justified)) {
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), -1);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Grid) {
    const numNonMovingChildren = VesCache.render.getNonMovingChildren(VeFns.veToPath(inElementVe))().length;
    const index = gridInsertionIndexFromDesktopPx(store, inElementVe, numNonMovingChildren, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), index);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Catalog) {
    const numNonMovingChildren = VesCache.render.getNonMovingChildren(VeFns.veToPath(inElementVe))().length;
    const moveOverIndex = catalogInsertionIndexFromDesktopPx(store, inElementVe, numNonMovingChildren, desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Justified) {
    setJustifiedMoveOverInsertion(store, inElementVe, desktopPosPx);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.List) {
    const band = PageFns.listPageMoveOverBand(store, inElementVe, desktopPosPx);
    store.perVe.setMoveOverListBand(VeFns.veToPath(inElementVe), band);
    const moveOverIndex = stackedInsertionIndexFromDesktopPx(store, PageFns.listPageInsertionRowVes(inElementVe, band), desktopPosPx);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), moveOverIndex);
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Document) {
    const inElementPath = VeFns.veToPath(inElementVe);
    if (attachmentDropTargetIsActive || moveTargetIsDocumentComposite) {
      store.perVe.setMoveOverIndex(inElementPath, -1);
    } else {
      const documentChildren = VesCache.render.getNonMovingChildren(inElementPath)()
        .map(childVe => childVe.get());
      const moveOverIndex = stackedInsertionIndexFromDesktopPx(store, documentChildren, desktopPosPx);
      store.perVe.setMoveOverIndex(inElementPath, moveOverIndex);
    }
  }

  else if (hasValidMoveTarget && asPageItem(inElement).arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
    const position = calculateCalendarPosition(desktopPosPx, inElementVe, store);
    const combinedIndex = encodeCalendarCombinedIndex(position.month, position.day);
    store.perVe.setMoveOverIndex(VeFns.veToPath(inElementVe), combinedIndex);
    store.movingItemTargetCalendarInfo.set({ pageItemId: inElement.id, combinedIndex, year: position.year });
  }
}

function setJustifiedMoveOverInsertion(store: StoreContextModel, inElementVe: VisualElement, desktopPosPx: Vector) {
  const inElementPath = VeFns.veToPath(inElementVe);
  const insertion = justifiedInsertionFromDesktopPx(store, inElementVe, desktopPosPx);
  store.perVe.setMoveOverIndex(inElementPath, insertion.index);
  store.perVe.setMoveOverIndexAndPosition(inElementPath, { index: insertion.index, position: insertion.afterPrevious ? 1 : 0 });
}
