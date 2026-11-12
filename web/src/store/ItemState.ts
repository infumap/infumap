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

import { AttachmentsItem, asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../items/base/container-item";
import { asDataItem, isDataItem } from "../items/base/data-item";
import { Item, PinnedTo } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { TabularFns } from "../items/base/tabular-item";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { SortValue, compareSortValues, parseSortOrder, textSortValue } from "../items/base/sort-order";
import { asImageItem, isImage } from "../items/image-item";
import { asLinkItem, isLink, LinkFns } from "../items/link-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns } from "../items/page-item";
import { isPlaceholder } from "../items/placeholder-item";
import { asRatingItem, isRating } from "../items/rating-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { panic } from "../util/lang";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween, newOrderingDirectlyAfter } from "../util/ordering";
import { EMPTY_UID, Uid } from "../util/uid";

let items = new Map<Uid, Item>();
let sortPositionHold: { itemId: Uid, afterId: Uid | null } | null = null;
let preserveUnsavedTextFields: (item: Item) => void = () => {};

export function setUnsavedTextFieldsRestorer(restorer: (item: Item) => void): void {
  preserveUnsavedTextFields = restorer;
}

/**
 * Preserve pending popup position fields from an existing item to a new item.
 * These fields are client-only and not saved to server, so they must be preserved
 * when an item is refreshed from the server during periodic sync.
 */
function preservePendingPopupFields(existingItem: Item, newItem: Item): void {
  if (isImage(existingItem) && isImage(newItem)) {
    const existingImage = asImageItem(existingItem);
    const newImage = asImageItem(newItem);
    newImage.pendingPopupPositionGr = existingImage.pendingPopupPositionGr;
    newImage.pendingPopupWidthGr = existingImage.pendingPopupWidthGr;
    newImage.pendingCellPopupPositionNorm = existingImage.pendingCellPopupPositionNorm;
    newImage.pendingCellPopupWidthNorm = existingImage.pendingCellPopupWidthNorm;
  } else if (isPage(existingItem) && isPage(newItem)) {
    const existingPage = asPageItem(existingItem);
    const newPage = asPageItem(newItem);
    newPage.pendingPopupPositionGr = existingPage.pendingPopupPositionGr;
    newPage.pendingPopupWidthGr = existingPage.pendingPopupWidthGr;
    newPage.pendingCellPopupPositionNorm = existingPage.pendingCellPopupPositionNorm;
    newPage.pendingCellPopupWidthNorm = existingPage.pendingCellPopupWidthNorm;
  }
}

function preserveComputedRelationshipFields(existingItem: Item, newItem: Item): void {
  if (isContainer(existingItem) && isContainer(newItem)) {
    const existingContainer = asContainerItem(existingItem);
    const newContainer = asContainerItem(newItem);
    newContainer.childrenLoaded = existingContainer.childrenLoaded;
    newContainer.computed_children = [...existingContainer.computed_children];
  }
  if (isAttachmentsItem(existingItem) && isAttachmentsItem(newItem)) {
    const existingAttachmentsItem = asAttachmentsItem(existingItem);
    const newAttachmentsItem = asAttachmentsItem(newItem);
    newAttachmentsItem.computed_attachments = [...existingAttachmentsItem.computed_attachments];
  }
}

function removeRelationshipSubtreeIfCurrent(
  id: Uid,
  expectedParentId: Uid,
  expectedRelationshipToParent: RelationshipToParent,
): void {
  const item = items.get(id);
  if (!item) {
    return;
  }
  if (item.parentId != expectedParentId || item.relationshipToParent != expectedRelationshipToParent) {
    return;
  }

  if (isContainer(item)) {
    for (const childId of [...asContainerItem(item).computed_children]) {
      removeRelationshipSubtreeIfCurrent(childId, item.id, RelationshipToParent.Child);
    }
  }
  if (isAttachmentsItem(item)) {
    for (const attachmentId of [...asAttachmentsItem(item).computed_attachments]) {
      removeRelationshipSubtreeIfCurrent(attachmentId, item.id, RelationshipToParent.Attachment);
    }
  }

  items.delete(id);
}

export function wouldCreateRelationshipCycle(itemId: Uid, moveToParentId: Uid): boolean {
  if (itemId == moveToParentId) {
    return true;
  }

  const seen = new Set<Uid | null>();
  let currentId: Uid | null = moveToParentId;
  while (currentId != null && currentId != EMPTY_UID && !seen.has(currentId)) {
    if (currentId == itemId) {
      return true;
    }
    seen.add(currentId);
    const currentItem = items.get(currentId);
    if (!currentItem) {
      return false;
    }
    currentId = currentItem.parentId as Uid | null;
  }

  return false;
}


/** Whether orderChildrenBy sorts the children, rather than leaving them in the order of their orderings. */
function isSortedOrder(orderChildrenBy: string | null): boolean {
  return parseSortOrder(orderChildrenBy) != null;
}

function sortAttachmentsOnly(parentId: Uid): void {
  const container = asAttachmentsItem(itemState.get(parentId)!);
  container.computed_attachments.sort((a, b) => {
    const cmp = compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering);
    if (cmp !== 0) { return cmp; }
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

/**
 * Re-sort the container of a row whose attachments (its cells) changed, if it's sorted by a column. Unlike a change of
 * value (sortParentChildrenIfSorted), links to the row elsewhere aren't re-sorted: finding them means searching every
 * item, and this runs for every attachment added, moved or removed.
 */
function sortRowContainerIfSortedByColumn(rowId: Uid): void {
  const row = items.get(rowId);
  if (row == null || row.relationshipToParent != RelationshipToParent.Child) { return; }
  const container = items.get(row.parentId);
  if (container == null || !isContainer(container)) { return; }
  const order = parseSortOrder(asContainerItem(container).orderChildrenBy);
  if (order != null && order.col > 0) { itemState.sortChildren(container.id); }
}

/** What item is sorted as: itself, or the target of a link. null for a link whose target isn't loaded. */
function resolveForSort(item: Item | null): Item | null {
  if (item == null || !isLink(item)) { return item; }
  const targetId = LinkFns.getLinkToId(asLinkItem(item));
  return targetId == EMPTY_UID ? null : itemState.get(targetId) ?? null;
}

/**
 * The item in column col of a table row: the row's item for column 0, its attachment col - 1 after that, as a table
 * shows them. null where the cell is empty.
 */
function sortCell(row: Item, col: number): Item | null {
  if (col == 0) { return row; }
  if (!isAttachmentsItem(row)) { return null; }
  const attachmentIds = asAttachmentsItem(row).computed_attachments;
  if (col > attachmentIds.length) { return null; }
  const cell = resolveForSort(itemState.get(attachmentIds[col - 1]));
  return cell == null || isPlaceholder(cell) ? null : cell;
}

/**
 * What item shows, as it is sorted by value. A password's text is secret, so it has no value. Nor do items that show
 * nothing (dividers, placeholders).
 */
function itemSortValue(item: Item | null): SortValue {
  if (item == null) { return null; }
  if (isRating(item)) { return { number: asRatingItem(item).rating }; }
  if (isTitledItem(item)) { return textSortValue(asTitledItem(item).title); }
  return null;
}

/**
 * The type children sorted by type are grouped by. Files, images and text are grouped by format, not item type, so a
 * CR2 that is still a file sits with the CR2 images. Their mime types are normalized on the server, so a format has one.
 * The other items (pages, tables, notes...) come first, as folders do in a file manager.
 */
function typeSortKey(item: Item): string {
  return isDataItem(item) ? "1" + asDataItem(item).mimeType : "0" + item.itemType;
}


export const itemState = {

  /**
   * Re-initialize - clears all items data.
   */
  clear: (): void => {
    items = new Map<Uid, Item>();
  },

  get: (id: Uid): Item | null => {
    const v = items.get(id);
    if (v) { return v; }
    return null;
  },

  getAsContainerItem: (id: Uid): ContainerItem | null => {
    const item = itemState.get(id);
    if (item == null) { return null; }
    return asContainerItem(item);
  },

  getAsAttachmentsItem: (id: Uid): AttachmentsItem | null => {
    const item = itemState.get(id);
    if (item == null) { return null; }
    return asAttachmentsItem(item);
  },

  delete: (id: Uid): void => {
    const item = itemState.get(id)!;
    if (item.parentId == EMPTY_UID) {
      panic!("delete: parent is empty.");
    }
    if (isContainer(item)) {
      const containerItem = asContainerItem(item);
      if (containerItem.computed_children.length > 0) {
        console.error(
          `${containerItem.itemType} container has children, can't delete:`,
          [...containerItem.computed_children],
          containerItem.computed_children.map(i => { const itm = itemState.get(i)!; return (isTitledItem(itm)) ? asTitledItem(itm).title : "no-title" }));
        panic!("can't delete container with children.");
      }
    }
    const parentItem = itemState.get(item.parentId)!;
    if (item.relationshipToParent == RelationshipToParent.Child) {
      const containerParentItem = asContainerItem(parentItem);
      containerParentItem.computed_children
        = containerParentItem.computed_children.filter(cid => cid != id);
    } else if (item.relationshipToParent == RelationshipToParent.Attachment) {
      const attachmentsParentItem = asAttachmentsItem(parentItem);
      attachmentsParentItem.computed_attachments
        = attachmentsParentItem.computed_attachments.filter(aid => aid != id);
    } else {
      panic("delete: unexpected relationshipToParent.");
    }
    items.delete(id);
    if (item.relationshipToParent == RelationshipToParent.Attachment) { sortRowContainerIfSortedByColumn(parentItem.id); }
  },

  /** Remove server-deleted items and any loaded parent references to them. */
  removeDeletedItems: (ids: Array<Uid>): void => {
    const deletedIds = new Set(ids);
    for (const item of items.values()) {
      if (isContainer(item)) {
        const container = asContainerItem(item);
        container.computed_children = container.computed_children.filter(id => !deletedIds.has(id));
      }
      if (isAttachmentsItem(item)) {
        const attachments = asAttachmentsItem(item);
        attachments.computed_attachments = attachments.computed_attachments.filter(id => !deletedIds.has(id));
      }
    }
    for (const id of deletedIds) {
      items.delete(id);
    }
  },

  setItemFromServerObject: (itemObject: object, origin: string | null): void => {
    itemState.upsertItemFromServerObject(itemObject, origin);
  },

  upsertItemFromServerObject: (itemObject: object, origin: string | null): Item => {
    const newItem = ItemFns.fromObject(itemObject, origin);
    if ((itemObject as { clientOnly?: unknown }).clientOnly === true) {
      newItem.clientOnly = true;
    }
    const existingItem = items.get(newItem.id);
    if (existingItem) {
      preservePendingPopupFields(existingItem, newItem);
      preserveComputedRelationshipFields(existingItem, newItem);
    }
    preserveUnsavedTextFields(newItem);
    items.set(newItem.id, newItem);
    // A changed pin moves the item between the bands of a sorted list page.
    if (existingItem && existingItem.pinnedTo != newItem.pinnedTo &&
      newItem.relationshipToParent == RelationshipToParent.Child && items.get(newItem.parentId) != null) {
      itemState.sortChildren(newItem.parentId);
    }
    TabularFns.validateNumberOfVisibleColumnsMaybe(newItem.id);
    return newItem;
  },

  pruneRelationshipSubtreeIfCurrent: (
    id: Uid,
    expectedParentId: Uid,
    expectedRelationshipToParent: RelationshipToParent,
  ): void => {
    removeRelationshipSubtreeIfCurrent(id, expectedParentId, expectedRelationshipToParent);
  },

  addSoloItemHolderPage: (ownerId: Uid): void => {
    let holderPage = PageFns.soloItemHolderPage();
    holderPage.ownerId = ownerId;
    items.set(holderPage.id, holderPage);
  },

  /** Whether the children of a container are in the order of their orderings, rather than sorted. */
  childrenAreInOrderingOrder: (parentId: Uid): boolean => {
    const container = asContainerItem(itemState.get(parentId)!);
    if (parseSortOrder(container.orderChildrenBy) == null) { return true; }
    if (!isPage(container)) { return false; }
    // Spatial child order is z-order, which bring to front / send to back and item creation control via
    // `ordering`. New pages default to value[ASC] and the sort control is hidden for spatial pages, so
    // honoring orderChildrenBy here silently stacked items by title. It's kept for when the page is
    // switched to a sortable arrangement.
    const arrangeAlgorithm = asPageItem(container).arrangeAlgorithm;
    return arrangeAlgorithm == ArrangeAlgorithm.Document || arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch;
  },

  sortChildren: (parentId: Uid): void => {
    const container = asContainerItem(itemState.get(parentId)!);
    if (itemState.childrenAreInOrderingOrder(parentId)) {
      container.computed_children.sort((a, b) => {
        const cmp = compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering);
        if (cmp !== 0) { return cmp; }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
    } else {
      const order = parseSortOrder(container.orderChildrenBy)!;
      // The sort order is for the children that aren't pinned. The pinned ones are in the top and bottom bands of a
      // list page, in the order the user put them (their ordering). Elsewhere pins mean nothing, so are ignored: a
      // grid sorted by title stays sorted by title.
      const pinsApply = isPage(container) && asPageItem(container).arrangeAlgorithm == ArrangeAlgorithm.List;
      const bandRank = (item: Item): number =>
        !pinsApply || item.pinnedTo == null ? 1 : item.pinnedTo == PinnedTo.Top ? 0 : 2;
      const keys = new Map(container.computed_children.map(id => {
        const child = itemState.get(id)!;
        const row = resolveForSort(child);
        const cell = row == null ? null : sortCell(row, order.col);
        return [id, {
          band: bandRank(child),
          ordering: child.ordering,
          // Unresolved links are last, whatever the order: they have nothing to sort by.
          unresolved: row == null,
          type: order.key == "type" && cell != null ? typeSortKey(cell) : null,
          value: itemSortValue(cell),
          // Rows with the same value in the sorted column are in the order of their own values.
          rowValue: order.col > 0 ? itemSortValue(row) : null,
        }];
      }));
      container.computed_children.sort((a, b) => {
        const aKey = keys.get(a)!;
        const bKey = keys.get(b)!;
        if (aKey.band != bKey.band) { return aKey.band - bKey.band; }
        if (aKey.band != 1) {
          const cmp = compareOrderings(aKey.ordering, bKey.ordering);
          if (cmp !== 0) { return cmp; }
          return a < b ? -1 : (a > b ? 1 : 0);
        }
        if (aKey.unresolved != bKey.unresolved) { return aKey.unresolved ? 1 : -1; }
        if (order.key == "type" && aKey.type != bKey.type) {
          // A missing cell has no type, and is last, as an empty value is.
          if (aKey.type == null || bKey.type == null) { return aKey.type == null ? 1 : -1; }
          return (aKey.type < bKey.type) != order.descending ? -1 : 1;
        }
        let cmp = compareSortValues(aKey.value, bKey.value, order.descending);
        if (cmp == 0) { cmp = compareSortValues(aKey.rowValue, bKey.rowValue, false); }
        if (cmp != 0) { return cmp; }
        return a < b ? -1 : (a > b ? 1 : 0);
      });

      const heldIdx = sortPositionHold == null ? -1 : container.computed_children.indexOf(sortPositionHold.itemId);
      if (heldIdx >= 0) {
        const children = container.computed_children;
        const heldItem = itemState.get(children[heldIdx])!;
        children.splice(heldIdx, 1);
        const afterIdx = sortPositionHold!.afterId == null ? -1 : children.indexOf(sortPositionHold!.afterId);
        // It stays in its band. The item it was created after may be in another, or gone.
        const band = bandRank(heldItem);
        let bandStart = children.findIndex(id => bandRank(itemState.get(id)!) >= band);
        if (bandStart < 0) { bandStart = children.length; }
        let bandEnd = children.findIndex(id => bandRank(itemState.get(id)!) > band);
        if (bandEnd < 0) { bandEnd = children.length; }
        children.splice(Math.max(bandStart, Math.min(afterIdx + 1, bandEnd)), 0, heldItem.id);
      }
    }
  },

  /**
   * Keep itemId directly after afterId (or first, if null) among its siblings in a sorted container, rather than where
   * it sorts, until the hold is released. A new item is created with an empty title, which sorts it to one end. Held,
   * it appears where it was created (under the mouse) while its title is entered, and moves when the edit ends.
   */
  holdSortPosition: (itemId: Uid, afterId: Uid | null): void => {
    sortPositionHold = { itemId, afterId };
  },

  /** Release the hold on the sort position of itemId, if any. */
  releaseSortPositionHold: (itemId: Uid): void => {
    if (sortPositionHold?.itemId == itemId) { sortPositionHold = null; }
  },

  /**
   * Re-sort the sorted container(s) whose order depends on the value of item: its own parent, and the parents of any
   * loaded links that resolve to it (links sort by their target's value). Value is also the order within a type. An
   * attachment is a cell of its parent's row in a table, so the same goes for its parent.
   */
  sortParentChildrenIfSorted: (item: Item): void => {
    if (item.relationshipToParent == RelationshipToParent.Attachment) {
      const row = itemState.get(item.parentId);
      if (row != null) { itemState.sortParentChildrenIfSorted(row); }
    }

    const sortIfSorted = (child: Item) => {
      if (child.relationshipToParent != RelationshipToParent.Child) { return; }
      const parentItem = itemState.get(child.parentId);
      if (!parentItem || !isContainer(parentItem)) { return; }
      const parentContainer = asContainerItem(parentItem);
      if (isSortedOrder(parentContainer.orderChildrenBy)) {
        itemState.sortChildren(parentContainer.id);
      }
    };

    sortIfSorted(item);
    if (isLink(item)) { return; }
    for (const candidate of items.values()) {
      if (isLink(candidate) && LinkFns.getLinkToId(asLinkItem(candidate)) == item.id) {
        sortIfSorted(candidate);
      }
    }
  },

  /** Sort the attachments of an item, its cells in a table row, and so re-sort a table sorted by a column it is in. */
  sortAttachments: (parentId: Uid): void => {
    sortAttachmentsOnly(parentId);
    sortRowContainerIfSortedByColumn(parentId);
  },

  /**
   * Set all the child items of a container.
   *
   * @param parentId The id of the parent to set child items of.
   * @param childItems The child items.
   */
  setChildItemsFromServerObjects: (parentId: Uid, childItemObjects: Array<object>, origin: string | null): void => {
    let childItems = childItemObjects.map(cio => ItemFns.fromObject(cio, origin));
    childItems.forEach(childItem => {
      if (!items.has(childItem.id)) {
        // item may have already been loaded (including children, and will be flagged as such).
        items.set(childItem.id, childItem);
        TabularFns.validateNumberOfVisibleColumnsMaybe(childItem.id);
      }
    });
    if (!isContainer(itemState.get(parentId)!)) {
      throw new Error(`Cannot set ${childItems.length} child items of parent '${parentId}' because it is not a container.`);
    }
    const parent = itemState.getAsContainerItem(parentId)!;
    let children: Array<Uid> = [];
    childItems.forEach(childItem => {
      if (childItem.parentId == EMPTY_UID) { panic("setChildItemsFromServerObjects: parent is empty."); }
      if (childItem.parentId != parentId) {
        throw new Error(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
      }
      if (childItem.relationshipToParent != RelationshipToParent.Child) {
        throw new Error(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
      }
      children.push(childItem.id);
    });
    const childrenToAdd = children.filter(id => !parent.computed_children.includes(id));
    parent.computed_children = [...parent.computed_children, ...childrenToAdd];
    itemState.sortChildren(parentId);
  },

  setAttachmentItemsFromServerObjects: (parentId: Uid, attachmentItemObject: Array<object>, origin: string | null): void => {
    let attachmentItems = attachmentItemObject.map(aio => ItemFns.fromObject(aio, origin));
    if (!isAttachmentsItem(itemState.get(parentId)!)) {
      throw new Error(`Cannot attach ${attachmentItems.length} items to parent '${parentId}' because it has type '${itemState.get(parentId)!.itemType}' which does not allow attachments.`);
    }
    const parent = itemState.getAsAttachmentsItem(parentId)!;
    let attachments: Array<Uid> = [];
    attachmentItems.forEach(attachmentItem => {
      const existingItem = items.get(attachmentItem.id);
      if (existingItem) {
        preservePendingPopupFields(existingItem, attachmentItem);
      }
      items.set(attachmentItem.id, attachmentItem);
      if (attachmentItem.parentId != parentId) {
        throw new Error(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
      }
      if (attachmentItem.relationshipToParent != RelationshipToParent.Attachment) {
        throw new Error(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
      }
      attachments.push(attachmentItem.id);
    });
    const attachmentsToAdd = attachments.filter(id => !parent.computed_attachments.includes(id));
    parent.computed_attachments = [...parent.computed_attachments, ...attachmentsToAdd];
    // A load sorts the container of the rows once all their attachments are in, not once for each row.
    sortAttachmentsOnly(parentId);
  },

  applyAttachmentItemsSnapshotFromServerObjects: (parentId: Uid, attachmentItemObjects: Array<object>, origin: string | null): void => {
    if (!isAttachmentsItem(itemState.get(parentId)!)) {
      throw new Error(`Cannot attach ${attachmentItemObjects.length} items to parent '${parentId}' because it has type '${itemState.get(parentId)!.itemType}' which does not allow attachments.`);
    }

    const parent = itemState.getAsAttachmentsItem(parentId)!;
    const existingAttachmentIds = new Set(parent.computed_attachments);
    const nextAttachmentIds: Array<Uid> = [];

    for (const attachmentItemObject of attachmentItemObjects) {
      const attachmentItem = itemState.upsertItemFromServerObject(attachmentItemObject, origin);
      if (attachmentItem.parentId != parentId) {
        throw new Error(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
      }
      if (attachmentItem.relationshipToParent != RelationshipToParent.Attachment) {
        throw new Error(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
      }
      nextAttachmentIds.push(attachmentItem.id);
      existingAttachmentIds.delete(attachmentItem.id);
    }

    parent.computed_attachments = nextAttachmentIds;
    // A load sorts the container of the rows once all their attachments are in, not once for each row.
    sortAttachmentsOnly(parentId);

    for (const removedAttachmentId of existingAttachmentIds) {
      removeRelationshipSubtreeIfCurrent(removedAttachmentId, parentId, RelationshipToParent.Attachment);
    }
  },

  applyContainerSnapshotFromServerObjects: (
    parentId: Uid,
    childItemObjects: Array<object>,
    attachmentItemsByParentId: { [id: string]: Array<object> },
    origin: string | null,
  ): void => {
    if (!isContainer(itemState.get(parentId)!)) {
      throw new Error(`Cannot set ${childItemObjects.length} child items of parent '${parentId}' because it is not a container.`);
    }

    const parent = itemState.getAsContainerItem(parentId)!;
    const existingChildIds = new Set(parent.computed_children);
    const nextChildIds: Array<Uid> = [];

    for (const childItemObject of childItemObjects) {
      const childItem = itemState.upsertItemFromServerObject(childItemObject, origin);
      if (childItem.parentId == EMPTY_UID) {
        panic("applyContainerSnapshotFromServerObjects: parent is empty.");
      }
      if (childItem.parentId != parentId) {
        throw new Error(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
      }
      if (childItem.relationshipToParent != RelationshipToParent.Child) {
        throw new Error(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
      }
      nextChildIds.push(childItem.id);
      existingChildIds.delete(childItem.id);

      if (isAttachmentsItem(childItem)) {
        itemState.applyAttachmentItemsSnapshotFromServerObjects(childItem.id, attachmentItemsByParentId[childItem.id] ?? [], origin);
      }
    }

    parent.computed_children = nextChildIds;
    itemState.sortChildren(parentId);

    for (const removedChildId of existingChildIds) {
      const removedChild = itemState.get(removedChildId);
      if (removedChild?.clientOnly === true &&
        removedChild.parentId == parentId &&
        removedChild.relationshipToParent == RelationshipToParent.Child) {
        if (!parent.computed_children.includes(removedChildId)) {
          parent.computed_children = [...parent.computed_children, removedChildId];
        }
        continue;
      }
      removeRelationshipSubtreeIfCurrent(removedChildId, parentId, RelationshipToParent.Child);
    }

    itemState.sortChildren(parentId);

    TabularFns.validateNumberOfVisibleColumnsMaybe(parentId);
  },

  add: (item: Item): void => {
    items.set(item.id, item);
    if (item.relationshipToParent == RelationshipToParent.Child) {
      const parentItem = itemState.getAsContainerItem(item.parentId)!;
      parentItem.computed_children = [...parentItem.computed_children, item.id];
      itemState.sortChildren(parentItem.id);
    } else if (item.relationshipToParent == RelationshipToParent.Attachment) {
      const parentItem = itemState.getAsAttachmentsItem(item.parentId)!;
      parentItem.computed_attachments = [...parentItem.computed_attachments, item.id];
      itemState.sortAttachments(parentItem.id);
    } else {
      panic(`unsupported relationship to parent: ${item.relationshipToParent}.`);
    }
  },

  newOrderingAtBeginningOfChildren: (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items.get(parentId)!);
    let childrenOrderings = parent.computed_children.map(c => items.get(c)!.ordering);
    return newOrderingAtBeginning(childrenOrderings);
  },

  newOrderingAtEndOfChildren: (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items.get(parentId)!);
    let childrenOrderings = parent.computed_children.map(c => items.get(c)!.ordering);
    return newOrderingAtEnd(childrenOrderings);
  },

  newOrderingAtEndOfAttachments: (parentId: Uid): Uint8Array => {
    let parent = asAttachmentsItem(items.get(parentId)!);
    let attachmentOrderings = parent.computed_attachments.map(c => items.get(c)!.ordering);
    return newOrderingAtEnd(attachmentOrderings);
  },

  newOrderingDirectlyAfterChild: (parentId: Uid, childId: Uid) => {
    const parent = asContainerItem(items.get(parentId)!);
    const child = items.get(childId)!;
    const childrenOrderings = parent.computed_children.map(c => items.get(c)!.ordering);
    return newOrderingDirectlyAfter(childrenOrderings, child.ordering);
  },

  newOrderingAtChildrenPosition: (parentId: Uid, position: number, ignoreUid: Uid | null): Uint8Array => {
    let parent = asContainerItem(items.get(parentId)!);
    let filteredChildren = parent.computed_children.filter(i => i != ignoreUid);
    let childrenOrderings: Uint8Array[] = [];
    for (let i = 0; i < filteredChildren.length; i++) {
      const childId = filteredChildren[i];
      const child = items.get(childId);
      if (!child) {
        console.error("[ORDERING_BUG] Child not in items map:", { parentId, position, ignoreUid, childId, index: i, filteredChildren: [...filteredChildren] });
        panic(`newOrderingAtChildrenPosition: child ${childId} not found in items map`);
      }
      if (!child.ordering) {
        console.error("[ORDERING_BUG] Child has no ordering:", { parentId, position, ignoreUid, childId, index: i, childType: child.itemType, childParentId: child.parentId });
        panic(`newOrderingAtChildrenPosition: child ${childId} has undefined ordering`);
      }
      childrenOrderings.push(child.ordering);
    }
    if (position <= 0) {
      return newOrderingAtBeginning(childrenOrderings);
    } else if (position >= childrenOrderings.length) {
      return newOrderingAtEnd(childrenOrderings);
    } else {
      return newOrderingBetween(childrenOrderings[position - 1], childrenOrderings[position]);
    }
  },

  newOrderingAtAttachmentsPosition: (parentId: Uid, position: number): Uint8Array => {
    let parent = asAttachmentsItem(items.get(parentId)!);
    let attachmentOrderings = parent.computed_attachments.map(c => items.get(c)!.ordering);
    if (position <= 0) {
      return newOrderingAtBeginning(attachmentOrderings);
    } else if (position >= attachmentOrderings.length) {
      return newOrderingAtEnd(attachmentOrderings);
    } else {
      return newOrderingBetween(attachmentOrderings[position - 1], attachmentOrderings[position]);
    }
  },

  /**
   * The item's groupId is cleared if it leaves its parent, unless keepGroupId is set (because its
   * entire group is moving with it) and it remains a child of a page. Its pinnedTo is always cleared if it
   * leaves its parent: a caller pinning it in the new parent sets it again.
   */
  moveToNewParent: (item: Item, moveToParentId: Uid, newRelationshipToParent: string, ordering?: Uint8Array, keepGroupId: boolean = false) => {
    if (wouldCreateRelationshipCycle(item.id, moveToParentId)) {
      console.error("moveToNewParent: refusing to create relationship cycle", {
        itemId: item.id,
        moveToParentId,
        newRelationshipToParent,
      });
      panic(`moveToNewParent: attempted to create a relationship cycle for item '${item.id}'.`);
    }

    const prevParentId = item.parentId;
    const prevRelationshipToParent = item.relationshipToParent;
    const groupIdCanBeKept = keepGroupId &&
      newRelationshipToParent == RelationshipToParent.Child &&
      isPage(itemState.get(moveToParentId));
    if ((newRelationshipToParent != RelationshipToParent.Child || prevParentId != moveToParentId) && !groupIdCanBeKept) {
      item.groupId = null;
    }
    if (newRelationshipToParent != RelationshipToParent.Child || prevParentId != moveToParentId) {
      item.pinnedTo = null;
    }
    if (ordering) {
      item.ordering = ordering;
    } else {
      if (newRelationshipToParent == RelationshipToParent.Child) {
        item.ordering = itemState.newOrderingAtEndOfChildren(moveToParentId);
      } else if (newRelationshipToParent == RelationshipToParent.Attachment) {
        item.ordering = itemState.newOrderingAtEndOfAttachments(moveToParentId);
      }
    }
    item.parentId = moveToParentId;
    item.relationshipToParent = newRelationshipToParent;
    if (newRelationshipToParent == RelationshipToParent.Child) {
      const moveOverContainer = itemState.getAsContainerItem(moveToParentId)!;
      const moveOverContainerChildren = [item.id, ...moveOverContainer.computed_children];
      moveOverContainer.computed_children = moveOverContainerChildren;
      itemState.sortChildren(moveOverContainer.id);
      updatePrevParent();
    } else if (newRelationshipToParent == RelationshipToParent.Attachment) {
      const moveOverAttachmentsItem = itemState.getAsAttachmentsItem(moveToParentId)!;
      const moveOverAttachments = [item.id, ...moveOverAttachmentsItem.computed_attachments];
      moveOverAttachmentsItem.computed_attachments = moveOverAttachments;
      itemState.sortAttachments(moveOverAttachmentsItem.id);
      updatePrevParent();
    } else {
      panic("moveToNewParent: unexpected relationship to parent.");
    }
    function updatePrevParent() {
      if (prevRelationshipToParent == RelationshipToParent.Child) {
        const prevParent = itemState.getAsContainerItem(prevParentId)!;
        prevParent.computed_children = prevParent.computed_children.filter(i => i != item.id);
      } else if (prevRelationshipToParent == RelationshipToParent.Attachment) {
        const prevParent = itemState.getAsAttachmentsItem(prevParentId)!;
        prevParent.computed_attachments = prevParent.computed_attachments.filter(i => i != item.id);
        sortRowContainerIfSortedByColumn(prevParentId);
      }
    }
  },

  debugLog: (): void => {
    console.debug("--- start item state list");
    for (let v of items) { console.debug("id: " + v[0] + ", pid: " + v[1].parentId); }
    console.debug("--- end item state list");
  },
}
