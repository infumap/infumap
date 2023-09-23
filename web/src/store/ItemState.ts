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
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { panic, throwExpression } from "../util/lang";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween, newOrderingDirectlyAfter } from "../util/ordering";
import { EMPTY_UID, Uid } from "../util/uid";

let items = new Map<Uid, Item>();


export const itemState = {
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
      panic!();
    }
    if (isContainer(item)) {
      const containerItem = asContainerItem(item);
      if (containerItem.computed_children.length > 0) {
        console.error(
          `${containerItem.itemType} container has children, can't delete:`, 
          [...containerItem.computed_children],
          containerItem.computed_children.map(i => { const itm = itemState.get(i)!; return (isTitledItem(itm)) ? asTitledItem(itm).title : "no-title" }));
        panic!();
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
      panic();
    }
    items.delete(id);
  },

  setItemFromServerObject: (itemObject: object): void => {
    let item = ItemFns.fromObject(itemObject);
    items.set(item.id, item);
  },

  sortChildren: (parentId: Uid): void => {
    const container = asContainerItem(itemState.get(parentId)!);
    if (container.orderChildrenBy == "") {
      container.computed_children.sort((a, b) => compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering));
    } else if (container.orderChildrenBy == "title[ASC]") {
      container.computed_children.sort((a, b) => {
        let aTitle = "";
        const aItem = itemState.get(a)!
        if (isTitledItem(aItem)) { aTitle = asTitledItem(aItem).title; }
        aTitle.toLocaleLowerCase();
        let bTitle = "";
        const bItem = itemState.get(b)!
        if (isTitledItem(bItem)) { bTitle = asTitledItem(bItem).title; }
        bTitle.toLocaleLowerCase();
        return aTitle.localeCompare(bTitle);
      });
    }
  },

  sortAttachments: (parentId: Uid): void => {
    const container = asAttachmentsItem(itemState.get(parentId)!);
    container.computed_attachments.sort((a, b) => compareOrderings(itemState.get(a)!.ordering, itemState.get(b)!.ordering));
  },

  /**
   * Set all the child items of a container.
   * Special Case (for efficiency): If the container is the root page, then the child items list contains
   *  the root page item as well.
   *
   * @param parentId The id of the parent to set child items of.
   * @param childItems The child items.
   */
  setChildItemsFromServerObjects: (parentId: Uid, childItemObjects: Array<object>): void => {
    let childItems = childItemObjects.map(cio => ItemFns.fromObject(cio));
    childItems.forEach(childItem => {
      if (!items.has(childItem.id)) {
        // item may have already been loaded (including children, and will be flagged as such).
        items.set(childItem.id, childItem);
      }
    });
    if (!isContainer(itemState.get(parentId)!)) {
      throwExpression(`Cannot set ${childItems.length} child items of parent '${parentId}' because it is not a container.`);
    }
    const parent = itemState.getAsContainerItem(parentId)!;
    let children: Array<Uid> = [];
    childItems.forEach(childItem => {
      if (childItem.parentId == EMPTY_UID) {
        if (childItem.relationshipToParent != RelationshipToParent.NoParent) { panic(); }
      } else {
        if (childItem.parentId != parentId) {
          throwExpression(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
        }
        if (childItem.relationshipToParent != RelationshipToParent.Child) {
          throwExpression(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
        }
        children.push(childItem.id);
      }
    });
    parent.computed_children = children;
    itemState.sortChildren(parentId);
  },

  setAttachmentItemsFromServerObjects: (parentId: Uid, attachmentItemObject: Array<object>): void => {
    let attachmentItems = attachmentItemObject.map(aio => ItemFns.fromObject(aio));
    if (!isAttachmentsItem(itemState.get(parentId)!)) {
      throwExpression(`Cannot attach ${attachmentItems.length} items to parent '${parentId}' because it has type '${itemState.get(parentId)!.itemType}' which does not allow attachments.`);
    }
    const parent = itemState.getAsAttachmentsItem(parentId)!;
    let attachments: Array<Uid> = [];
    attachmentItems.forEach(attachmentItem => {
      items.set(attachmentItem.id, attachmentItem);
      if (attachmentItem.parentId != parentId) {
        throwExpression(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
      }
      if (attachmentItem.relationshipToParent != RelationshipToParent.Attachment) {
        throwExpression(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
      }
      attachments.push(attachmentItem.id);
    });
    parent.computed_attachments = attachments;
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
      throwExpression(`unsupported relationship to parent: ${item.relationshipToParent}.`);
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

  newOrderingAtChildrenPosition: (parentId: Uid, position: number): Uint8Array => {
    let parent = asContainerItem(items.get(parentId)!);
    let childrenOrderings = parent.computed_children.map(c => items.get(c)!.ordering);
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
      panic();
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
  }
}
