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
import { NETWORK_STATUS_ERROR, NETWORK_STATUS_IN_PROGRESS, NETWORK_STATUS_OK, NetworkRequestInfo } from "./store/StoreProvider_General";
import { NumberSignal } from "./util/signals";
import { EMPTY_UID, Uid } from "./util/uid";
import { StoreContextModel } from "./store/StoreProvider";
import { VesCache } from "./layout/ves-cache";
import { isContainer } from "./items/base/container-item";
import { requestArrange } from "./layout/arrange";
import { itemState } from "./store/ItemState";
import { MouseActionState } from "./input/state";
import { appendRemoteSessionHeader, applyRotatedRemoteSessionHeader } from "./util/remoteSession";
import { RelationshipToParent } from "./layout/relationship-to-parent";

// Global request tracking - will be set by store initialization
let globalRequestTracker: {
  setCurrentNetworkRequest: (request: NetworkRequestInfo | null) => void,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  addErroredNetworkRequest: (request: NetworkRequestInfo) => void,
  clearErrorsByCommand: (command: string) => void,
} | null = null;

export function setGlobalRequestTracker(tracker: {
  setCurrentNetworkRequest: (request: NetworkRequestInfo | null) => void,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  addErroredNetworkRequest: (request: NetworkRequestInfo) => void,
  clearErrorsByCommand: (command: string) => void,
}) {
  globalRequestTracker = tracker;
}


export interface ItemsAndTheirAttachments {
  item: object,
  children: Array<object>,
  attachments: { [id: string]: Array<object> },
  syncVersion: number | null,
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

export interface SyncContainerSubscription {
  id: Uid,
  knownVersion: number | null,
}

export interface SyncContainerSnapshot {
  children: Array<object>,
  attachments: { [id: string]: Array<object> },
}

export interface SyncContainerUpdate {
  id: string,
  version: number,
  strategy: "delta" | "snapshot",
  children?: Array<object>,
  childDeletes?: Array<Uid>,
  attachmentUpserts?: { [id: string]: Array<object> },
  attachmentDeletes?: { [id: string]: Array<Uid> },
  snapshot?: SyncContainerSnapshot,
}

interface ContainerSyncAckEntry {
  id: Uid,
  version: number,
}

interface ContainerSyncAck {
  containers: Array<ContainerSyncAckEntry>,
}

interface MutationCommandResponse {
  item?: object,
  syncAck?: ContainerSyncAck,
}

interface EmptyTrashCommandResponse extends EmptyTrashResult {
  syncAck?: ContainerSyncAck,
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

const COMMAND_GET_ITEMS = "get-items";
const COMMAND_ADD_ITEM = "add-item";
const COMMAND_UPDATE_ITEM = "update-item";
const COMMAND_DELETE_ITEM = "delete-item";
const COMMAND_SEARCH = "search";
const COMMAND_EMPTY_TRASH = "empty-trash";
const COMMAND_SYNC_CONTAINERS = "sync-containers";

const PARALLEL_READ_COMMANDS = new Set<string>([
  COMMAND_GET_ITEMS,
  COMMAND_SYNC_CONTAINERS,
]);

function getCommandDescription(command: string, payload: any): { description: string, itemId?: string } {
  const itemId = payload.id || payload.itemId || undefined;

  let description: string;
  switch (command) {
    case COMMAND_GET_ITEMS:
      if (payload.mode === GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY) {
        description = "Loading content";
      } else {
        description = "Loading item";
      }
      break;
    case COMMAND_ADD_ITEM:
      description = `Adding ${payload.itemType || 'item'}`;
      break;
    case COMMAND_UPDATE_ITEM:
      description = `Updating ${payload.itemType || 'item'}`;
      break;
    case COMMAND_DELETE_ITEM:
      description = "Deleting item";
      break;
    case COMMAND_SEARCH:
      description = `Searching for "${payload.text}"`;
      break;
    case COMMAND_EMPTY_TRASH:
      description = "Emptying trash";
      break;
    case COMMAND_SYNC_CONTAINERS:
      description = "Syncing containers";
      break;
    default:
      description = command;
  }

  return { description, itemId };
}


const commandQueue: Array<ServerCommand> = [];
let inProgressNonGet: ServerCommand | null = null; // any non-read command currently running
let inProgressReadCommands = 0; // number of read commands currently running
const MUTATION_COMMANDS = new Set<string>([COMMAND_ADD_ITEM, COMMAND_UPDATE_ITEM, COMMAND_DELETE_ITEM, COMMAND_EMPTY_TRASH]);
let pendingMutationCommands = 0;

const isMutationCommand = (command: string): boolean => MUTATION_COMMANDS.has(command);
const isParallelReadCommand = (command: string): boolean => PARALLEL_READ_COMMANDS.has(command);
const incrementPendingMutations = (command: string): void => {
  if (isMutationCommand(command)) {
    pendingMutationCommands++;
  }
};
const decrementPendingMutations = (command: string): void => {
  if (isMutationCommand(command) && pendingMutationCommands > 0) {
    pendingMutationCommands--;
  }
};
const mutationsInFlight = (): boolean => pendingMutationCommands > 0;

function serveWaiting(networkStatus: NumberSignal) {
  // If nothing is queued and nothing is running, mark idle.
  if (commandQueue.length == 0 && inProgressNonGet == null && inProgressReadCommands == 0) {
    networkStatus.set(NETWORK_STATUS_OK);
    if (globalRequestTracker) {
      globalRequestTracker.setCurrentNetworkRequest(null);
      globalRequestTracker.setQueuedNetworkRequests([]);
    }
    return;
  }

  // Ensure UI shows activity when work is queued or running.
  if (networkStatus.get() != NETWORK_STATUS_ERROR) {
    if (commandQueue.length > 0 || inProgressNonGet != null || inProgressReadCommands > 0) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
  }

  // Update queued requests tracking
  if (globalRequestTracker) {
    const queued = commandQueue.map(cmd => {
      const { description, itemId } = getCommandDescription(cmd.command, cmd.payload);
      return {
        command: cmd.command,
        description,
        itemId
      };
    });
    globalRequestTracker.setQueuedNetworkRequests(queued);
  }

  // Start as many leading read commands as possible; keep ordering otherwise.
  while (commandQueue.length > 0) {
    const next = commandQueue[0];

    // Non-read commands (mutations, searches, etc.) run strictly one at a time.
    if (!isParallelReadCommand(next.command)) {
      if (inProgressNonGet != null || inProgressReadCommands > 0) {
        return; // wait for running commands to finish before starting the next non-read
      }

      const command = commandQueue.shift() as ServerCommand;
      inProgressNonGet = command;

      // Track current request
      if (globalRequestTracker) {
        const { description, itemId } = getCommandDescription(command.command, command.payload);
        globalRequestTracker.setCurrentNetworkRequest({
          command: command.command,
          description,
          itemId
        });
      }

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        // Clear current request tracker when this command completes
        if (globalRequestTracker) {
          globalRequestTracker.setCurrentNetworkRequest(null);
        }
        inProgressNonGet = null;
        decrementPendingMutations(command.command);
        serveWaiting(networkStatus);
      };

      sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
        .then((resp: any) => {
          command.resolve(resp);
          // Clear any previous errors for this command type on success
          if (globalRequestTracker) {
            globalRequestTracker.clearErrorsByCommand(command.command);
          }
        })
        .catch((error) => {
          command.reject(error);
          networkStatus.set(NETWORK_STATUS_ERROR);
          if (globalRequestTracker) {
            const { description, itemId } = getCommandDescription(command.command, command.payload);
            globalRequestTracker.addErroredNetworkRequest({
              command: command.command,
              description,
              itemId,
              errorMessage: error?.message || String(error)
            });
          }
        })
        .finally(finalizeCommand);

      return; // non-read commands run one at a time
    }

    // Read commands can run in parallel, but only while they are at the head and no non-read is running.
    if (inProgressNonGet != null) {
      return;
    }

    const command = commandQueue.shift() as ServerCommand;
    inProgressReadCommands++;

    // Track current request if it's the first read command.
    if (globalRequestTracker && inProgressReadCommands === 1 && !inProgressNonGet) {
      const { description, itemId } = getCommandDescription(command.command, command.payload);
      globalRequestTracker.setCurrentNetworkRequest({
        command: command.command,
        description,
        itemId
      });
    }

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      inProgressReadCommands--;
      if (globalRequestTracker && inProgressReadCommands === 0 && !inProgressNonGet) {
        globalRequestTracker.setCurrentNetworkRequest(null);
      }
      decrementPendingMutations(command.command);
      serveWaiting(networkStatus);
    };

    sendCommand(command.host, command.command, command.payload, command.base64data, command.panicLogoutOnError)
      .then((resp: any) => {
        command.resolve(resp);
      })
      .catch((error) => {
        command.reject(error);
        networkStatus.set(NETWORK_STATUS_ERROR);
        if (globalRequestTracker) {
          const { description, itemId } = getCommandDescription(command.command, command.payload);
          globalRequestTracker.addErroredNetworkRequest({
            command: command.command,
            description,
            itemId,
            errorMessage: error?.message || String(error)
          });
        }
      })
      .finally(finalizeCommand);

    // continue loop to launch more read commands at the head.
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

const localContainerSyncVersions = new Map<Uid, { version: number | null }>();

function setLocalContainerSyncVersion(containerId: Uid, version: number | null | undefined): void {
  const normalizedVersion = typeof version === "number" ? version : null;
  const existing = localContainerSyncVersions.get(containerId);
  if (existing && existing.version != null && normalizedVersion != null && existing.version > normalizedVersion) {
    return;
  }
  localContainerSyncVersions.set(containerId, { version: normalizedVersion });
}

export function clearLocalContainerSyncVersions(): void {
  localContainerSyncVersions.clear();
}

function applySyncAck(syncAck: ContainerSyncAck | null | undefined): void {
  if (!syncAck) {
    return;
  }
  for (const container of syncAck.containers) {
    setLocalContainerSyncVersion(container.id, container.version);
  }
  requestContainerSyncSoon();
}

function maybeTrackFetchedContainerSyncVersion(requestId: string, response: any, mode: string): void {
  if (mode !== GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY &&
    mode !== GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS) {
    return;
  }
  const containerId = (response.item?.id ?? requestId) as Uid;
  setLocalContainerSyncVersion(containerId, response.syncVersion ?? null);
}

function normalizeFetchedItemsResponse(
  requestId: string,
  mode: string,
  response: any,
  trackSyncVersion: boolean = true,
): ItemsAndTheirAttachments {
  if (trackSyncVersion) {
    maybeTrackFetchedContainerSyncVersion(requestId, response, mode);
  }

  // Server side, itemId is optional and the root page does not have this set (== null in the response).
  // Client side, parentId is used as a key in the item geometry maps, so it's more convenient to use EMPTY_UID.
  if (response.item && response.item.parentId == null) {
    response.item.parentId = EMPTY_UID;
  }

  return {
    item: response.item,
    children: response.children,
    attachments: response.attachments,
    syncVersion: typeof response.syncVersion === "number" ? response.syncVersion : null,
  };
}

function extractMutationItem(response: MutationCommandResponse | object): object {
  const mutationResponse = response as MutationCommandResponse;
  return mutationResponse.item ?? response;
}

function applyContainerSyncDelta(update: SyncContainerUpdate): boolean {
  const containerItem = itemState.getAsContainerItem(update.id);
  if (!containerItem) {
    return false;
  }

  const childDeleteIds = new Set(update.childDeletes ?? []);
  const nextChildIds = containerItem.computed_children.filter(childId => !childDeleteIds.has(childId));

  for (const childObject of update.children ?? []) {
    const childItem = itemState.upsertItemFromServerObject(childObject, null);
    if (!nextChildIds.includes(childItem.id)) {
      nextChildIds.push(childItem.id);
    }
  }

  containerItem.computed_children = nextChildIds;
  itemState.sortChildren(update.id);
  for (const childId of childDeleteIds) {
    itemState.pruneRelationshipSubtreeIfCurrent(childId, update.id, RelationshipToParent.Child);
  }

  for (const [parentId, attachmentObjects] of Object.entries(update.attachmentUpserts ?? {})) {
    if (itemState.getAsAttachmentsItem(parentId) != null) {
      itemState.applyAttachmentItemsSnapshotFromServerObjects(parentId, attachmentObjects, null);
    }
  }

  containerItem.childrenLoaded = true;
  return true;
}

function applyContainerSyncUpdate(update: SyncContainerUpdate): boolean {
  const container = itemState.get(update.id);
  if (!container || !isContainer(container)) {
    setLocalContainerSyncVersion(update.id, update.version);
    return false;
  }

  let changed = false;
  if (update.strategy === "snapshot") {
    const snapshot = update.snapshot;
    if (!snapshot) {
      return false;
    }
    itemState.applyContainerSnapshotFromServerObjects(update.id, snapshot.children, snapshot.attachments ?? {}, null);
    itemState.getAsContainerItem(update.id)!.childrenLoaded = true;
    changed = true;
  } else {
    changed = applyContainerSyncDelta(update);
  }

  setLocalContainerSyncVersion(update.id as Uid, update.version);
  return changed;
}

function getTrackedLocalContainerSubscriptions(): Array<SyncContainerSubscription> {
  const watchedContainersByOrigin = VesCache.watch.getContainerUidsByOrigin();
  const localContainers = watchedContainersByOrigin.get(null);
  if (!localContainers || localContainers.size === 0) {
    return [];
  }

  return Array.from(localContainers)
    .sort()
    .map((containerId) => {
      const existing = localContainerSyncVersions.get(containerId);
      if (!existing) {
        localContainerSyncVersions.set(containerId, { version: null });
      }
      return {
        id: containerId,
        knownVersion: localContainerSyncVersions.get(containerId)?.version ?? null,
      };
    });
}

export const server = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise(null, COMMAND_GET_ITEMS, { id, mode }, null, false, networkStatus)
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response));
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, item, base64Data, false, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  addItem: async (item: Item, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, ItemFns.toObject(item), base64Data, false, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  updateItem: async (item: Item, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, true, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  deleteItem: async (id: Uid, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, COMMAND_DELETE_ITEM, { id }, null, true, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  search: async (pageIdMaybe: Uid | null, text: String, networkStatus: NumberSignal, pageNumMaybe?: number): Promise<Array<SearchResult>> => {
    return constructCommandPromise(null, COMMAND_SEARCH, { pageId: pageIdMaybe, text, numResults: 10, pageNum: pageNumMaybe }, null, true, networkStatus);
  },

  emptyTrash: async (networkStatus: NumberSignal): Promise<EmptyTrashResult> => {
    return constructCommandPromise(null, COMMAND_EMPTY_TRASH, {}, null, true, networkStatus)
      .then((response: EmptyTrashCommandResponse) => {
        applySyncAck(response?.syncAck);
        return {
          itemCount: response.itemCount,
          imageCacheCount: response.imageCacheCount,
          objectCount: response.objectCount,
        };
      });
  },

  syncContainers: async (
    subscriptions: Array<SyncContainerSubscription>,
    networkStatus: NumberSignal,
  ): Promise<Array<SyncContainerUpdate>> => {
    return constructCommandPromise(null, COMMAND_SYNC_CONTAINERS, { subscriptions }, null, false, networkStatus)
      .then((response: { updates?: Array<SyncContainerUpdate> }) => response.updates ?? []);
  }
}



const commandQueue_remote: Array<ServerCommand> = [];
let inProgressNonGet_remote: ServerCommand | null = null; // any non-get-items command currently running remotely
let inProgressGetItems_remote = 0;

function serveWaiting_remote(networkStatus: NumberSignal) {
  if (commandQueue_remote.length == 0 && inProgressNonGet_remote == null && inProgressGetItems_remote == 0) {
    networkStatus.set(NETWORK_STATUS_OK);
    return;
  }

  if (networkStatus.get() != NETWORK_STATUS_ERROR) {
    if (commandQueue_remote.length > 0 || inProgressNonGet_remote != null || inProgressGetItems_remote > 0) {
      networkStatus.set(NETWORK_STATUS_IN_PROGRESS);
    }
  }

  while (commandQueue_remote.length > 0) {
    const next = commandQueue_remote[0];

    if (next.command !== COMMAND_GET_ITEMS) {
      if (inProgressNonGet_remote != null || inProgressGetItems_remote > 0) {
        return;
      }

      const command = commandQueue_remote.shift() as ServerCommand;
      inProgressNonGet_remote = command;

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        inProgressNonGet_remote = null;
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

      return;
    }

    if (inProgressNonGet_remote != null) {
      return;
    }

    const command = commandQueue_remote.shift() as ServerCommand;
    inProgressGetItems_remote++;

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      inProgressGetItems_remote--;
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
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response, false));
  },

  /**
   * update an item
   */
  updateItem: async (host: string, item: Item, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise_remote(host, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, false, networkStatus);
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

let containerSyncIntervalId: number | null = null;
let containerSyncRetryTimeoutId: number | null = null;
let containerSyncInFlight = false;
let containerSyncRerunRequested = false;
let containerSyncVisibilityHandler: (() => void) | null = null;
let activeContainerSyncStore: StoreContextModel | null = null;

function requestContainerSyncSoon(store?: StoreContextModel): void {
  const targetStore = store ?? activeContainerSyncStore;
  if (!targetStore) {
    return;
  }
  if (containerSyncRetryTimeoutId != null) {
    window.clearTimeout(containerSyncRetryTimeoutId);
  }
  containerSyncRetryTimeoutId = window.setTimeout(() => {
    containerSyncRetryTimeoutId = null;
    void performContainerSync(targetStore);
  }, 0);
}

function scheduleContainerSyncRetry(store: StoreContextModel, delayMs: number): void {
  if (containerSyncRetryTimeoutId != null) {
    return;
  }
  containerSyncRetryTimeoutId = window.setTimeout(() => {
    containerSyncRetryTimeoutId = null;
    void performContainerSync(store);
  }, delayMs);
}

function shouldPauseContainerSync(store: StoreContextModel): boolean {
  return document.hidden || mutationsInFlight() || !MouseActionState.empty() || store.overlay.textEditInfo() != null;
}

async function performContainerSync(store: StoreContextModel): Promise<void> {
  const subscriptions = getTrackedLocalContainerSubscriptions();
  if (subscriptions.length === 0) {
    return;
  }

  if (containerSyncInFlight) {
    containerSyncRerunRequested = true;
    return;
  }

  if (shouldPauseContainerSync(store)) {
    scheduleContainerSyncRetry(store, 250);
    return;
  }

  containerSyncInFlight = true;
  try {
    const updates = await server.syncContainers(subscriptions, store.general.networkStatus);
    if (shouldPauseContainerSync(store)) {
      containerSyncRerunRequested = true;
      return;
    }

    let shouldArrange = false;
    for (const update of updates) {
      if (applyContainerSyncUpdate(update)) {
        shouldArrange = true;
      }
    }

    if (shouldArrange) {
      requestArrange(store, "container-sync");
    }
  } catch (error) {
    console.error("Container sync failed:", error);
  } finally {
    containerSyncInFlight = false;
    if (containerSyncRerunRequested) {
      containerSyncRerunRequested = false;
      requestContainerSyncSoon(store);
    }
  }
}

export function startContainerSyncLoop(store: StoreContextModel): void {
  stopContainerSyncLoop();
  activeContainerSyncStore = store;

  containerSyncIntervalId = window.setInterval(() => {
    requestContainerSyncSoon(store);
  }, 2000);

  containerSyncVisibilityHandler = () => {
    if (!document.hidden) {
      requestContainerSyncSoon(store);
    }
  };
  document.addEventListener("visibilitychange", containerSyncVisibilityHandler);
  requestContainerSyncSoon(store);

  console.log("Started container sync loop - checking for server updates every 2 seconds");
}

export function stopContainerSyncLoop(): void {
  if (containerSyncIntervalId != null) {
    window.clearInterval(containerSyncIntervalId);
    containerSyncIntervalId = null;
  }
  if (containerSyncRetryTimeoutId != null) {
    window.clearTimeout(containerSyncRetryTimeoutId);
    containerSyncRetryTimeoutId = null;
  }
  if (containerSyncVisibilityHandler) {
    document.removeEventListener("visibilitychange", containerSyncVisibilityHandler);
    containerSyncVisibilityHandler = null;
  }
  containerSyncInFlight = false;
  containerSyncRerunRequested = false;
  activeContainerSyncStore = null;
  console.log("Stopped container sync loop");
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
  const headers: any = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  if (host != null) {
    appendRemoteSessionHeader(host, headers);
  }
  const fetchResult = await fetch(url, {
    method: 'POST',
    headers,
    body
  });

  if (host != null) {
    applyRotatedRemoteSessionHeader(host, fetchResult);
  }
  return await fetchResult.json();
}
