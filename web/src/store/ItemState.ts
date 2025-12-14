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

import { GRID_SIZE } from "../constants";
import { AttachmentsItem, asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { ContainerItem, asContainerItem, isContainer } from "../items/base/container-item";
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { TabularFns } from "../items/base/tabular-item";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { asFlipCardItem, isFlipCard } from "../items/flipcard-item";
import { asLinkItem, isLink, LinkFns } from "../items/link-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns } from "../items/page-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { panic } from "../util/lang";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween, newOrderingDirectlyAfter } from "../util/ordering";
import { EMPTY_UID, Uid } from "../util/uid";
import { hashItemAndAttachmentsOnly } from "../items/item";

let items = new Map<Uid, Item>();


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
  },

  setItemFromServerObject: (itemObject: object, origin: string | null): void => {
    let item = ItemFns.fromObject(itemObject, origin);
    items.set(item.id, item);
    TabularFns.validateNumberOfVisibleColumnsMaybe(item.id);
  },

  /**
   * Replace an item only if it has changed (considering item and attachments, not children).
   * Returns true if the item was replaced, false if no changes were detected.
   */
  replaceMaybe: (itemObject: object, origin: string | null): boolean => {
    const newItem = ItemFns.fromObject(itemObject, origin);
    const existingItem = itemState.get(newItem.id);

    if (!existingItem) {
      items.set(newItem.id, newItem);
      TabularFns.validateNumberOfVisibleColumnsMaybe(newItem.id);
      return true;
    }

    const existingHash = hashItemAndAttachmentsOnly(newItem.id);

    // Temporarily set the new item to calculate its hash
    items.set(newItem.id, newItem);
    const newHash = hashItemAndAttachmentsOnly(newItem.id);

    if (existingHash === newHash) {
      // No changes detected, restore the existing item
      items.set(newItem.id, existingItem);
      return false;
    }

    // Changes detected, keep the new item
    TabularFns.validateNumberOfVisibleColumnsMaybe(newItem.id);
    return true;
  },

  addSoloItemHolderPage: (ownerId: Uid): void => {
    let holderPage = PageFns.soloItemHolderPage();
    holderPage.ownerId = ownerId;
    items.set(holderPage.id, holderPage);
  },

  sortChildren: (parentId: Uid): void => {
    const container = asContainerItem(itemState.get(parentId)!);
    if (container.orderChildrenBy == "" || (isPage(container) && asPageItem(container).arrangeAlgorithm == ArrangeAlgorithm.Document)) {
      container.computed_children.sort((a, b) => {
        const cmp = compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering);
        if (cmp !== 0) { return cmp; }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
    } else if (container.orderChildrenBy == "title[ASC]") {
      container.computed_children.sort((a, b) => {
        const aItemOriginal = itemState.get(a)!;
        const bItemOriginal = itemState.get(b)!;

        const aLinkTargetId = isLink(aItemOriginal) ? LinkFns.getLinkToId(asLinkItem(aItemOriginal)) : EMPTY_UID;
        const bLinkTargetId = isLink(bItemOriginal) ? LinkFns.getLinkToId(asLinkItem(bItemOriginal)) : EMPTY_UID;
        const aTarget = aLinkTargetId != EMPTY_UID ? itemState.get(aLinkTargetId) : null;
        const bTarget = bLinkTargetId != EMPTY_UID ? itemState.get(bLinkTargetId) : null;

        const aIsUnresolved = isLink(aItemOriginal) && (aTarget == null);
        const bIsUnresolved = isLink(bItemOriginal) && (bTarget == null);

        if (aIsUnresolved !== bIsUnresolved) { return aIsUnresolved ? 1 : -1; }

        const aForSort = aTarget ? aTarget : aItemOriginal;
        const bForSort = bTarget ? bTarget : bItemOriginal;

        const aTitle = isTitledItem(aForSort) ? asTitledItem(aForSort).title.toLocaleLowerCase() : "";
        const bTitle = isTitledItem(bForSort) ? asTitledItem(bForSort).title.toLocaleLowerCase() : "";
        const cmp = aTitle.localeCompare(bTitle);
        if (cmp !== 0) { return cmp; }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
    }
  },

  sortAttachments: (parentId: Uid): void => {
    const container = asAttachmentsItem(itemState.get(parentId)!);
    container.computed_attachments.sort((a, b) => {
      const cmp = compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering);
      if (cmp !== 0) { return cmp; }
      return a < b ? -1 : (a > b ? 1 : 0);
    });
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
    if (isFlipCard(parent)) {
      const parentFlipCardItem = asFlipCardItem(parent);
      childItems.forEach(childItem => {
        if (!isPage(childItem)) { panic(`flipcard ${parentId} child item ${childItem.id} is not a page.`); }
        const childPageItem = asPageItem(childItem);
        childPageItem.innerSpatialWidthGr = Math.round(parentFlipCardItem.spatialWidthGr / parentFlipCardItem.scale / GRID_SIZE) * GRID_SIZE;
        childPageItem.naturalAspect = parentFlipCardItem.naturalAspect;
      });
    }
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
    itemState.sortAttachments(parentId);
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
      return newOrderingBetween(childrenOrderings[position-1], childrenOrderings[position]);
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
      return newOrderingBetween(attachmentOrderings[position-1], attachmentOrderings[position]);
    }
  },

  moveToNewParent: (item: Item, moveToParentId: Uid, newRelationshipToParent: string, ordering?: Uint8Array) => {
    const prevParentId = item.parentId;
    const prevRelationshipToParent = item.relationshipToParent;
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
      }
    }
  },

  debugLog: (): void => {
    console.debug("--- start item state list");
    for (let v of items) { console.debug("id: " + v[0] + ", pid: " + v[1].parentId); }
    console.debug("--- end item state list");
  },
}
