/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { Item } from "./store/desktop/items/base/item";
import { setDefaultComputed } from "./store/desktop/items/base/item-polymorphism";
import { User } from "./store/UserStoreProvider";
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
  items: Array<Item>,
  attachments: { [id: string]: Array<Item> }
}

export const server = {
  fetchChildrenWithTheirAttachments: async (user: User, parentId: Uid): Promise<ItemsAndTheirAttachments> => {
    let r = await send("get-children-with-their-attachments", user, { parentId }, null);
    Object.keys(r.attachments).forEach((id: string) => {
      r.attachments[id].forEach((item: any) => {
        setDefaultComputed(item);
      });
    });
    // Server side, parentId is an optional and the root page does not have this set (== null in the response).
    // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
    r.children.forEach((item: any) => { if (item.parentId == null) { item.parentId = EMPTY_UID } })
    r.children.forEach((item: Item) => { setDefaultComputed(item); });
    return ({
      items: r.children,
      attachments: r.attachments
    });
  },

  addItem: async (user: User, item: Item, base64Data: string | null): Promise<Item> => {
    let returnedItem = await send("add-item", user, createItemForSend(item), base64Data);
    setDefaultComputed(returnedItem);
    return returnedItem;
  },

  updateItem: async (user: User, item: Item): Promise<void> => {
    await send("update-item", user, createItemForSend(item), null);
  },

  deleteItem: async (user: User, id: Uid): Promise<void> => {
    await send("delete-item", user, { id }, null);
  }
}

async function send(command: string, user: User, payload: object, base64Data: string | null): Promise<any> {
  let d: any = { command, jsonData: JSON.stringify(payload) };
  if (base64Data) { d.base64Data = base64Data; }
  let r = await post('/command', d);
  if (!r.success) { throwExpression(`'${command}' command failed!`); }
  return JSON.parse(r.jsonData);
}

function createItemForSend(item: Item): Item {
  let result: any = {};
  Object.assign(result, item);
  // TODO (LOW): check for any others with computed_ (or transient_ ??) prefix & fail fast.
  delete result.computed_openPopupId;
  delete result.computed_movingItemIsOver;
  delete result.computed_mouseIsOver;
  delete result.computed_children;
  delete result.computed_attachments;
  delete result.scrollXPx;
  delete result.setScrollXPx;
  delete result.scrollYPx;
  delete result.setScrollYPx;
  result.ordering = Array.from(item.ordering);
  return result;
}
