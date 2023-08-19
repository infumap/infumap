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

import { logout } from "./components/Main";
import { Item } from "./items/base/item";
import { itemToObject } from "./items/base/item-polymorphism";
import { throwExpression } from "./util/lang";
import { EMPTY_UID, Uid } from "./util/uid";


export interface ItemsAndTheirAttachments {
  item: object,
  items: Array<object>,
  attachments: { [id: string]: Array<object> }
}

export const GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY = "children-and-their-attachments-only";
export const GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THIER_ATTACHMENTS = "item-attachments-children-and-their-attachments";
export const GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY = "item-and-attachments-only";

export const server = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (itemId: Uid | null, mode: string): Promise<ItemsAndTheirAttachments> => {
    // TODO (MEDIUM): support for non-root user.
    let r = await sendCommand(null, "get-items", itemId == null ? { mode } : { userQualifiedItemId: itemId, mode }, null, false);
    // Server side, itemId is an optional and the root page does not have this set (== null in the response).
    // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
    r.children.forEach((item: any) => { if (item.parentId == null) { item.parentId = EMPTY_UID } })
    return ({
      item: r.item,
      items: r.children,
      attachments: r.attachments
    });
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null): Promise<object> => {
    let returnedItem = await sendCommand(null, "add-item", item, base64Data, true);
    return returnedItem;
  },

  addItem: async (item: Item, base64Data: string | null): Promise<object> => {
    let returnedItem = await sendCommand(null, "add-item", itemToObject(item), base64Data, true);
    return returnedItem;
  },

  updateItem: async (item: Item): Promise<void> => {
    await sendCommand(null, "update-item", itemToObject(item), null, true);
  },

  deleteItem: async (id: Uid): Promise<void> => {
    await sendCommand(null, "delete-item", { id }, null, true);
  }
}

export const remote = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (host: string, itemId: Uid | null, mode: string): Promise<ItemsAndTheirAttachments> => {
    // TODO: support for non-root users.
    let r = await sendCommand(host, "get-items", itemId == null ? { mode } : { userQualifiedItemId: itemId, mode }, null, false);
    // Server side, itemId is an optional and the root page does not have this set (== null in the response).
    // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
    r.children.forEach((item: any) => { if (item.parentId == null) { item.parentId = EMPTY_UID } })
    return ({
      item: r.item,
      items: r.children,
      attachments: r.attachments
    });
  },
}

/**
 * TODO (HIGH): panic logout on error is to ensure consistent state, but is highly disruptive. do something better.
 */
async function sendCommand(host: string | null, command: string, payload: object, base64Data: string | null, panicLogoutOnError: boolean): Promise<any> {
  let d: any = { command, jsonData: JSON.stringify(payload) };
  if (base64Data) { d.base64Data = base64Data; }
  let r = await post(host, '/command', d);
  if (!r.success) {
    if (logout != null && command != "get-items") {
      if (panicLogoutOnError) {
        await logout();
      }
      throwExpression(`'${command}' command failed. Reason: ${r.failReason}`);
    } else {
      throwExpression(`'${command}' command failed. Reason: ${r.failReason}`);
    }
  }
  return JSON.parse(r.jsonData);
}

export async function post(host: string | null, path: string, json: any) {
  let url = host == null
    ? path
    : host + path;
  let fetchResult = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(json)
  });
  return await fetchResult.json();
}
