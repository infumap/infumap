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
import { Item, ItemType } from "./items/base/item";
import { ItemFns } from "./items/base/item-polymorphism";
import { NETWORK_STATUS_IN_PROGRESS, NETWORK_STATUS_OK, NetworkRequestInfo } from "./store/StoreProvider_General";
import { NumberSignal } from "./util/signals";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, Uid } from "./util/uid";
import { StoreContextModel } from "./store/StoreProvider";
import { VesCache } from "./layout/ves-cache";
import { asContainerItem, isContainer } from "./items/base/container-item";
import { asAttachmentsItem, isAttachmentsItem } from "./items/base/attachments-item";
import { requestArrange } from "./layout/arrange";
import { itemState, wouldCreateRelationshipCycle } from "./store/ItemState";
import { TransientMessageType } from "./store/StoreProvider_Overlay";
import { MouseActionState } from "./input/state";
import { appendRemoteSessionHeader, applyRotatedRemoteSessionHeader } from "./util/remoteSession";
import { RelationshipToParent } from "./layout/relationship-to-parent";
import { VeFns, Veid } from "./layout/visual-element";
import { navigateToLocalRoot, switchToItem, switchToPage } from "./layout/navigation";
import { initiateLoadChildItemsMaybe } from "./layout/load";

// Global request tracking - will be set by store initialization
let globalRequestTracker: {
  setInProgressNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  addErroredNetworkRequest: (request: NetworkRequestInfo) => void,
} | null = null;

export function setGlobalRequestTracker(tracker: {
  setInProgressNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  addErroredNetworkRequest: (request: NetworkRequestInfo) => void,
}) {
  globalRequestTracker = tracker;
}


export interface ItemsAndTheirAttachments {
  item: object,
  children: Array<object>,
  attachments: { [id: string]: Array<object> },
  syncEpoch: number | null,
  syncVersion: number | null,
  /** Set when the requested id is a group: `item` is then the page holding it. */
  groupId: Uid | null,
}

export interface SearchResult {
  path: Array<SearchPathElement>,
  score?: number,
  stats?: SearchResultStats,
  fragmentMatch?: SearchFragmentMatch,
  additionalFragmentMatches?: Array<SearchFragmentMatch>,
}

export interface SearchResultStats {
  totalChildren: number,
  imageFileChildren: number,
  totalBytes: number,
}

export interface SearchFragmentMatch {
  fragmentOrdinal: number,
  sourceKind: string,
  lexicalScore?: number,
  score?: number,
  text: string,
  textTruncated: boolean,
  pageStart?: number,
  pageEnd?: number,
}

export interface SearchPathElement {
  itemType: string,
  title?: string,
  id: Uid,
}

export interface SearchResponse {
  results: Array<SearchResult>,
  hasMore: boolean,
}

export interface ChatToolCall {
  id: string,
  type?: string,
  function: {
    name: string,
    arguments: unknown,
  },
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool",
  content?: string,
  reasoningContent?: string,
  toolCallId?: string,
  toolCalls?: Array<ChatToolCall>,
}

/** "openrouter", or "llama:<name>" for one of the configured llama servers. */
export type ChatBackendId = string;

/**
 * The backend, model and reasoning effort a chat request should use. Omitted fields fall back to
 * the server's defaults. Reasoning effort applies to OpenRouter only, and must be one of the
 * efforts the chosen model reports; "none" turns reasoning off.
 */
export interface ChatModelSelection {
  backend?: ChatBackendId,
  model?: string,
  reasoningEffort?: string,
}

export type ChatRunMode = "chat" | "deep_research";

export interface ChatRequest {
  requestId: string,
  messages: Array<ChatMessage>,
  capabilities: Array<string>,
  mode: ChatRunMode,
  model?: ChatModelSelection,
  /** A scope from the Scopes page, limiting what the Infumap tools can read. */
  scopeId?: Uid | null,
}

/** Something about a scope's definition the user may want to fix. None of these widen the scope. */
export type ScopeProblem =
  | { kind: "unresolvedLink", itemId: Uid, exclude: boolean }
  | { kind: "ignoredContainer", itemId: Uid, title: string | null }
  | { kind: "multipleExcludeContainers" }
  | { kind: "noResolvedIncludes" };

export interface ScopeSummary {
  id: Uid,
  name: string,
  /** Null when the scope has no include links, and so covers everything under the home page. */
  includeCount: number | null,
  excludeCount: number,
  problems: Array<ScopeProblem>,
}

export interface ListScopesResponse {
  scopesPageId: Uid,
  scopes: Array<ScopeSummary>,
}

/** One of the user's links to an item, or one of their notes with an infumap:// url to it. */
export interface Backlink {
  /** The link or note. */
  itemId: Uid,
  kind: "link" | "note",
  /** The containers from a root page down to the link or note's parent. */
  path: Array<SearchPathElement>,
}

export interface GetBacklinksResponse {
  /** Sorted by path. Excludes links in the trash. */
  backlinks: Array<Backlink>,
}

export interface ChatModelInfo {
  id: string,
  name: string,
  contextLength?: number,
  /** Effort levels this model accepts. Empty for a model that does not reason. */
  reasoningEfforts: Array<string>,
  defaultEffort?: string,
  reasoningMandatory: boolean,
  /** US dollars per token, as OpenRouter reports it. */
  promptPrice?: string,
  completionPrice?: string,
}

export interface ChatBackendInfo {
  id: ChatBackendId,
  label: string,
  available: boolean,
  /** Why this backend cannot be used, when it cannot. */
  unavailableReason?: string,
  supportsModelSelection: boolean,
  supportsReasoningEffort: boolean,
  models: Array<ChatModelInfo>,
  modelsError?: string,
}

export interface ChatToolServerInfo {
  id: string,
  label: string,
  icons?: Array<{
    src: string,
    mimeType?: string,
    sizes?: Array<string>,
    theme?: string,
  }>,
  available: boolean,
  unavailableReason?: string,
  enabledByDefault: boolean,
  tools: Array<Record<string, unknown>>,
}

export interface ChatBackends {
  backends: Array<ChatBackendInfo>,
  default: { backend: ChatBackendId, model?: string },
  infumapTools?: Array<Record<string, unknown>>,
  toolServers?: Array<ChatToolServerInfo>,
}

export interface ChatResponse {
  items: Array<object>,
  assistantText: string,
  messages?: Array<ChatMessage>,
}

export type ChatStreamPhase =
  "submitted" |
  "thinking" |
  "using_tools" |
  "awaiting_approval" |
  "answering" |
  "materializing" |
  "complete" |
  "cancelled" |
  "error";

interface ChatStreamEventBase {
  requestId: string,
}

export type ChatStreamEvent = ChatStreamEventBase & (
  { type: "status", text: string } |
  { type: "model_round_started", round: number } |
  { type: "reasoning_delta", round: number, text: string } |
  { type: "answer_delta", round: number, text: string } |
  { type: "tool_approval_required", round: number, callId: string, name: string, query?: string, url?: string, arguments?: unknown } |
  { type: "tool_call_started", round: number, callId: string, name: string, arguments?: unknown } |
  { type: "tool_call_finished", round: number, callId: string, name: string, summary: string, durationMs?: number, resultPreview?: unknown } |
  { type: "materializing" } |
  { type: "context_tokens", tokens: number, exact: boolean } |
  { type: "final_items", text: string, items: Array<object>, messages?: Array<ChatMessage> } |
  { type: "cancelled" } |
  { type: "error", message: string }
);

const SEARCH_RESULTS_PER_PAGE = 60;

function normalizeSearchResponse(response: any): SearchResponse {
  if (Array.isArray(response)) {
    return {
      results: response as Array<SearchResult>,
      // Backward-compatible fallback for older servers that returned a bare array.
      hasMore: response.length === SEARCH_RESULTS_PER_PAGE,
    };
  }

  const results = Array.isArray(response?.results) ? response.results as Array<SearchResult> : [];
  return {
    results,
    hasMore: response?.hasMore === true,
  };
}

export interface EmptyTrashResult {
  itemCount: number,
  imageCacheCount: number,
  objectCount: number,
  deletedItemIds: Array<Uid>,
}

export interface SyncContainerSubscription {
  id: Uid,
  knownEpoch: number | null,
  knownVersion: number | null,
  knownItemType: string,
  knownLastModifiedDate: number,
}

export interface SyncContainerSnapshot {
  children: Array<object>,
  attachments: { [id: string]: Array<object> },
}

export interface SyncContainerUpdate {
  id: string,
  epoch: number,
  version: number,
  strategy: "delta" | "snapshot",
  item?: object,
  children?: Array<object>,
  childDeletes?: Array<Uid>,
  attachmentUpserts?: { [id: string]: Array<object> },
  attachmentDeletes?: { [id: string]: Array<Uid> },
  snapshot?: SyncContainerSnapshot,
}

interface ContainerSyncAckEntry {
  id: Uid,
  epoch: number,
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
  requestId: number,
  host: string | null,
  command: string,
  payload: object,
  base64data: string | null,
  resolve: (response: any) => void,
  reject: (reason: any) => void,
}

/** A command the server received but did not carry out. */
export class CommandFailedError extends Error {
  /** "auth", "client", "not-found" or "server". */
  readonly failReason: string | null;

  constructor(command: string, failReason: string | null) {
    super(`'${command}' command failed. Reason: ${failReason}`);
    this.failReason = failReason;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof CommandFailedError && error.failReason == "not-found";
}

function shouldSkipClientOnlyItemUpdate(item: Item): boolean {
  return item.id == SOLO_ITEM_HOLDER_PAGE_UID || item.clientOnly === true;
}

const COMMAND_GET_ITEMS = "get-items";
const COMMAND_ADD_ITEM = "add-item";
const COMMAND_UPDATE_ITEM = "update-item";
const COMMAND_CONVERT_PAGE_TABLE = "convert-page-table";
const COMMAND_DELETE_ITEM = "delete-item";
const COMMAND_SEARCH = "search";
const COMMAND_LIST_SCOPES = "list-scopes";
const COMMAND_GET_BACKLINKS = "get-backlinks";
const COMMAND_CHAT = "chat";
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
    case COMMAND_CONVERT_PAGE_TABLE:
      description = `Converting ${payload.expectedItemType} to ${payload.targetItemType}`;
      break;
    case COMMAND_DELETE_ITEM:
      description = "Deleting item";
      break;
    case COMMAND_SEARCH:
      description = `Searching for "${payload.text}"`;
      break;
    case COMMAND_LIST_SCOPES:
      description = "Loading scopes";
      break;
    case COMMAND_GET_BACKLINKS:
      description = "Loading links";
      break;
    case COMMAND_CHAT:
      description = "Generating query response";
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
const inProgressReadCommands: Array<ServerCommand> = [];
const inProgressStreamingCommands: Array<ServerCommand> = [];
const MUTATION_COMMANDS = new Set<string>([
  COMMAND_ADD_ITEM, COMMAND_UPDATE_ITEM, COMMAND_CONVERT_PAGE_TABLE, COMMAND_DELETE_ITEM, COMMAND_EMPTY_TRASH,
]);
let pendingMutationCommands = 0;
let nextNetworkRequestId = 1;
let activeContainerSyncStore: StoreContextModel | null = null;

const isMutationCommand = (command: string): boolean => MUTATION_COMMANDS.has(command);
const isParallelReadCommand = (command: string): boolean => PARALLEL_READ_COMMANDS.has(command);

function toNetworkRequestInfo(command: ServerCommand): NetworkRequestInfo {
  const { description, itemId } = getCommandDescription(command.command, command.payload);
  return {
    requestId: command.requestId,
    host: command.host,
    command: command.command,
    description,
    itemId,
  };
}

function getInProgressCommands(): Array<ServerCommand> {
  const active: Array<ServerCommand> = [];
  if (inProgressNonGet != null) {
    active.push(inProgressNonGet);
  }
  active.push(...inProgressReadCommands);
  active.push(...inProgressStreamingCommands);
  if (inProgressNonGet_remote != null) {
    active.push(inProgressNonGet_remote);
  }
  active.push(...inProgressGetItems_remote);
  return active;
}

function getQueuedCommands(): Array<ServerCommand> {
  return [...commandQueue, ...commandQueue_remote];
}

function hasAnyNetworkActivity(): boolean {
  return getInProgressCommands().length > 0 || getQueuedCommands().length > 0;
}

function syncBaseNetworkStatus(networkStatus: NumberSignal): void {
  networkStatus.set(hasAnyNetworkActivity() ? NETWORK_STATUS_IN_PROGRESS : NETWORK_STATUS_OK);
}

function syncGlobalRequestTracker(): void {
  if (!globalRequestTracker) {
    return;
  }
  globalRequestTracker.setInProgressNetworkRequests(getInProgressCommands().map(toNetworkRequestInfo));
  globalRequestTracker.setQueuedNetworkRequests(getQueuedCommands().map(toNetworkRequestInfo));
}

function trackNetworkCommandError(command: ServerCommand, error: any): void {
  if (globalRequestTracker) {
    globalRequestTracker.addErroredNetworkRequest({
      ...toNetworkRequestInfo(command),
      errorMessage: error?.message || String(error)
    });
  }
}

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

export function hasPendingLocalMutations(): boolean {
  return mutationsInFlight();
}

function serveWaiting(networkStatus: NumberSignal) {
  syncBaseNetworkStatus(networkStatus);
  syncGlobalRequestTracker();

  // If nothing local is queued and nothing local is running, we're done here.
  if (commandQueue.length == 0 && inProgressNonGet == null && inProgressReadCommands.length == 0) {
    return;
  }

  // Start as many leading read commands as possible; keep ordering otherwise.
  while (commandQueue.length > 0) {
    const next = commandQueue[0];

    if (next.command == COMMAND_SYNC_CONTAINERS && textEditInProgressForContainerSync(activeContainerSyncStore)) {
      const command = commandQueue.shift() as ServerCommand;
      command.resolve({ updates: [] });
      syncBaseNetworkStatus(networkStatus);
      syncGlobalRequestTracker();
      continue;
    }

    // Non-read commands (mutations, searches, etc.) run strictly one at a time.
    if (!isParallelReadCommand(next.command)) {
      if (inProgressNonGet != null || inProgressReadCommands.length > 0) {
        return; // wait for running commands to finish before starting the next non-read
      }

      const command = commandQueue.shift() as ServerCommand;
      inProgressNonGet = command;
      syncBaseNetworkStatus(networkStatus);
      syncGlobalRequestTracker();

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        inProgressNonGet = null;
        decrementPendingMutations(command.command);
        serveWaiting(networkStatus);
      };

      sendCommand(command.host, command.command, command.payload, command.base64data)
        .then((resp: any) => {
          command.resolve(resp);
        })
        .catch((error) => {
          command.reject(error);
          trackNetworkCommandError(command, error);
          if (isMutationCommand(command.command)) {
            handleFailedMutation(command, error);
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
    inProgressReadCommands.push(command);
    syncBaseNetworkStatus(networkStatus);
    syncGlobalRequestTracker();

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      const index = inProgressReadCommands.findIndex(active => active.requestId === command.requestId);
      if (index !== -1) {
        inProgressReadCommands.splice(index, 1);
      }
      decrementPendingMutations(command.command);
      serveWaiting(networkStatus);
    };

    sendCommand(command.host, command.command, command.payload, command.base64data)
      .then((resp: any) => {
        command.resolve(resp);
      })
      .catch((error) => {
        command.reject(error);
        trackNetworkCommandError(command, error);
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
  networkStatus: NumberSignal): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      requestId: nextNetworkRequestId++,
      host, command, payload, base64data,
      resolve, reject
    };
    incrementPendingMutations(command);
    commandQueue.push(commandObj);
    serveWaiting(networkStatus);
  })
}

async function streamChatCommand(
  payload: ChatRequest,
  networkStatus: NumberSignal,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const commandObj: ServerCommand = {
    requestId: nextNetworkRequestId++,
    host: null,
    command: COMMAND_CHAT,
    payload,
    base64data: null,
    resolve: () => { },
    reject: () => { },
  };
  inProgressStreamingCommands.push(commandObj);
  syncBaseNetworkStatus(networkStatus);
  syncGlobalRequestTracker();

  let finalItems: Array<object> | null = null;
  let finalAssistantText: string | null = null;
  let finalMessages: Array<ChatMessage> | undefined;
  let errorMessage: string | null = null;
  try {
    await sendChatStream(payload, (event) => {
      if (event.requestId != payload.requestId) {
        throw new Error("Chat stream returned an event for a different request.");
      }
      onEvent(event);
      if (event.type == "final_items") {
        finalItems = event.items;
        finalAssistantText = event.text;
        if (Array.isArray(event.messages) && event.messages.length > 0) {
          finalMessages = event.messages;
        }
      } else if (event.type == "error") {
        errorMessage = event.message;
      }
    }, signal);
    if (errorMessage != null) {
      throw new Error(errorMessage);
    }
    if (finalItems == null) {
      throw new Error("Chat stream ended without a final response.");
    }
    if (finalAssistantText == null) {
      throw new Error("Chat stream ended without assistant text.");
    }
    return { items: finalItems, assistantText: finalAssistantText, messages: finalMessages };
  } catch (error) {
    if (signal?.aborted !== true) {
      trackNetworkCommandError(commandObj, error);
    }
    throw error;
  } finally {
    const index = inProgressStreamingCommands.findIndex(active => active.requestId === commandObj.requestId);
    if (index !== -1) {
      inProgressStreamingCommands.splice(index, 1);
    }
    syncBaseNetworkStatus(networkStatus);
    syncGlobalRequestTracker();
  }
}

const localContainerSyncVersions = new Map<Uid, { epoch: number | null, version: number | null }>();

// A failed mutation can leave local state the server does not have. Rather than undoing the local change,
// which would be wrong if the server applied part of it, or if later mutations built on it, the item is
// re-fetched once no mutations are in flight, and the containers it was in are synced from a snapshot.
const itemsToReconcile = new Set<Uid>();
// Kept apart from localContainerSyncVersions so that a sync ack can't cancel the request for a snapshot.
const containersToResnapshot = new Set<Uid>();

function setLocalContainerSyncVersion(
  containerId: Uid,
  epoch: number | null | undefined,
  version: number | null | undefined,
  allowRegression: boolean = false,
): void {
  const normalizedEpoch = typeof epoch === "number" ? epoch : null;
  const normalizedVersion = typeof version === "number" ? version : null;
  const existing = localContainerSyncVersions.get(containerId);
  if (!allowRegression && existing) {
    if (existing.epoch != null && normalizedEpoch != null) {
      if (existing.epoch > normalizedEpoch) {
        return;
      }
      if (existing.epoch === normalizedEpoch &&
          existing.version != null &&
          normalizedVersion != null &&
          existing.version > normalizedVersion) {
        return;
      }
    } else if (existing.epoch != null && normalizedEpoch == null) {
      return;
    }
  }
  if (allowRegression && existing && existing.epoch === normalizedEpoch &&
      existing.version != null && normalizedVersion != null && existing.version > normalizedVersion) {
    console.warn(
      `Container sync version regressed for '${containerId}' within epoch ${normalizedEpoch}; accepting authoritative server state ${normalizedVersion} after local cache held ${existing.version}.`
    );
  }
  localContainerSyncVersions.set(containerId, { epoch: normalizedEpoch, version: normalizedVersion });
}

export function clearLocalSyncState(): void {
  localContainerSyncVersions.clear();
  itemsToReconcile.clear();
  containersToResnapshot.clear();
}

function applySyncAck(syncAck: ContainerSyncAck | null | undefined): void {
  if (!syncAck) {
    return;
  }
  for (const container of syncAck.containers) {
    setLocalContainerSyncVersion(container.id, container.epoch, container.version);
  }
  requestContainerSyncSoon();
}

function maybeTrackFetchedContainerSyncVersion(requestId: string, response: any, mode: string): void {
  if (mode !== GET_ITEMS_MODE__CHILDREN_AND_THEIR_ATTACHMENTS_ONLY &&
    mode !== GET_ITEMS_MODE__ITEM_ATTACHMENTS_CHILDREN_AND_THEIR_ATTACHMENTS) {
    return;
  }
  const containerId = (response.item?.id ?? requestId) as Uid;
  setLocalContainerSyncVersion(containerId, response.syncEpoch ?? null, response.syncVersion ?? null);
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
    syncEpoch: typeof response.syncEpoch === "number" ? response.syncEpoch : null,
    syncVersion: typeof response.syncVersion === "number" ? response.syncVersion : null,
    groupId: typeof response.groupId === "string" ? response.groupId : null,
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
  if (update.item) {
    itemState.upsertItemFromServerObject(update.item, null);
  }
  const container = itemState.get(update.id);
  if (!container || !isContainer(container)) {
    containersToResnapshot.delete(update.id);
    setLocalContainerSyncVersion(update.id, update.epoch, update.version, true);
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
    containersToResnapshot.delete(update.id);
    changed = true;
  } else {
    changed = applyContainerSyncDelta(update);
  }

  setLocalContainerSyncVersion(update.id as Uid, update.epoch, update.version, true);
  return changed;
}

function getTrackedLocalContainerSubscriptions(): Array<SyncContainerSubscription> {
  const watchedContainersByOrigin = VesCache.watch.getContainerUidsByOrigin();
  const localContainers = watchedContainersByOrigin.get(null);
  if (!localContainers || localContainers.size === 0) {
    return [];
  }

  return Array.from(localContainers)
    .filter((containerId) => {
      if (containerId === SOLO_ITEM_HOLDER_PAGE_UID) {
        return false;
      }
      const item = itemState.get(containerId);
      return item != null && isContainer(item) && item.clientOnly !== true;
    })
    .sort()
    .map((containerId) => {
      const existing = localContainerSyncVersions.get(containerId);
      if (!existing) {
        localContainerSyncVersions.set(containerId, { epoch: null, version: null });
      }
      // An unknown version gets a snapshot.
      const known = containersToResnapshot.has(containerId) ? null : localContainerSyncVersions.get(containerId);
      return {
        id: containerId,
        knownEpoch: known?.epoch ?? null,
        knownVersion: known?.version ?? null,
        knownItemType: itemState.get(containerId)!.itemType,
        knownLastModifiedDate: itemState.get(containerId)!.lastModifiedDate,
      };
    });
}

export const server = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise(null, COMMAND_GET_ITEMS, { id, mode }, null, networkStatus)
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response));
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, item, base64Data, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  addItem: async (item: Item, base64Data: string | null, networkStatus: NumberSignal): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, ItemFns.toObject(item), base64Data, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  updateItem: async (item: Item, networkStatus: NumberSignal): Promise<void> => {
    if (shouldSkipClientOnlyItemUpdate(item)) {
      console.warn(`Skipping update for client-only item '${item.id}'.`);
      return;
    }
    return constructCommandPromise(null, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  convertPageTable: async (
    id: Uid,
    expectedItemType: "page" | "table",
    targetItemType: "page" | "table",
    defaultPageAspect: number | null,
    networkStatus: NumberSignal,
  ): Promise<object> => {
    return constructCommandPromise(
      null, COMMAND_CONVERT_PAGE_TABLE, { id, expectedItemType, targetItemType, defaultPageAspect }, null, networkStatus,
    ).then((response: MutationCommandResponse) => {
      if (response?.item == null) {
        throw new Error(`Conversion of item '${id}' did not return the converted item.`);
      }
      applySyncAck(response.syncAck);
      return response.item;
    });
  },

  deleteItem: async (id: Uid, networkStatus: NumberSignal): Promise<void> => {
    return constructCommandPromise(null, COMMAND_DELETE_ITEM, { id }, null, networkStatus)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  search: async (
    pageIdMaybe: Uid | null,
    text: String,
    networkStatus: NumberSignal,
    pageNumMaybe?: number,
    scopeIdMaybe?: Uid | null,
  ): Promise<SearchResponse> => {
    return constructCommandPromise(null, COMMAND_SEARCH, { pageId: pageIdMaybe, text, numResults: SEARCH_RESULTS_PER_PAGE, pageNum: pageNumMaybe, scopeId: scopeIdMaybe ?? null }, null, networkStatus)
      .then((response: any) => normalizeSearchResponse(response));
  },

  listScopes: async (networkStatus: NumberSignal): Promise<ListScopesResponse> => {
    return constructCommandPromise(null, COMMAND_LIST_SCOPES, {}, null, networkStatus);
  },

  /** The user's links and notes that refer to an item they own. Local items only: backlinks are not tracked across servers. */
  getBacklinks: async (itemId: Uid, networkStatus: NumberSignal): Promise<GetBacklinksResponse> => {
    return constructCommandPromise(null, COMMAND_GET_BACKLINKS, { itemId }, null, networkStatus);
  },

  chatStream: async (
    payload: ChatRequest,
    networkStatus: NumberSignal,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> => {
    return streamChatCommand(payload, networkStatus, onEvent, signal);
  },

  chatBackends: async (): Promise<ChatBackends> => {
    return fetchChatBackends();
  },

  submitChatToolApproval: async (
    payload: { requestId: string, callId: string, approved: boolean },
  ): Promise<void> => {
    return submitChatToolApprovalCommand(payload);
  },

  emptyTrash: async (networkStatus: NumberSignal): Promise<EmptyTrashResult> => {
    return constructCommandPromise(null, COMMAND_EMPTY_TRASH, {}, null, networkStatus)
      .then((response: EmptyTrashCommandResponse) => {
        applySyncAck(response?.syncAck);
        return {
          itemCount: response.itemCount,
          imageCacheCount: response.imageCacheCount,
          objectCount: response.objectCount,
          deletedItemIds: Array.isArray(response.deletedItemIds) ? response.deletedItemIds : [],
        };
      });
  },

  syncContainers: async (
    subscriptions: Array<SyncContainerSubscription>,
    networkStatus: NumberSignal,
  ): Promise<Array<SyncContainerUpdate>> => {
    return constructCommandPromise(null, COMMAND_SYNC_CONTAINERS, { subscriptions }, null, networkStatus)
      .then((response: { updates?: Array<SyncContainerUpdate> }) => response.updates ?? []);
  }
}



const commandQueue_remote: Array<ServerCommand> = [];
let inProgressNonGet_remote: ServerCommand | null = null; // any non-get-items command currently running remotely
const inProgressGetItems_remote: Array<ServerCommand> = [];

function serveWaiting_remote(networkStatus: NumberSignal) {
  syncBaseNetworkStatus(networkStatus);
  syncGlobalRequestTracker();

  if (commandQueue_remote.length == 0 && inProgressNonGet_remote == null && inProgressGetItems_remote.length == 0) {
    return;
  }

  while (commandQueue_remote.length > 0) {
    const next = commandQueue_remote[0];

    if (next.command !== COMMAND_GET_ITEMS) {
      if (inProgressNonGet_remote != null || inProgressGetItems_remote.length > 0) {
        return;
      }

      const command = commandQueue_remote.shift() as ServerCommand;
      inProgressNonGet_remote = command;
      syncBaseNetworkStatus(networkStatus);
      syncGlobalRequestTracker();

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        inProgressNonGet_remote = null;
        decrementPendingMutations(command.command);
        serveWaiting_remote(networkStatus);
      };

      sendCommand(command.host, command.command, command.payload, command.base64data)
        .then((resp: any) => {
          command.resolve(resp);
        })
        .catch((error) => {
          command.reject(error);
          trackNetworkCommandError(command, error);
        })
        .finally(finalizeCommand);

      return;
    }

    if (inProgressNonGet_remote != null) {
      return;
    }

    const command = commandQueue_remote.shift() as ServerCommand;
    inProgressGetItems_remote.push(command);
    syncBaseNetworkStatus(networkStatus);
    syncGlobalRequestTracker();

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      const index = inProgressGetItems_remote.findIndex(active => active.requestId === command.requestId);
      if (index !== -1) {
        inProgressGetItems_remote.splice(index, 1);
      }
      decrementPendingMutations(command.command);
      serveWaiting_remote(networkStatus);
    };

    sendCommand(command.host, command.command, command.payload, command.base64data)
      .then((resp: any) => {
        command.resolve(resp);
      })
      .catch((error) => {
        command.reject(error);
        trackNetworkCommandError(command, error);
      })
      .finally(finalizeCommand);
  }
}

function constructCommandPromise_remote(
  host: string | null,
  command: string,
  payload: object,
  base64data: string | null,
  networkStatus: NumberSignal): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      requestId: nextNetworkRequestId++,
      host, command, payload, base64data,
      resolve, reject
    };
    incrementPendingMutations(command);
    commandQueue_remote.push(commandObj);
    serveWaiting_remote(networkStatus);
  })
}

export const remote = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (host: string, id: string, mode: string, networkStatus: NumberSignal): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise_remote(host, COMMAND_GET_ITEMS, { id, mode }, null, networkStatus)
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response, false));
  },

  /**
   * update an item
   */
  updateItem: async (host: string, item: Item, networkStatus: NumberSignal): Promise<void> => {
    if (shouldSkipClientOnlyItemUpdate(item)) {
      console.warn(`Skipping remote update for client-only item '${item.id}'.`);
      return;
    }
    return constructCommandPromise_remote(host, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null, networkStatus);
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

function textEditInProgressForContainerSync(store: StoreContextModel | null | undefined): boolean {
  return store?.overlay.textEditInfo() != null || (store?.textEdit.unsavedCount() ?? 0) > 0 || (store?.editorHistory.busy() ?? false);
}

function clearContainerSyncRetryTimeout(): void {
  if (containerSyncRetryTimeoutId == null) {
    return;
  }
  window.clearTimeout(containerSyncRetryTimeoutId);
  containerSyncRetryTimeoutId = null;
}

export function requestContainerSyncSoon(store?: StoreContextModel): void {
  const targetStore = store ?? activeContainerSyncStore;
  if (!targetStore) {
    return;
  }

  if (textEditInProgressForContainerSync(targetStore)) {
    clearContainerSyncRetryTimeout();
    return;
  }

  clearContainerSyncRetryTimeout();
  containerSyncRetryTimeoutId = window.setTimeout(() => {
    containerSyncRetryTimeoutId = null;
    void performContainerSync(targetStore);
  }, 0);
}

function scheduleContainerSyncRetry(store: StoreContextModel, delayMs: number): void {
  if (textEditInProgressForContainerSync(store)) {
    return;
  }
  if (containerSyncRetryTimeoutId != null) {
    return;
  }
  containerSyncRetryTimeoutId = window.setTimeout(() => {
    containerSyncRetryTimeoutId = null;
    void performContainerSync(store);
  }, delayMs);
}

function shouldRetryContainerSyncLater(): boolean {
  return document.hidden || mutationsInFlight() || !MouseActionState.empty();
}

const FAILED_MUTATION_MESSAGE_MS = 5000;

function handleFailedMutation(command: ServerCommand, error: unknown): void {
  const store = activeContainerSyncStore;
  const payload = command.payload as { id?: unknown, parentId?: unknown };
  if (typeof payload.id == "string") {
    itemsToReconcile.add(payload.id);
  }
  // The item may be fine, and its parent deleted.
  if (isNotFoundError(error) && typeof payload.parentId == "string" && payload.parentId != EMPTY_UID) {
    itemsToReconcile.add(payload.parentId);
  }
  if (command.command == COMMAND_EMPTY_TRASH) {
    // Some of the trash may have been deleted.
    const trashPageId = store?.user.getUserMaybe()?.trashPageId;
    if (trashPageId != null) {
      containersToResnapshot.add(trashPageId);
    }
  }
  if (store == null) {
    return;
  }

  showFailedMutationMessage(store, error);
  if (error instanceof CommandFailedError) {
    void logoutIfSessionEnded(store);
  }
  requestContainerSyncSoon(store);
}

function showFailedMutationMessage(store: StoreContextModel, error: unknown): void {
  const text = !(error instanceof CommandFailedError)
    ? "Couldn't save change: the server could not be reached."
    : error.failReason == "not-found"
      ? "Couldn't save change: the item no longer exists."
      : "Couldn't save change.";
  const message = { text, type: TransientMessageType.Error };
  store.overlay.toolbarTransientMessage.set(message);
  window.setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, FAILED_MUTATION_MESSAGE_MS);
}

let sessionCheckInFlight = false;

/**
 * Mutations also fail once the session has ended, e.g. it expired, or the user logged out in another tab.
 * Only then is logging out the right response to a failure.
 */
async function logoutIfSessionEnded(store: StoreContextModel): Promise<void> {
  const userId = store.user.getUserMaybe()?.userId;
  const logoutMaybe = logout;
  if (sessionCheckInFlight || userId == null || logoutMaybe == null) {
    return;
  }
  // Held through the logout, which saves pending text edits: those fail too, and must not start another.
  sessionCheckInFlight = true;
  try {
    const r = await post(null, "/account/validate-session", {});
    // A different user may have logged in, in another tab.
    if (r?.success === false || (r?.success === true && r.userId !== userId)) {
      await logoutMaybe();
    }
  } catch (_e) {
    // Without a response, whether the session has ended is unknown.
  } finally {
    sessionCheckInFlight = false;
  }
}

/**
 * Re-fetches items whose mutations failed, and replaces the local versions with the server's. Returns false,
 * leaving them to be reconciled later, if local state may have changed while they were being fetched.
 */
async function reconcileFailedItems(store: StoreContextModel): Promise<boolean> {
  const ids = [...itemsToReconcile];
  itemsToReconcile.clear();
  const results = await Promise.allSettled(ids.map(id =>
    server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, store.general.networkStatus)));
  if (textEditInProgressForContainerSync(store) || shouldRetryContainerSyncLater()) {
    ids.forEach(id => itemsToReconcile.add(id));
    return false;
  }

  const goneIds = new Set<Uid>();
  results.forEach((result, i) => {
    const id = ids[i];
    // e.g. a clipboard text item that couldn't be saved, kept so the user can try again.
    if (itemState.get(id)?.clientOnly === true) {
      return;
    }
    if (result.status == "fulfilled") {
      reconcileItem(id, result.value);
    } else if (isNotFoundError(result.reason)) {
      goneIds.add(id);
    } else if (result.reason instanceof CommandFailedError) {
      // Trying again won't help, but the containers it is in can still be synced.
      console.warn(`Could not reconcile item '${id}' after a failed mutation:`, result.reason);
      markContainerForResnapshot(itemState.get(id));
    } else {
      // e.g. the server could not be reached.
      itemsToReconcile.add(id);
    }
  });

  if (goneIds.size > 0) {
    if (currentPageWithin(store, goneIds)) {
      void navigateToLocalRoot(store);
    }
    if (currentPageWithin(store, goneIds)) {
      // The home page is being loaded. Remove them once it is shown.
      goneIds.forEach(id => itemsToReconcile.add(id));
    } else {
      if (veidWithin(store.history.currentPopupSpecVeid(), goneIds)) {
        store.history.popAllPopups();
      }
      goneIds.forEach(removeReconciledItem);
      const focusPath = store.history.getFocusPathMaybe();
      if (focusPath != null && itemState.get(VeFns.veidFromPath(focusPath).itemId) == null) {
        store.history.setFocus(store.history.currentPagePath()!);
      }
    }
  }

  requestArrange(store, "reconcile-failed-mutations");
  store.touchToolbar();
  return true;
}

function reconcileItem(id: Uid, fetched: ItemsAndTheirAttachments): void {
  if (fetched.groupId != null || (fetched.item as { id?: unknown })?.id != id) {
    return;
  }
  const localItem = itemState.get(id);
  markContainerForResnapshot(localItem);
  const item = itemState.upsertItemFromServerObject(fetched.item, null);
  if (localItem != null &&
    (localItem.parentId != item.parentId || localItem.relationshipToParent != item.relationshipToParent)) {
    unlinkFromLocalParent(id, localItem.parentId, localItem.relationshipToParent);
  }
  linkToLocalParent(item);
  if (isAttachmentsItem(item)) {
    itemState.applyAttachmentItemsSnapshotFromServerObjects(id, fetched.attachments[id] ?? [], null);
  }
  if (localItem == null && isContainer(item)) {
    // Its children were removed along with it.
    containersToResnapshot.add(id);
  }
  markContainerForResnapshot(item);
}

function removeReconciledItem(id: Uid): void {
  const item = itemState.get(id);
  if (item == null) {
    return;
  }
  markContainerForResnapshot(item);
  unlinkFromLocalParent(id, item.parentId, item.relationshipToParent);
  itemState.pruneRelationshipSubtreeIfCurrent(id, item.parentId, item.relationshipToParent as RelationshipToParent);
}

function unlinkFromLocalParent(id: Uid, parentId: Uid, relationshipToParent: string): void {
  const parent = itemState.get(parentId);
  if (parent == null) {
    return;
  }
  if (relationshipToParent == RelationshipToParent.Child && isContainer(parent)) {
    const container = asContainerItem(parent);
    container.computed_children = container.computed_children.filter(childId => childId != id);
  } else if (relationshipToParent == RelationshipToParent.Attachment && isAttachmentsItem(parent)) {
    const attachmentsItem = asAttachmentsItem(parent);
    attachmentsItem.computed_attachments = attachmentsItem.computed_attachments.filter(attachmentId => attachmentId != id);
  }
}

function linkToLocalParent(item: Item): void {
  const parent = itemState.get(item.parentId);
  if (parent == null || wouldCreateRelationshipCycle(item.id, parent.id)) {
    return;
  }
  if (item.relationshipToParent == RelationshipToParent.Child && isContainer(parent)) {
    const container = asContainerItem(parent);
    // If the other children haven't been loaded yet, loading them replaces the list.
    if (!container.computed_children.includes(item.id)) {
      container.computed_children = [...container.computed_children, item.id];
    }
    itemState.sortChildren(container.id);
  } else if (item.relationshipToParent == RelationshipToParent.Attachment && isAttachmentsItem(parent)) {
    const attachmentsItem = asAttachmentsItem(parent);
    if (!attachmentsItem.computed_attachments.includes(item.id)) {
      attachmentsItem.computed_attachments = [...attachmentsItem.computed_attachments, item.id];
    }
    itemState.sortAttachments(attachmentsItem.id);
  }
}

/** A container's snapshot includes its children's attachments, so an attachment's is that of its parent. */
function markContainerForResnapshot(item: Item | null): void {
  if (item == null) {
    return;
  }
  const containerId = item.relationshipToParent == RelationshipToParent.Attachment
    ? itemState.get(item.parentId)?.parentId
    : item.parentId;
  const container = containerId == null ? null : itemState.get(containerId);
  if (container != null && isContainer(container)) {
    containersToResnapshot.add(container.id);
  }
}

/** Whether the item, or one of its loaded ancestors, is one of ids. */
function itemWithin(itemId: Uid | null, ids: Set<Uid>): boolean {
  const seen = new Set<Uid>();
  let id = itemId;
  while (id != null && id != EMPTY_UID && !seen.has(id)) {
    if (ids.has(id)) {
      return true;
    }
    seen.add(id);
    id = itemState.get(id)?.parentId ?? null;
  }
  return false;
}

function veidWithin(veid: Veid | null, ids: Set<Uid>): boolean {
  return veid != null && (itemWithin(veid.itemId, ids) || itemWithin(veid.linkIdMaybe, ids));
}

function currentPageWithin(store: StoreContextModel, ids: Set<Uid>): boolean {
  const pageVeid = store.history.currentPageVeid();
  if (pageVeid?.itemId == SOLO_ITEM_HOLDER_PAGE_UID) {
    const soloItemIds = itemState.getAsContainerItem(SOLO_ITEM_HOLDER_PAGE_UID)?.computed_children ?? [];
    return soloItemIds.some(id => itemWithin(id, ids));
  }
  return veidWithin(pageVeid, ids);
}

async function performContainerSync(store: StoreContextModel): Promise<void> {
  if (textEditInProgressForContainerSync(store)) {
    return;
  }

  if (getTrackedLocalContainerSubscriptions().length === 0 && itemsToReconcile.size === 0) {
    return;
  }

  if (containerSyncInFlight) {
    containerSyncRerunRequested = true;
    return;
  }

  if (shouldRetryContainerSyncLater()) {
    scheduleContainerSyncRetry(store, 250);
    return;
  }

  containerSyncInFlight = true;
  try {
    if (itemsToReconcile.size > 0 && !await reconcileFailedItems(store)) {
      containerSyncRerunRequested = true;
      return;
    }
    // After reconciling, which can request snapshots.
    const subscriptions = getTrackedLocalContainerSubscriptions();
    if (subscriptions.length === 0) {
      return;
    }

    const updates = await server.syncContainers(subscriptions, store.general.networkStatus);
    if (textEditInProgressForContainerSync(store)) {
      return;
    }
    if (shouldRetryContainerSyncLater()) {
      containerSyncRerunRequested = true;
      return;
    }

    const popupItemId = store.history.currentPopupSpecVeid()?.itemId;
    const popupItemType = popupItemId == null ? null : itemState.get(popupItemId)?.itemType;
    const pageIdBeforeSync = store.history.currentPageVeid()?.itemId;
    const pageTypeBeforeSync = pageIdBeforeSync == null ? null : itemState.get(pageIdBeforeSync)?.itemType;
    const soloItemIdBeforeSync = pageIdBeforeSync == SOLO_ITEM_HOLDER_PAGE_UID
      ? itemState.getAsContainerItem(SOLO_ITEM_HOLDER_PAGE_UID)?.computed_children[0]
      : null;
    const soloItemTypeBeforeSync = soloItemIdBeforeSync == null ? null : itemState.get(soloItemIdBeforeSync)?.itemType;
    let shouldArrange = false;
    let didChange = false;
    for (const update of updates) {
      if (applyContainerSyncUpdate(update)) {
        shouldArrange = true;
        didChange = true;
      }
    }

    if (popupItemId != null && popupItemType == ItemType.Page &&
      itemState.get(popupItemId)?.itemType == ItemType.Table) {
      store.history.popAllPopups();
      shouldArrange = true;
    }

    const currentPageId = store.history.currentPageVeid()?.itemId;
    if (currentPageId && currentPageId == pageIdBeforeSync && pageTypeBeforeSync == ItemType.Page &&
      itemState.get(currentPageId)?.itemType == ItemType.Table) {
      const convertedTable = itemState.get(currentPageId)!;
      const parent = itemState.get(convertedTable.parentId);
      if (parent?.itemType == ItemType.Page) {
        switchToPage(store, { itemId: parent.id, linkIdMaybe: null }, true, true, false);
        await initiateLoadChildItemsMaybe(store, { itemId: parent.id, linkIdMaybe: null });
      } else {
        switchToItem(store, convertedTable.id, true, false);
      }
      shouldArrange = false;
    } else if (currentPageId == SOLO_ITEM_HOLDER_PAGE_UID && soloItemTypeBeforeSync == ItemType.Table) {
      const soloItemId = itemState.getAsContainerItem(SOLO_ITEM_HOLDER_PAGE_UID)?.computed_children[0];
      if (soloItemId && soloItemId == soloItemIdBeforeSync && itemState.get(soloItemId)?.itemType == ItemType.Page) {
        switchToPage(store, { itemId: soloItemId, linkIdMaybe: null }, false, true, false);
        shouldArrange = false;
      }
    }

    if (shouldArrange) {
      requestArrange(store, "container-sync");
    }
    if (didChange) {
      store.touchToolbar();
    }
  } catch (error) {
    console.error("Container sync failed:", error);
  } finally {
    containerSyncInFlight = false;
    if (containerSyncRerunRequested) {
      containerSyncRerunRequested = false;
      if (!textEditInProgressForContainerSync(store)) {
        requestContainerSyncSoon(store);
      }
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

async function sendCommand(host: string | null, command: string, payload: object, base64Data: string | null): Promise<any> {
  const d: any = { command, jsonData: JSON.stringify(payload) };
  if (base64Data) { d.base64Data = base64Data; }
  const r = await post(host, '/command', d);
  if (r == null || typeof r !== "object") {
    throw new Error(`'${command}' command returned an empty or invalid response.`);
  }
  if (typeof r.success !== "boolean") {
    throw new Error(`'${command}' command returned a malformed response.`);
  }
  if (!r.success) {
    throw new CommandFailedError(command, typeof r.failReason == "string" ? r.failReason : null);
  }
  if (typeof r.jsonData !== "string") {
    throw new Error(`'${command}' command returned malformed jsonData.`);
  }
  return JSON.parse(r.jsonData);
}

async function sendChatStream(
  payload: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const fetchResult = await fetch("/chat/stream", {
    method: "POST",
    headers: {
      "Accept": "application/x-ndjson",
      "Content-Type": "application/json",
      "X-Infumap-Chat-Request-Id": payload.requestId,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!fetchResult.ok) {
    throw new Error(`Chat stream request failed: ${fetchResult.status}`);
  }
  if (!fetchResult.body) {
    throw new Error("Chat stream response did not include a body.");
  }

  const reader = fetchResult.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed == "") {
      return;
    }
    const parsed = JSON.parse(trimmed);
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      typeof parsed.type !== "string" ||
      typeof parsed.requestId !== "string"
    ) {
      throw new Error("Chat stream returned a malformed event.");
    }
    onEvent(parsed as ChatStreamEvent);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      parseLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  parseLine(buffer);
}

async function fetchChatBackends(): Promise<ChatBackends> {
  const fetchResult = await fetch("/chat/models", {
    method: "GET",
    headers: { "Accept": "application/json" },
  });
  if (!fetchResult.ok) {
    throw new Error(`Chat models request failed: ${fetchResult.status}`);
  }
  return await fetchResult.json();
}

async function submitChatToolApprovalCommand(
  payload: { requestId: string, callId: string, approved: boolean },
): Promise<void> {
  const fetchResult = await fetch("/chat/tool-approval", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Infumap-Chat-Request-Id": payload.requestId,
    },
    body: JSON.stringify(payload),
  });
  if (!fetchResult.ok) {
    throw new Error(`Chat tool approval request failed: ${fetchResult.status}`);
  }
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
