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
import { ItemFns } from "./items/base/item-polymorphism";
import { NETWORK_STATUS_ERROR, NETWORK_STATUS_IN_PROGRESS, NETWORK_STATUS_OK } from "./store/StoreProvider_General";
import { NumberSignal } from "./util/signals";
import { EMPTY_UID, Uid } from "./util/uid";


export interface ItemsAndTheirAttachments {
  item: object,
  children: Array<object>,
  attachments: { [id: string]: Array<object> }
}

export interface SearchResult {
  path: Array<SearchPathElement>,
}

export interface SearchPathElement {
  itemType: string,
  title?: string,
  id: Uid,
}

export interface EmptyTrashResult {
  itemCount: number,
  imageCacheCount: number,
  objectCount: number,
}

export const GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY = "children-and-their-attachments-only";
export const GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS = "item-attachments-children-and-their-attachments";
export const GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY = "item-and-attachments-only";

interface ServerCommand {
  host: string | null,
  command: string,
  payload: object,
  base64data: string | null,
  panicLogoutOnError: boolean,
  resolve: (response: any) => void,
  reject: (reason: any) => void,
}

// TODO (MEDIUM): Allow multiple in flight requests. But add seq number and enforce execution order on server.
const commandQueue: Array<ServerCommand> = [];
let inProgress: ServerCommand | null = null;

function serveWaiting(networkStatus: NumberSignal) {
  if (commandQueue.length == 0 || inProgress != null) {
    networkStatus.set(NETWORK_STATUS_OK);
    return;
  }
  if (networkStatus.get() != NETWORK_STATUS_ERROR) {
    networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
  }
  const command = commandQueue.shift() as ServerCommand;
  inProgress = command;
  const DEBUG = false;
  if (DEBUG) { console.debug(command.command, command.payload); }
  sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
    .then((resp: any) => {
      inProgress = null;
      command.resolve(resp);
    })
    .catch((error) => {
      inProgress = null;
      command.reject(error);
      networkStatus.set(NETWORK_STATUS_ERROR);
    })
    .finally(() => {
      serveWaiting(networkStatus);
    });
}

function constructCommandPromise(
    host: string | null,
    command: string,
    payload: object,
    base64data: string | null,
    panicLogoutOnError: boolean,
    networkStatus: NumberSignal): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      host, command, payload, base64data, panicLogoutOnError,
      resolve, reject
    };
    commandQueue.push(commandObj);
    if (networkStatus.get() != NETWORK_STATUS_ERROR) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
    serveWaiting(networkStatus);
  })
}

export const server = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise(null, "get-items", { id, mode }, null, false, networkStatus)
      .then((r: any) => {
        // Server side, itemId is an optional and the root page does not have this set (== null in the response).
        // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
        if (r.item && r.item.parentId == null) { r.item.parentId = EMPTY_UID; }
        return ({
          item: r.item,
          children: r.children,
          attachments: r.attachments
        });
      });
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, "add-item", item, base64Data, true, networkStatus);
  },

  addItem: async (item: Item, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, "add-item", ItemFns.toObject(item), base64Data, true, networkStatus);
  },

  updateItem: async (item: Item, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, "update-item", ItemFns.toObject(item), null, true, networkStatus);
  },

  deleteItem: async (id: Uid, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, "delete-item", { id }, null, true, networkStatus);
  },

  search: async (pageIdMaybe: Uid | null, text: String, networkStatus: NumberSignal): Promise<Array<SearchResult>> => {
    return constructCommandPromise(null, "search", { pageId: pageIdMaybe, text, numResults: 15 }, null, true, networkStatus);
  },

  emptyTrash: async (networkStatus: NumberSignal): Promise<EmptyTrashResult> => {
    return constructCommandPromise(null, "empty-trash", { }, null, true, networkStatus);
  }
}



const commandQueue_remote: Array<ServerCommand> = [];
let inProgress_remote: ServerCommand | null = null;

function serveWaiting_remote(networkStatus: NumberSignal) {
  if (commandQueue_remote.length == 0 || inProgress != null) {
    networkStatus.set(NETWORK_STATUS_OK);
    return;
  }
  if (networkStatus.get() != NETWORK_STATUS_ERROR) {
    networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
  }
  const command = commandQueue_remote.shift() as ServerCommand;
  inProgress_remote = command;
  const DEBUG = false;
  if (DEBUG) { console.debug(command.command, command.payload); }
  sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
    .then((resp: any) => {
      inProgress_remote = null;
      command.resolve(resp);
    })
    .catch((error) => {
      inProgress_remote = null;
      command.reject(error);
      networkStatus.set(NETWORK_STATUS_ERROR);
    })
    .finally(() => {
      serveWaiting(networkStatus);
    });
}

function constructCommandPromise_remote(
    host: string | null,
    command: string,
    payload: object,
    base64data: string | null,
    panicLogoutOnError: boolean,
    networkStatus: NumberSignal): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      host, command, payload, base64data, panicLogoutOnError,
      resolve, reject
    };
    commandQueue_remote.push(commandObj);
    if (networkStatus.get() != NETWORK_STATUS_ERROR) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
    serveWaiting(networkStatus);
  })
}

export const remote = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (host: string, id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise_remote(host, "get-items", { id, mode }, null, false, networkStatus)
      .then((r: any) => {
        // Server side, itemId is an optional and the root page does not have this set (== null in the response).
        // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
        if (r.item && r.item.parentId == null) { r.item.parentId = EMPTY_UID; }
        return ({
          item: r.item,
          children: r.children,
          attachments: r.attachments
        });
      });
  },

  /**
   * update an item
   */
  updateItem: async (host: string, item: Item, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise_remote(host, "update-item", ItemFns.toObject(item), null, false, networkStatus);
  },
}


export const serverOrRemote = {
  updateItem: async (item: Item, networkStatus: NumberSignal) => {
    if (item.origin == null) {
      await server.updateItem(item, networkStatus);
    } else {
      await remote.updateItem(item.origin, item, networkStatus);
    }
  }
}


/**
 * TODO (HIGH): panic logout on error is to ensure consistent state, but is highly disruptive. do something better.
 */
async function sendCommand(host: string | null, command: string, payload: object, base64Data: string | null, panicLogoutOnError: boolean): Promise<any> {
  const d: any = { command, jsonData: JSON.stringify(payload) };
  if (base64Data) { d.base64Data = base64Data; }
  const r = await post(host, '/command', d);
  if (!r.success) {
    if (logout != null && command != "get-items") {
      if (panicLogoutOnError) {
        await logout();
      }
      throw new Error(`'${command}' command failed. Reason: ${r.failReason}`);
    } else {
      throw new Error(`'${command}' command failed. Reason: ${r.failReason}`);
    }
  }
  return JSON.parse(r.jsonData);
}

export async function post(host: string | null, path: string, json: any) {
  const body = JSON.stringify(json);
  const url = host == null
    ? path
    : new URL(path, host).href;
  const fetchResult = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body
  });
  return await fetchResult.json();
}
