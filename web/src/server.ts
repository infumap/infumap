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
import { hashChildrenAndTheirAttachmentsOnly, hashChildrenAndTheirAttachmentsOnlyAsync, hashItemAndAttachmentsOnly } from "./items/item";
import { StoreContextModel } from "./store/StoreProvider";
import { VesCache } from "./layout/ves-cache";
import { asContainerItem, isContainer } from "./items/base/container-item";
import { asAttachmentsItem, isAttachmentsItem } from "./items/base/attachments-item";
import { TabularFns } from "./items/base/tabular-item";
import { fullArrange } from "./layout/arrange";
import { itemState } from "./store/ItemState";
import { MouseActionState } from "./input/state";


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

export interface ModifiedCheck {
  id: string,
  mode: string,
  hash: string,
}

export interface ModifiedCheckResult {
  id: string,
  mode: string,
  modified: boolean,
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
  isInternal?: boolean,
  internalHandler?: () => Promise<any>,
}

const COMMAND_GET_ITEMS = "get-items";
const COMMAND_ADD_ITEM = "add-item";
const COMMAND_UPDATE_ITEM = "update-item";
const COMMAND_DELETE_ITEM = "delete-item";
const COMMAND_SEARCH = "search";
const COMMAND_EMPTY_TRASH = "empty-trash";
const COMMAND_MODIFIED_CHECK = "modified-check";
const COMMAND_AUTO_REFRESH = "auto-refresh";

// TODO (MEDIUM): Allow multiple in flight requests. But add seq number and enforce execution order on server.
const commandQueue: Array<ServerCommand> = [];
let inProgress: ServerCommand | null = null;
const MUTATION_COMMANDS = new Set<string>([COMMAND_ADD_ITEM, COMMAND_UPDATE_ITEM, COMMAND_DELETE_ITEM, COMMAND_EMPTY_TRASH]);
let pendingMutationCommands = 0;
let mutationGeneration = 0;

const isMutationCommand = (command: string): boolean => MUTATION_COMMANDS.has(command);
const incrementPendingMutations = (command: string): void => {
  if (isMutationCommand(command)) {
    pendingMutationCommands++;
    mutationGeneration++;
  }
};
const decrementPendingMutations = (command: string): void => {
  if (isMutationCommand(command) && pendingMutationCommands > 0) {
    pendingMutationCommands--;
  }
};
const mutationsInFlight = (): boolean => pendingMutationCommands > 0;

function serveWaiting(networkStatus: NumberSignal) {
  if (commandQueue.length == 0 && inProgress == null) {
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
  const finalizeCommand = () => {
    inProgress = null;
    decrementPendingMutations(command.command);
    serveWaiting(networkStatus);
  };
  
  if (command.isInternal && command.internalHandler) {
    // Handle internal command
    command.internalHandler()
      .then((resp: any) => {
        command.resolve(resp);
      })
      .catch((error) => {
        command.reject(error);
        networkStatus.set(NETWORK_STATUS_ERROR);
      })
      .finally(finalizeCommand);
  } else {
    // Handle server command
    sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
      .then((resp: any) => {
        command.resolve(resp);
      })
      .catch((error) => {
        command.reject(error);
        networkStatus.set(NETWORK_STATUS_ERROR);
      })
      .finally(finalizeCommand);
  }
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
    incrementPendingMutations(command);
    commandQueue.push(commandObj);
    if (networkStatus.get() != NETWORK_STATUS_ERROR) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
    serveWaiting(networkStatus);
  })
}

function constructInternalCommandPromise(
    command: string,
    handler: () => Promise<any>,
    networkStatus: NumberSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const commandObj: ServerCommand = {
      host: null,
      command,
      payload: {},
      base64data: null,
      panicLogoutOnError: false,
      resolve,
      reject,
      isInternal: true,
      internalHandler: handler
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
    return constructCommandPromise(null, COMMAND_GET_ITEMS, { id, mode }, null, false, networkStatus)
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
    return constructCommandPromise(null, COMMAND_ADD_ITEM, item, base64Data, true, networkStatus);
  },

  addItem: async (item: Item, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, ItemFns.toObject(item), base64Data, true, networkStatus);
  },

  updateItem: async (item: Item, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, true, networkStatus);
  },

  deleteItem: async (id: Uid, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, COMMAND_DELETE_ITEM, { id }, null, true, networkStatus);
  },

  search: async (pageIdMaybe: Uid | null, text: String, networkStatus: NumberSignal, pageNumMaybe?: number): Promise<Array<SearchResult>> => {
    return constructCommandPromise(null, COMMAND_SEARCH, { pageId: pageIdMaybe, text, numResults: 10, pageNum: pageNumMaybe }, null, true, networkStatus);
  },

  emptyTrash: async (networkStatus: NumberSignal): Promise<EmptyTrashResult> => {
    return constructCommandPromise(null, COMMAND_EMPTY_TRASH, { }, null, true, networkStatus);
  },

  modifiedCheck: async (requests: ModifiedCheck[], networkStatus: NumberSignal): Promise<ModifiedCheckResult[]> => {
    return constructCommandPromise(null, COMMAND_MODIFIED_CHECK, requests, null, true, networkStatus);
  }
}



const commandQueue_remote: Array<ServerCommand> = [];
let inProgress_remote: ServerCommand | null = null;

function serveWaiting_remote(networkStatus: NumberSignal) {
  if (commandQueue_remote.length == 0 && inProgress_remote == null) {
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
  const finalizeCommand = () => {
    inProgress_remote = null;
    decrementPendingMutations(command.command);
    serveWaiting_remote(networkStatus);
  };
  sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
    .then((resp: any) => {
      command.resolve(resp);
    })
    .catch((error) => {
      command.reject(error);
      networkStatus.set(NETWORK_STATUS_ERROR);
    })
    .finally(finalizeCommand);
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
    incrementPendingMutations(command);
    commandQueue_remote.push(commandObj);
    if (networkStatus.get() != NETWORK_STATUS_ERROR) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
    serveWaiting_remote(networkStatus);
  })
}

export const remote = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (host: string, id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise_remote(host, COMMAND_GET_ITEMS, { id, mode }, null, false, networkStatus)
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
    return constructCommandPromise_remote(host, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, false, networkStatus);
  },

  /**
   * check if items have been modified
   */
  modifiedCheck: async (host: string, requests: ModifiedCheck[], networkStatus: NumberSignal): Promise<ModifiedCheckResult[]> => {
    return constructCommandPromise_remote(host, COMMAND_MODIFIED_CHECK, requests, null, false, networkStatus);
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

let loadTestInterval: number | null = null;

/**
 * Check for container modifications and refresh them automatically
 * 
 * TODO: 1. race condition with user interaction.
 *       2. setInterval [Violation] - takes too long.
 */
async function performAutoRefresh(store: StoreContextModel): Promise<void> {
  if (mutationsInFlight()) {
    // Wait for pending mutations to reach the server before risking a refresh.
    return;
  }
  const mutationGenerationAtStart = mutationGeneration;
  // Pause refresh during user interactions
  if (!MouseActionState.empty() || store.overlay.textEditInfo() != null) {
    return;
  }

  const watchedContainersByOrigin = VesCache.getCurrentWatchContainerUidsByOrigin();
  const localContainers = watchedContainersByOrigin.get(null);

  if (!localContainers || localContainers.size === 0) {
    return;
  }

  const testRequests: ModifiedCheck[] = [];

  // Process containers in parallel with async hashing
  const hashPromises = Array.from(localContainers).map(async (containerId) => {
    const calculatedHash = await hashChildrenAndTheirAttachmentsOnlyAsync(containerId);
    return {
      id: containerId,
      mode: GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY,
      hash: calculatedHash
    };
  });

  const resolvedRequests = await Promise.all(hashPromises);
  testRequests.push(...resolvedRequests);

  // Call sendCommand directly to avoid queue recursion
  const results = await sendCommand(null, COMMAND_MODIFIED_CHECK, testRequests, null, false);
  const modifiedContainers = results.filter((r: any) => r.modified);

  for (const modifiedContainer of modifiedContainers) {
    if (mutationGenerationAtStart !== mutationGeneration) {
      return;
    }
    const container = itemState.get(modifiedContainer.id);
    if (!container || !isContainer(container)) {
      continue;
    }

    const origin = container.origin;

    // Capture state before fetch to detect concurrent changes
    const containerItem = asContainerItem(container);
    const preFetchHashes = new Map<Uid, string>();

    // Hash the container itself and its attachments
    if (isAttachmentsItem(container)) {
      preFetchHashes.set(modifiedContainer.id, hashItemAndAttachmentsOnly(modifiedContainer.id));
    }

    // Hash all current children and their attachments
    for (const childId of containerItem.computed_children) {
      const childItem = itemState.get(childId);
      if (childItem) {
        if (isAttachmentsItem(childItem)) {
          preFetchHashes.set(childId, hashItemAndAttachmentsOnly(childId));
        }
      }
    }

    // Call sendCommand directly to avoid queue recursion
    const fetchResult = origin == null
      ? await sendCommand(null, COMMAND_GET_ITEMS, { id: modifiedContainer.id, mode: GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY }, null, false)
      : await sendCommand(origin, COMMAND_GET_ITEMS, { id: modifiedContainer.id, mode: GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY }, null, false);

    if (fetchResult != null) {
      if (mutationGenerationAtStart !== mutationGeneration) {
        return;
      }
      // Apply the same processing as in server.fetchItems
      if (fetchResult.item && fetchResult.item.parentId == null) { 
        fetchResult.item.parentId = EMPTY_UID; 
      }
      const result = {
        item: fetchResult.item,
        children: fetchResult.children,
        attachments: fetchResult.attachments
      };

      if (!MouseActionState.empty() || store.overlay.textEditInfo() != null) {
        return;
      }

      // Check if any tracked items have been modified since the fetch started
      for (const [itemId, preFetchHash] of preFetchHashes) {
        const currentItem = itemState.get(itemId);
        if (currentItem && isAttachmentsItem(currentItem)) {
          const currentHash = hashItemAndAttachmentsOnly(itemId);
          if (currentHash !== preFetchHash) {
            console.log(`Discarding fetch result for container ${modifiedContainer.id} because item ${itemId} was modified during fetch`);
            return;
          }
        }
      }

      const existingChildIds = new Set(containerItem.computed_children);
      const newChildIds = new Set<Uid>();

      for (const childObject of result.children) {
        const childItem = ItemFns.fromObject(childObject, origin);
        itemState.replaceMaybe(childObject, origin);
        newChildIds.add(childItem.id);
      }

      for (const childId of existingChildIds) {
        if (!newChildIds.has(childId)) {
          const childItem = itemState.get(childId);
          if (childItem && isContainer(childItem)) {
            const childContainer = asContainerItem(childItem);
            if (childContainer.computed_children.length === 0) {
              itemState.delete(childId);
            }
          } else if (childItem) {
            itemState.delete(childId);
          }
        }
      }

      containerItem.computed_children = Array.from(newChildIds);
      itemState.sortChildren(modifiedContainer.id);

      // Handle attachments with proper cleanup like children
      Object.keys(result.attachments).forEach(id => {
        const parentItem = itemState.get(id);
        if (parentItem && isAttachmentsItem(parentItem)) {
          const attachmentsParent = asAttachmentsItem(parentItem);

          const existingAttachmentIds = new Set(attachmentsParent.computed_attachments);
          const newAttachmentIds = new Set<Uid>();

          for (const attachmentObject of result.attachments[id]) {
            const attachmentItem = ItemFns.fromObject(attachmentObject, origin);
            itemState.replaceMaybe(attachmentObject, origin);
            newAttachmentIds.add(attachmentItem.id);
          }

          // Remove attachments that are no longer present
          for (const attachmentId of existingAttachmentIds) {
            if (!newAttachmentIds.has(attachmentId)) {
              itemState.delete(attachmentId);
            }
          }

          // Update the computed_attachments array to match the server response
          attachmentsParent.computed_attachments = Array.from(newAttachmentIds);
          itemState.sortAttachments(id);
        }
      });

      TabularFns.validateNumberOfVisibleColumnsMaybe(modifiedContainer.id);
      containerItem.childrenLoaded = true;

      fullArrange(store);
    }
  }
}

/**
 * Start a loop that checks for container modifications and refreshes them automatically
 *
 * TODO: have a websocket that sends a message when any of the current displayed containers are modified.
 *       only need to do the hashing on fist access to the current page.
 */
export function startContainerAutoRefresh(store: StoreContextModel): void {
  if (loadTestInterval) {
    window.clearInterval(loadTestInterval);
  }

  loadTestInterval = window.setInterval(async () => {
    try {
      await constructInternalCommandPromise(
        COMMAND_AUTO_REFRESH,
        () => performAutoRefresh(store),
        store.general.networkStatus
      );
    } catch (error) {
      console.error("Container auto-refresh failed:", error);
    }
  }, 10000);

  console.log("Started container auto-refresh - checking for modifications every 10 seconds");
}

/**
 * Stop the container auto-refresh loop
 */
export function stopContainerAutoRefresh(): void {
  if (loadTestInterval) {
    window.clearInterval(loadTestInterval);
    loadTestInterval = null;
    console.log("Stopped container auto-refresh");
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
    if (logout != null && command != COMMAND_GET_ITEMS) {
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
