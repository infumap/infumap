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


export async function post(path: string, json: any) {
  let fetchResult = await fetch(path, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(json)
  });
  return await fetchResult.json();
}

export interface ItemsAndTheirAttachments {
  items: Array<object>,
  attachments: { [id: string]: Array<object> }
}

export const server = {
  fetchChildrenWithTheirAttachments: async (parentId: Uid | null): Promise<ItemsAndTheirAttachments> => {
    let r = await send("get-children-with-their-attachments", parentId == null ? { } : { parentId }, null);
    // Server side, parentId is an optional and the root page does not have this set (== null in the response).
    // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
    r.children.forEach((item: any) => { if (item.parentId == null) { item.parentId = EMPTY_UID } })
    return ({
      items: r.children,
      attachments: r.attachments
    });
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null): Promise<object> => {
    let returnedItem = await send("add-item", item, base64Data);
    return returnedItem;
  },

  addItem: async (item: Item, base64Data: string | null): Promise<object> => {
    let returnedItem = await send("add-item", itemToObject(item), base64Data);
    return returnedItem;
  },

  updateItem: async (item: Item): Promise<void> => {
    await send("update-item", itemToObject(item), null);
  },

  deleteItem: async (id: Uid): Promise<void> => {
    await send("delete-item", { id }, null);
  }
}

async function send(command: string, payload: object, base64Data: string | null): Promise<any> {
  let d: any = { command, jsonData: JSON.stringify(payload) };
  if (base64Data) { d.base64Data = base64Data; }
  let r = await post('/command', d);
  if (!r.success) {
    if (logout != null) {
      await logout();
      throwExpression(`'${command}' command failed. Reason: ${r.failReason}`);
    } else {
      throwExpression(`'${command}' command failed.`);
    }
  }
  return JSON.parse(r.jsonData);
}
