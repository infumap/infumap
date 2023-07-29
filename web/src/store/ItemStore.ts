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
import { itemFromObject } from "../items/base/item-polymorphism";
import { asTitledItem, isTitledItem } from "../items/base/titled-item";
import { Attachment, Child, NoParent } from "../layout/relationship-to-parent";
import { panic, throwExpression } from "../util/lang";
import { compareOrderings, newOrderingAtBeginning, newOrderingAtEnd, newOrderingBetween } from "../util/ordering";
import { EMPTY_UID, Uid } from "../util/uid";

let items: { [id: Uid]: Item } = {};


export const itemStore = {
  getItem: (id: Uid): Item | null => {
    // TODO (HIGH): use a map instead, profiling suggests this is inefficient.
    if (items.hasOwnProperty(id)) {
      return items[id];
    }
    return null;
  },

  getContainerItem: (id: Uid): ContainerItem | null => {
    const item = itemStore.getItem(id);
    if (item == null) { return null; }
    return asContainerItem(item);
  },

  getAttachmentsItem: (id: Uid): AttachmentsItem | null => {
    const item = itemStore.getItem(id);
    if (item == null) { return null; }
    return asAttachmentsItem(item);
  },

  deleteItem: (id: Uid): void => {
    const item = itemStore.getItem(id)!;
    if (item.parentId == EMPTY_UID) {
      panic!();
    }
    if (isContainer(item)) {
      const containerItem = asContainerItem(item);
      if (containerItem.computed_children.length > 0) {
        panic!();
      }
    }
    const parentItem = itemStore.getItem(item.parentId)!;
    if (item.relationshipToParent == Child) {
      const containerParentItem = asContainerItem(parentItem);
      containerParentItem.computed_children
        = containerParentItem.computed_children.filter(cid => cid != id);
    } else if (item.relationshipToParent == Attachment) {
      const attachmentsParentItem = asAttachmentsItem(parentItem);
      attachmentsParentItem.computed_attachments
        = attachmentsParentItem.computed_attachments.filter(aid => aid != id);
    } else {
      panic();
    }
    delete items[id];
  },

  setItemFromServerObject: (itemObject: object): void => {
    let item = itemFromObject(itemObject);
    items[item.id] = item;
  },

  sortChildren: (parentId: Uid): void => {
    const container = asContainerItem(itemStore.getItem(parentId)!);
    if (container.orderChildrenBy == "") {
      container.computed_children.sort((a, b) => compareOrderings(itemStore.getItem(a)!.ordering, itemStore.getItem(b)!.ordering));
    } else if (container.orderChildrenBy == "title[ASC]") {
      container.computed_children.sort((a, b) => {
        let aTitle = "";
        const aItem = itemStore.getItem(a)!
        if (isTitledItem(aItem)) { aTitle = asTitledItem(aItem).title; }
        aTitle.toLocaleLowerCase();
        let bTitle = "";
        const bItem = itemStore.getItem(b)!
        if (isTitledItem(bItem)) { bTitle = asTitledItem(bItem).title; }
        bTitle.toLocaleLowerCase();
        return aTitle.localeCompare(bTitle);
      });
    }
  },

  sortAttachments: (parentId: Uid): void => {
    const container = asAttachmentsItem(itemStore.getItem(parentId)!);
    container.computed_attachments.sort((a, b) => compareOrderings(itemStore.getItem(a)!.ordering, itemStore.getItem(b)!.ordering));
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
    let childItems = childItemObjects.map(cio => itemFromObject(cio));
    childItems.forEach(childItem => {
      if (!items[childItem.id]) {
        // item may have already been loaded (including children, and will be flagged as such).
        items[childItem.id] = childItem;
      }
    });
    if (!isContainer(itemStore.getItem(parentId)!)) {
      throwExpression(`Cannot set ${childItems.length} child items of parent '${parentId}' because it is not a container.`);
    }
    const parent = itemStore.getContainerItem(parentId)!;
    let children: Array<Uid> = [];
    childItems.forEach(childItem => {
      if (childItem.parentId == EMPTY_UID) {
        if (childItem.relationshipToParent != NoParent) { panic(); }
      } else {
        if (childItem.parentId != parentId) {
          throwExpression(`Child item had parent '${childItem.parentId}', but '${parentId}' was expected.`);
        }
        if (childItem.relationshipToParent != Child) {
          throwExpression(`Unexpected relationship to parent ${childItem.relationshipToParent}`);
        }
        children.push(childItem.id);
      }
    });
    parent.computed_children = children;
    itemStore.sortChildren(parentId);
  },

  setAttachmentItemsFromServerObjects: (parentId: Uid, attachmentItemObject: Array<object>): void => {
    let attachmentItems = attachmentItemObject.map(aio => itemFromObject(aio));
    if (!isAttachmentsItem(itemStore.getItem(parentId)!)) {
      throwExpression(`Cannot attach ${attachmentItems.length} items to parent '${parentId}' because it has type '${itemStore.getItem(parentId)!.itemType}' which does not allow attachments.`);
    }
    const parent = itemStore.getAttachmentsItem(parentId)!;
    let attachments: Array<Uid> = [];
    attachmentItems.forEach(attachmentItem => {
      items[attachmentItem.id] = attachmentItem;
      if (attachmentItem.parentId != parentId) {
        throwExpression(`Attachment item had parent '${attachmentItem.parentId}', but '${parentId}' was expected.`);
      }
      if (attachmentItem.relationshipToParent != Attachment) {
        throwExpression(`Unexpected relationship to parent ${attachmentItem.relationshipToParent}`);
      }
      attachments.push(attachmentItem.id);
    });
    parent.computed_attachments = attachments;
    itemStore.sortAttachments(parentId);
  },

  addItem: (item: Item): void => {
    items[item.id] = item;
    if (item.relationshipToParent == Child) {
      const parentItem = itemStore.getContainerItem(item.parentId)!;
      parentItem.computed_children = [...parentItem.computed_children, item.id];
      itemStore.sortChildren(parentItem.id);
    } else if (item.relationshipToParent == Attachment) {
      const parentItem = itemStore.getAttachmentsItem(item.parentId)!;
      parentItem.computed_attachments = [...parentItem.computed_attachments, item.id];
      itemStore.sortAttachments(parentItem.id);
    } else {
      throwExpression(`unsupported relationship to parent: ${item.relationshipToParent}.`);
    }
  },

  newOrderingAtEndOfChildren: (parentId: Uid): Uint8Array => {
    let parent = asContainerItem(items[parentId]);
    let childrenOrderings = parent.computed_children.map(c => items[c].ordering);
    return newOrderingAtEnd(childrenOrderings);
  },

  newOrderingAtEndOfAttachments: (parentId: Uid): Uint8Array => {
    let parent = asAttachmentsItem(items[parentId]);
    let attachmentOrderings = parent.computed_attachments.map(c => items[c].ordering);
    return newOrderingAtEnd(attachmentOrderings);
  },

  newOrderingAtChildrenPosition: (parentId: Uid, position: number): Uint8Array => {
    let parent = asContainerItem(items[parentId]);
    let childrenOrderings = parent.computed_children.map(c => items[c].ordering);
    if (position <= 0) {
      return newOrderingAtBeginning(childrenOrderings);
    } else if (position >= childrenOrderings.length) {
      return newOrderingAtEnd(childrenOrderings);
    } else {
      return newOrderingBetween(childrenOrderings[position-1], childrenOrderings[position]);
    }
  },

  newOrderingAtAttachmentsPosition: (parentId: Uid, position: number): Uint8Array => {
    let parent = asAttachmentsItem(items[parentId]);
    let attachmentOrderings = parent.computed_attachments.map(c => items[c].ordering);
    if (position <= 0) {
      return newOrderingAtBeginning(attachmentOrderings);
    } else if (position >= attachmentOrderings.length) {
      return newOrderingAtEnd(attachmentOrderings);
    } else {
      return newOrderingBetween(attachmentOrderings[position-1], attachmentOrderings[position]);
    }
  }
}
