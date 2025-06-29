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

import { itemState } from "../store/ItemState";
import { combineHashes } from "../util/hash";
import { Uid } from "../util/uid";
import { asAttachmentsItem, isAttachmentsItem } from "./base/attachments-item";
import { asContainerItem, isContainer } from "./base/container-item";
import { ItemFns } from "./base/item-polymorphism";


/**
 * Creates a composite hash of an item and its attachments only.
 * Corresponds to GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY.
 */
export function hashItemAndAttachmentsOnly(itemId: Uid): Uid {
  const hashes: Uid[] = [];

  const item = itemState.get(itemId);
  if (!item) {
    throw new Error(`Item with id '${itemId}' not found`);
  }
  hashes.push(ItemFns.hash(item));

  if (isAttachmentsItem(item)) {
    const attachmentsItem = asAttachmentsItem(item);
    for (const attachmentId of attachmentsItem.computed_attachments) {
      const attachmentItem = itemState.get(attachmentId);
      if (!attachmentItem) {
        throw new Error(`Attachment item with id '${attachmentId}' not found`);
      }
      hashes.push(ItemFns.hash(attachmentItem));
    }
  }

  return combineHashes(hashes);
}

/**
 * Creates a composite hash of all children of an item and their attachments only.
 * Does NOT include a hash of the item itself.
 * Corresponds to GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY.
 */
export function hashChildrenAndTheirAttachmentsOnly(itemId: Uid): Uid {
  const hashes: Uid[] = [];

  const item = itemState.get(itemId);
  if (!item) {
    throw new Error(`Item with id '${itemId}' not found`);
  }

  if (isContainer(item)) {
    const containerItem = asContainerItem(item);
    for (const childId of containerItem.computed_children) {
      const childItem = itemState.get(childId);
      if (!childItem) {
        throw new Error(`Child item with id '${childId}' not found`);
      }
      hashes.push(ItemFns.hash(childItem));

      if (isAttachmentsItem(childItem)) {
        const childAttachmentsItem = asAttachmentsItem(childItem);
        for (const attachmentId of childAttachmentsItem.computed_attachments) {
          const attachmentItem = itemState.get(attachmentId);
          if (!attachmentItem) {
            throw new Error(`Child attachment item with id '${attachmentId}' not found`);
          }
          hashes.push(ItemFns.hash(attachmentItem));
        }
      }
    }
  }

  return combineHashes(hashes);
}

/**
 * Creates a composite hash of an item, its attachments, its children, and their attachments.
 * Corresponds to GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS.
 */
export function hashItemAttachmentsChildrenAndTheirAttachments(itemId: Uid): Uid {
  const hashes: Uid[] = [];

  const item = itemState.get(itemId);
  if (!item) {
    throw new Error(`Item with id '${itemId}' not found`);
  }
  hashes.push(ItemFns.hash(item));

  if (isAttachmentsItem(item)) {
    const attachmentsItem = asAttachmentsItem(item);
    for (const attachmentId of attachmentsItem.computed_attachments) {
      const attachmentItem = itemState.get(attachmentId);
      if (!attachmentItem) {
        throw new Error(`Attachment item with id '${attachmentId}' not found`);
      }
      hashes.push(ItemFns.hash(attachmentItem));
    }
  }

  if (isContainer(item)) {
    const containerItem = asContainerItem(item);
    for (const childId of containerItem.computed_children) {
      const childItem = itemState.get(childId);
      if (!childItem) {
        throw new Error(`Child item with id '${childId}' not found`);
      }
      hashes.push(ItemFns.hash(childItem));

      if (isAttachmentsItem(childItem)) {
        const childAttachmentsItem = asAttachmentsItem(childItem);
        for (const attachmentId of childAttachmentsItem.computed_attachments) {
          const attachmentItem = itemState.get(attachmentId);
          if (!attachmentItem) {
            throw new Error(`Child attachment item with id '${attachmentId}' not found`);
          }
          hashes.push(ItemFns.hash(attachmentItem));
        }
      }
    }
  }

  return combineHashes(hashes);
}
