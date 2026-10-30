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
import type { ChatBackendId, QueryChatSettings, QueryProfileOperation, QueryProfilesResponse } from "./items/query-configuration";
import { Item, ItemType } from "./items/base/item";
import { ItemFns } from "./items/base/item-polymorphism";
import {
  NetworkFailureReason, NetworkProblemReport, NetworkRequestInfo, NetworkRequestKind, networkProblemKey,
} from "./store/StoreProvider_General";
import type { QueryChatActivityModelRound } from "./store/StoreProvider_PerItem";
import { EMPTY_UID, SOLO_ITEM_HOLDER_PAGE_UID, UMBRELLA_PAGE_UID, Uid } from "./util/uid";
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
import { childrenLoadedBySync, initiateLoadChildItemsMaybe } from "./layout/load";

interface NetworkRequestTracker {
  setInProgressNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  addRecentNetworkRequest: (request: NetworkRequestInfo) => void,
  recordNetworkProblem: (problem: NetworkProblemReport) => void,
  resolveNetworkProblems: (key: string) => void,
  setServerReachable: (reachable: boolean) => void,
  recordSyncResult: (ok: boolean) => void,
  setNetworkActive: (active: boolean) => void,
}

// Global request tracking - will be set by store initialization
let globalRequestTracker: NetworkRequestTracker | null = null;

export function setGlobalRequestTracker(tracker: NetworkRequestTracker) {
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

export type {
  ChatBackendId, ChatModelSelection, ChatRunMode, QueryChatSettings, QueryConfiguration, QueryProfile,
} from "./items/query-configuration";

export interface ChatRequest extends QueryChatSettings {
  requestId: string,
  /** The model history, for a chat without a transcript. Omitted for a live chat. */
  messages?: Array<ChatMessage>,
  /** A query item in the Queries page whose transcript holds the chat. */
  queryItemId?: Uid,
  /** For a new live turn: the revision last seen. An existing request ID recovers its original turn. */
  expectedRevision?: number,
  /** For a live chat: the new user message. */
  text?: string,
  /** For a live chat: text attached to the new user message. */
  attachments?: Array<{ id: Uid, title: string, mimeType: string, text: string }>,
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

/** An item chosen as a chat's scope, as it resolves now: a link is described as its target. */
export interface ScopeItemDescription {
  id: Uid,
  /** False if the item is missing or unreadable, or is a link to another link: it would be left out of the scope. */
  resolved: boolean,
  /** The first line of the title. Null when untitled or unresolved. */
  title: string | null,
  itemType: string | null,
}

export interface DescribeScopeItemsResponse {
  /** In the order requested. */
  items: Array<ScopeItemDescription>,
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

export interface LinkTargetCandidate {
  id: Uid,
  itemType: string,
  title: string,
  /** The containers from a root page down to the item's parent. */
  path: Array<SearchPathElement>,
}

export interface LinkTargetCandidatesResponse {
  /** Best first. Excludes links, passwords, untitled items and items in the trash. */
  candidates: Array<LinkTargetCandidate>,
}

export interface ChatModelInfo {
  id: string,
  name: string,
  contextLength?: number,
  /** Effort levels this model accepts. Empty for a model that does not reason. */
  reasoningEfforts: Array<string>,
  defaultEffort?: string,
  reasoningMandatory: boolean,
  /** US dollars per token, when reported by the provider. */
  promptPrice?: string,
  completionPrice?: string,
}

export interface ChatBackendInfo {
  id: ChatBackendId,
  label: string,
  available: boolean,
  /** Why this backend cannot be used, when it cannot. */
  unavailableReason?: string,
  models: Array<ChatModelInfo>,
  modelsError?: string,
}

export interface ChatToolServerInfo {
  id: string,
  icons?: Array<{
    src: string,
    mimeType?: string,
    sizes?: Array<string>,
    theme?: string,
  }>,
  available: boolean,
  unavailableReason?: string,
  enabledByDefault: boolean,
  requireApproval: boolean,
  externalRequests: boolean,
  tools: Array<Record<string, unknown>>,
}

export interface ChatBackends {
  backends: Array<ChatBackendInfo>,
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

export type ChatStreamConnectionState = "connecting" | "connected" | "reconnecting";

class ChatStreamControlChanged extends Error {}

/** Only a definite pre-acceptance refusal allows the composer to return the message as an unsent draft. */
export class ChatSubmissionRejectedError extends Error {}

/** Commands share the stream's retry loop, so Stop and snapshot refresh cannot race a second finalizer. */
export class ChatStreamControl {
  cancellationRequested = false;
  onChange?: () => void;
  private refreshWaiters: Array<{ resolve: () => void, reject: (error: unknown) => void }> = [];
  private finished = false;
  private failure?: unknown;

  cancel(): void {
    if (this.cancellationRequested) { return; }
    this.cancellationRequested = true;
    this.onChange?.();
  }

  refresh(): Promise<void> {
    if (this.finished) { return this.failure == null ? Promise.resolve() : Promise.reject(this.failure); }
    return new Promise((resolve, reject) => {
      this.refreshWaiters.push({ resolve, reject });
      this.onChange?.();
    });
  }

  snapshotReceived(): void {
    this.refreshWaiters.splice(0).forEach(waiter => waiter.resolve());
  }

  finish(error?: unknown): void {
    this.finished = true;
    this.failure = error;
    this.onChange = undefined;
    this.refreshWaiters.splice(0).forEach(waiter => error == null ? waiter.resolve() : waiter.reject(error));
  }
}

export interface ChatRunSnapshot {
  revision: number,
  startedAt: number,
  endedAt: number | null,
  phase: ChatStreamPhase | "interrupted",
  statusText: string,
  rounds: Array<QueryChatActivityModelRound>,
  answerPreview: string,
  contextTokens: { tokens: number, exact: boolean } | null,
  pendingApprovals: Array<string>,
  cancellationRequested: boolean,
  errorMessage: string | null,
  result: { text: string, items: Array<object> } | null,
}

interface ChatStreamEventBase {
  requestId: string,
}

export type ChatStreamEvent = ChatStreamEventBase & (
  { type: "snapshot", snapshot: ChatRunSnapshot } |
  { type: "status", text: string } |
  { type: "model_round_started", round: number } |
  { type: "reasoning_delta", round: number, text: string } |
  { type: "answer_delta", round: number, text: string } |
  { type: "tool_approval_required", round: number, callId: string, name: string, source?: string, query?: string, url?: string, arguments?: unknown } |
  { type: "tool_call_started", round: number, callId: string, name: string, arguments?: unknown } |
  { type: "tool_call_finished", round: number, callId: string, name: string, summary: string, durationMs?: number, resultPreview?: unknown } |
  { type: "materializing" } |
  { type: "context_tokens", tokens: number, exact: boolean } |
  { type: "turn_accepted", revision: number, scopeAttachments?: Array<LoadChatAttachment> } |
  { type: "transcript_conflict", revision: number } |
  { type: "final_items", text: string, items: Array<object>, messages?: Array<ChatMessage> } |
  { type: "cancelled" } |
  { type: "error", message: string }
);

/** A live chat's transcript was not at the expected revision, so the request was not recorded. */
export class ChatTranscriptConflictError extends Error {
  constructor(public revision: number) {
    super("The chat changed since it was loaded.");
  }
}

class ChatStreamTransportError extends Error {}

class ChatStreamApplicationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

class ChatStreamHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, detail: string) {
    super(`Chat request failed (HTTP ${status})${detail == "" ? "." : `: ${detail}`}`);
  }
}

export class ChatStreamCancelledError extends Error {
  constructor() { super("The chat was cancelled."); }
}

export type ChatTurnStatus = "running" | "completed" | "cancelled" | "error" | "interrupted";

/** An attachment of a chat message, without its text: see `server.loadChatAttachment`. */
export interface LoadChatAttachment {
  id: Uid,
  title: string,
  mimeType: string,
  sizeBytes: number,
}

export interface LoadChatTurn {
  requestId: string,
  text: string,
  status: ChatTurnStatus,
  startedAt: number,
  endedAt: number | null,
  error: string | null,
  attachments: Array<LoadChatAttachment>,
  assistantText: string | null,
  items: Array<object> | null,
  rounds: Array<QueryChatActivityModelRound>,
}

export interface LoadChatResponse {
  revision: number,
  running: boolean,
  lastSettings: QueryChatSettings | null,
  contextTokens: { tokens: number, exact: boolean } | null,
  turns: Array<LoadChatTurn>,
}

export interface ContinueChatResponse {
  /** The new chat history entry, selected after Continue. */
  queryItem: object,
  /** A previously pinned chat moved into history while preparing New Query. */
  unpinnedQueryItemId: Uid | null,
  /** Retained for existing clients; Continue no longer deletes New Query. */
  deletedQueryItemId: Uid | null,
}

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

export interface EnsureQueryEntryResponse {
  queryItem: object,
  archivedQueryItems: Array<object>,
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
  startedMs?: number,
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
const COMMAND_DESCRIBE_SCOPE_ITEMS = "describe-scope-items";
const COMMAND_QUERY_PROFILES = "query-profiles";
const COMMAND_LOAD_CHAT = "load-chat";
const COMMAND_LOAD_CHAT_ATTACHMENT = "load-chat-attachment";
const COMMAND_ENSURE_QUERY_ENTRY = "ensure-query-entry";
const COMMAND_GET_BACKLINKS = "get-backlinks";
const COMMAND_LINK_TARGET_CANDIDATES = "link-target-candidates";
const COMMAND_CHAT = "chat";
const COMMAND_EMPTY_TRASH = "empty-trash";
const COMMAND_SYNC_CONTAINERS = "sync-containers";

const PARALLEL_READ_COMMANDS = new Set<string>([
  COMMAND_GET_ITEMS,
  COMMAND_SYNC_CONTAINERS,
  COMMAND_LINK_TARGET_CANDIDATES,
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
    case COMMAND_DESCRIBE_SCOPE_ITEMS:
      description = "Loading scope items";
      break;
    case COMMAND_QUERY_PROFILES:
      description = payload.operation == "list" ? "Loading query profiles" : "Saving query profiles";
      break;
    case COMMAND_GET_BACKLINKS:
      description = "Loading links";
      break;
    case COMMAND_LINK_TARGET_CANDIDATES:
      description = "Finding link targets";
      break;
    case COMMAND_CHAT:
      description = "Generating query response";
      break;
    case COMMAND_ENSURE_QUERY_ENTRY:
      description = "Preparing New Query";
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
  COMMAND_ENSURE_QUERY_ENTRY,
]);
let pendingMutationCommands = 0;
let nextNetworkRequestId = 1;
let activeContainerSyncStore: StoreContextModel | null = null;

const isMutationCommand = (command: string): boolean => MUTATION_COMMANDS.has(command);
const isParallelReadCommand = (command: string): boolean => PARALLEL_READ_COMMANDS.has(command);

function commandKind(command: string, payload: any): NetworkRequestKind {
  if (command == COMMAND_SYNC_CONTAINERS) { return "sync"; }
  if (command == COMMAND_CHAT) { return "chat"; }
  if (isMutationCommand(command)) { return "write"; }
  if (command == COMMAND_QUERY_PROFILES && payload.operation != "list") { return "write"; }
  return "read";
}

function toNetworkRequestInfo(command: ServerCommand): NetworkRequestInfo {
  const { description, itemId } = getCommandDescription(command.command, command.payload);
  return {
    requestId: command.requestId,
    host: command.host,
    command: command.command,
    kind: commandKind(command.command, command.payload),
    description,
    itemId,
    startedMs: command.startedMs,
  };
}

function startCommand(command: ServerCommand): void {
  command.startedMs = Date.now();
}

// Background sync runs every few seconds, so it is summarized by recordSyncResult rather than listed or
// shown as activity.
const isListedCommand = (command: ServerCommand): boolean => command.command != COMMAND_SYNC_CONTAINERS;

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
  return active.filter(isListedCommand);
}

function getQueuedCommands(): Array<ServerCommand> {
  return [...commandQueue, ...commandQueue_remote].filter(isListedCommand);
}

function hasAnyNetworkActivity(): boolean {
  return getInProgressCommands().length > 0 || getQueuedCommands().length > 0;
}

function syncBaseNetworkStatus(): void {
  globalRequestTracker?.setNetworkActive(hasAnyNetworkActivity());
}

function syncGlobalRequestTracker(): void {
  if (!globalRequestTracker) {
    return;
  }
  globalRequestTracker.setInProgressNetworkRequests(getInProgressCommands().map(toNetworkRequestInfo));
  globalRequestTracker.setQueuedNetworkRequests(getQueuedCommands().map(toNetworkRequestInfo));
}

const FAIL_REASONS = new Set<string>(["auth", "not-found", "server", "client"]);

export function networkFailureReason(error: unknown): NetworkFailureReason {
  if (error instanceof ChatStreamTransportError) { return "unreachable"; }
  if (error instanceof ChatStreamHttpError) {
    if (error.status == 401 || error.status == 403) { return "auth"; }
    if (error.status == 404) { return "not-found"; }
    return error.status >= 500 ? "server" : "client";
  }
  if (error instanceof CommandFailedError) {
    return error.failReason != null && FAIL_REASONS.has(error.failReason)
      ? error.failReason as NetworkFailureReason
      : "unknown";
  }
  // fetch rejects with a TypeError when the server can't be reached, and a proxy's error page is not JSON.
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return "unreachable";
  }
  return "unknown";
}

function trackNetworkCommandFinished(command: ServerCommand, outcome: "done" | "cancelled"): void {
  if (!globalRequestTracker) {
    return;
  }
  const info = toNetworkRequestInfo(command);
  if (outcome == "done") {
    globalRequestTracker.resolveNetworkProblems(networkProblemKey(info));
    if (command.host == null) {
      globalRequestTracker.setServerReachable(true);
    }
  }
  if (command.command == COMMAND_SYNC_CONTAINERS) {
    globalRequestTracker.recordSyncResult(true);
    return;
  }
  globalRequestTracker.addRecentNetworkRequest({ ...info, endedMs: Date.now(), outcome });
}

function trackNetworkCommandError(command: ServerCommand, error: any): void {
  if (!globalRequestTracker) {
    return;
  }
  const info = toNetworkRequestInfo(command);
  const reason = networkFailureReason(error);
  if (command.host == null) {
    globalRequestTracker.setServerReachable(reason != "unreachable");
  }
  if (command.command == COMMAND_SYNC_CONTAINERS) {
    globalRequestTracker.recordSyncResult(false);
  }
  // The pending text save holds the whole item and retries it, and reconciling waits for it, so nothing is lost.
  if (command.command == COMMAND_UPDATE_ITEM && info.itemId != null &&
      activeContainerSyncStore?.textEdit.hasPending(info.itemId)) {
    return;
  }
  globalRequestTracker.recordNetworkProblem({
    key: networkProblemKey(info),
    kind: info.kind,
    description: info.description,
    itemId: info.itemId,
    host: info.host,
    reason,
    message: error?.message || String(error),
  });
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

function serveWaiting() {
  syncBaseNetworkStatus();
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
      syncBaseNetworkStatus();
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
      startCommand(command);
      syncBaseNetworkStatus();
      syncGlobalRequestTracker();

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        inProgressNonGet = null;
        decrementPendingMutations(command.command);
        serveWaiting();
      };

      sendCommand(command.host, command.command, command.payload, command.base64data)
        .then((resp: any) => {
          command.resolve(resp);
          trackNetworkCommandFinished(command, "done");
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
    startCommand(command);
    syncBaseNetworkStatus();
    syncGlobalRequestTracker();

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      const index = inProgressReadCommands.findIndex(active => active.requestId === command.requestId);
      if (index !== -1) {
        inProgressReadCommands.splice(index, 1);
      }
      decrementPendingMutations(command.command);
      serveWaiting();
    };

    sendCommand(command.host, command.command, command.payload, command.base64data)
      .then((resp: any) => {
        command.resolve(resp);
        trackNetworkCommandFinished(command, "done");
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
  base64data: string | null): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      requestId: nextNetworkRequestId++,
      host, command, payload, base64data,
      resolve, reject
    };
    incrementPendingMutations(command);
    commandQueue.push(commandObj);
    serveWaiting();
  })
}

async function streamChatCommand(
  payload: ChatRequest | { requestId: string, queryItemId: Uid },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  onConnectionChange?: (state: ChatStreamConnectionState) => void,
  control?: ChatStreamControl,
  resumeOnly = false,
): Promise<ChatResponse> {
  // Serialize once: profile edits and attachment changes while reconnecting must not change the operation.
  const startBody = JSON.stringify(payload);
  const requestId = payload.requestId;
  const queryItemId = payload.queryItemId;
  const resumeBody = JSON.stringify({ requestId, queryItemId });
  const connectionChanged = (state: ChatStreamConnectionState) => {
    signal?.throwIfAborted();
    try { onConnectionChange?.(state); } catch (error) {
      signal?.throwIfAborted();
      throw new ChatStreamApplicationError(error);
    }
  };
  const commandObj: ServerCommand = {
    requestId: nextNetworkRequestId++,
    host: null,
    command: COMMAND_CHAT,
    payload,
    base64data: null,
    resolve: () => { },
    reject: () => { },
  };
  startCommand(commandObj);
  inProgressStreamingCommands.push(commandObj);
  syncBaseNetworkStatus();
  syncGlobalRequestTracker();

  let accepted = resumeOnly;
  let submissionUncertain = false;
  let attemptGeneration = 0;
  let failures = 0;
  let interrupt: AbortController | null = null;
  if (control != null) {
    control.onChange = () => {
      // Before acceptance, finish/retry the immutable start first. Otherwise an aborted start could arrive
      // after a 404 cancel response and create work after Stop appeared to succeed.
      if (accepted) { interrupt?.abort(new ChatStreamControlChanged()); }
    };
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const generation = ++attemptGeneration;
      const controller = new AbortController();
      interrupt = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); }
      const startedAt = Date.now();
      let receivedEvent = false;
      const terminal: { response?: ChatResponse, error?: Error } = {};
      const cancelling = accepted && queryItemId != null && control?.cancellationRequested;
      try {
        connectionChanged(failures == 0 ? "connecting" : "reconnecting");
        await sendChatStream(
          cancelling ? "/chat/cancel" : accepted && queryItemId != null ? "/chat/resume" : "/chat/stream",
          accepted && queryItemId != null ? resumeBody : startBody,
          requestId,
          queryItemId,
          (event) => {
            if (generation != attemptGeneration || controller.signal.aborted) {
              throw controller.signal.reason ?? new DOMException("Obsolete chat connection.", "AbortError");
            }
            if (event.requestId != requestId) {
              throw new Error("Chat stream returned an event for a different request.");
            }
            // Application errors must stop recovery, not be mistaken for fetch failures and replayed.
            try { onEvent(event); } catch (error) {
              signal?.throwIfAborted();
              throw new ChatStreamApplicationError(error);
            }
            receivedEvent = true;
            if (event.type == "snapshot") {
              accepted = true;
              const snapshot = event.snapshot;
              if (snapshot.phase == "complete") {
                terminal.response = { items: snapshot.result!.items, assistantText: snapshot.result!.text };
              } else if (snapshot.phase == "cancelled") {
                terminal.error = new ChatStreamCancelledError();
              } else if (snapshot.phase == "error" || snapshot.phase == "interrupted") {
                terminal.error = new Error(snapshot.errorMessage ?? snapshot.statusText);
              }
            } else if (event.type == "turn_accepted") {
              accepted = true;
            } else if (event.type == "final_items") {
              terminal.response = { items: event.items, assistantText: event.text, messages: event.messages };
            } else if (event.type == "cancelled") {
              terminal.error = new ChatStreamCancelledError();
            } else if (event.type == "error") {
              terminal.error = accepted ? new Error(event.message) : new ChatSubmissionRejectedError(event.message);
            } else if (event.type == "transcript_conflict") {
              terminal.error = new ChatTranscriptConflictError(event.revision);
            }
            if (event.type == "snapshot") { control?.snapshotReceived(); }
            if (!cancelling && terminal.response == null && terminal.error == null && control?.cancellationRequested &&
                (event.type == "turn_accepted" || event.type == "snapshot")) {
              throw new ChatStreamControlChanged();
            }
            return terminal.response != null || terminal.error != null;
          },
          controller,
          () => {
            if (generation == attemptGeneration && !controller.signal.aborted) { connectionChanged("connected"); }
          },
        );
        if (terminal.error != null) { throw terminal.error; }
        if (terminal.response == null) { throw new Error("Chat stream returned no terminal outcome."); }
        trackNetworkCommandFinished(commandObj, "done");
        control?.finish();
        return terminal.response;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ChatStreamControlChanged) { continue; }
        // Only live chats have server-side request deduplication. Retrying a stateless submission could execute
        // the model or tools again. EOF and network errors are retried; malformed events/callbacks never are.
        if (queryItemId == null || !isRetryableChatError(error)) { throw error; }
        if (!accepted) { submissionUncertain = true; }
        if (receivedEvent && Date.now() - startedAt >= 30_000) { failures = 0; }
      } finally {
        ++attemptGeneration;
        controller.abort();
        signal?.removeEventListener("abort", abort);
      }
      connectionChanged("reconnecting");
      const delay = Math.min(30_000, Math.max(1_000, 1_000 * 2 ** Math.min(failures++, 5) * (0.75 + Math.random() * 0.5)));
      const retryController = new AbortController();
      interrupt = retryController;
      const abortRetry = () => retryController.abort(signal?.reason);
      signal?.addEventListener("abort", abortRetry, { once: true });
      try {
        if (signal?.aborted) { abortRetry(); }
        await waitForChatRetry(delay, retryController.signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof ChatStreamControlChanged)) { throw error; }
      } finally {
        signal?.removeEventListener("abort", abortRetry);
      }
    }
  } catch (error) {
    control?.finish(error);
    if (signal?.aborted || error instanceof ChatStreamCancelledError) {
      trackNetworkCommandFinished(commandObj, "cancelled");
    } else if (error instanceof ChatTranscriptConflictError) {
      trackNetworkCommandFinished(commandObj, "done");
    } else {
      trackNetworkCommandError(commandObj, error);
    }
    if (!accepted && !submissionUncertain && error instanceof ChatStreamHttpError &&
        [400, 401, 403, 404, 409, 413, 422].includes(error.status)) {
      throw new ChatSubmissionRejectedError(error.message);
    }
    throw error;
  } finally {
    const index = inProgressStreamingCommands.findIndex(active => active.requestId === commandObj.requestId);
    if (index !== -1) {
      inProgressStreamingCommands.splice(index, 1);
    }
    syncBaseNetworkStatus();
    syncGlobalRequestTracker();
  }
}

const localContainerSyncVersions = new Map<Uid, { epoch: number | null, version: number | null }>();

// The Queries page combines a real item version with a hash of search processing status. Its version is an equality
// token, not a monotonically increasing number.
function isQueriesContainer(containerId: Uid): boolean {
  return activeContainerSyncStore?.user.getUserMaybe()?.queriesPageId == containerId;
}

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
  if (allowRegression && !isQueriesContainer(containerId) && existing && existing.epoch === normalizedEpoch &&
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
    // Mutation acknowledgements contain the real item version, not the Queries page's combined token.
    if (isQueriesContainer(container.id)) { continue; }
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
  setLocalContainerSyncVersion(
    containerId, response.syncEpoch ?? null, response.syncVersion ?? null, isQueriesContainer(containerId));
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
  // A local move or delete can remove an item while an older sync response is still in flight.
  const nextChildIds = containerItem.computed_children.filter(childId =>
    !childDeleteIds.has(childId) && itemState.get(childId) != null);

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
  if (itemState.getAsContainerItem(update.id)?.childrenLoaded) {
    childrenLoadedBySync(update.id);
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
  fetchItems: async (id: string, mode: string): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise(null, COMMAND_GET_ITEMS, { id, mode }, null)
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response));
  },

  addItemFromPartialObject: async (item: object, base64Data: string | null): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, item, base64Data)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  addItem: async (item: Item, base64Data: string | null): Promise<object> => {
    return constructCommandPromise(null, COMMAND_ADD_ITEM, ItemFns.toObject(item), base64Data)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
        return extractMutationItem(response);
      });
  },

  updateItem: async (item: Item): Promise<void> => {
    if (shouldSkipClientOnlyItemUpdate(item)) {
      console.warn(`Skipping update for client-only item '${item.id}'.`);
      return;
    }
    return constructCommandPromise(null, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  convertPageTable: async (
    id: Uid,
    expectedItemType: "page" | "table",
    targetItemType: "page" | "table",
    defaultPageAspect: number | null,
  ): Promise<object> => {
    return constructCommandPromise(
      null, COMMAND_CONVERT_PAGE_TABLE, { id, expectedItemType, targetItemType, defaultPageAspect }, null,
    ).then((response: MutationCommandResponse) => {
      if (response?.item == null) {
        throw new Error(`Conversion of item '${id}' did not return the converted item.`);
      }
      applySyncAck(response.syncAck);
      return response.item;
    });
  },

  deleteItem: async (id: Uid): Promise<void> => {
    return constructCommandPromise(null, COMMAND_DELETE_ITEM, { id }, null)
      .then((response: MutationCommandResponse) => {
        applySyncAck(response?.syncAck);
      });
  },

  search: async (
    pageIdMaybe: Uid | null,
    text: String,
    pageNum: number,
    scopeId: Uid | null,
  ): Promise<SearchResponse> => {
    return constructCommandPromise(null, COMMAND_SEARCH, {
      pageId: pageIdMaybe, text, numResults: SEARCH_RESULTS_PER_PAGE, pageNum, scopeId,
    }, null).then((response: any) => normalizeSearchResponse(response));
  },

  queryProfiles: async (
    operation: QueryProfileOperation,
    expectedUserId: Uid,
  ): Promise<QueryProfilesResponse> => {
    return constructCommandPromise(null, COMMAND_QUERY_PROFILES, { ...operation, expectedUserId }, null);
  },

  listScopes: async (): Promise<ListScopesResponse> => {
    return constructCommandPromise(null, COMMAND_LIST_SCOPES, {}, null);
  },

  /** At most 32 items. */
  describeScopeItems: async (itemIds: Array<Uid>): Promise<DescribeScopeItemsResponse> => {
    return constructCommandPromise(null, COMMAND_DESCRIBE_SCOPE_ITEMS, { itemIds }, null);
  },

  ensureQueryEntry: async (firstTurnQueryItemId: Uid | null): Promise<EnsureQueryEntryResponse> => {
    return constructCommandPromise(
      null, COMMAND_ENSURE_QUERY_ENTRY, { firstTurnQueryItemId }, null,
    ).then((response: EnsureQueryEntryResponse & { syncAck?: ContainerSyncAck }) => {
      applySyncAck(response.syncAck);
      return response;
    });
  },

  /** A live chat's transcript, for the chat view. A query item without one loads as an empty chat. */
  loadChat: async (queryItemId: Uid): Promise<LoadChatResponse> => {
    return constructCommandPromise(null, COMMAND_LOAD_CHAT, { queryItemId }, null);
  },

  /** A persisted chat's transcript, the content of a `.chat` text item, for its document page. */
  loadPersistedChat: async (chatItemId: Uid): Promise<LoadChatResponse> => {
    return constructCommandPromise(null, COMMAND_LOAD_CHAT, { chatItemId }, null);
  },

  /** The text of an attachment of a live chat (`{ queryItemId }`) or a persisted chat (`{ chatItemId }`). */
  loadChatAttachment: async (
    chat: { queryItemId: Uid } | { chatItemId: Uid },
    attachmentId: Uid,
  ): Promise<string> => {
    return constructCommandPromise(null, COMMAND_LOAD_CHAT_ATTACHMENT, { ...chat, attachmentId }, null)
      .then((response: { text: string }) => response.text);
  },

  /** The user's links and notes that refer to an item they own. Local items only: backlinks are not tracked across servers. */
  getBacklinks: async (itemId: Uid): Promise<GetBacklinksResponse> => {
    return constructCommandPromise(null, COMMAND_GET_BACKLINKS, { itemId }, null);
  },

  /**
   * The user's items whose title words start with the words of the text, best first. Local items only. The server
   * returns at most 20, and nothing for text with fewer than 2 letters or digits.
   */
  linkTargetCandidates: async (text: string, limit: number, itemType?: string): Promise<LinkTargetCandidatesResponse> => {
    return constructCommandPromise(null, COMMAND_LINK_TARGET_CANDIDATES, { text, limit, itemType }, null);
  },

  chatStream: async (
    payload: ChatRequest,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
    onConnectionChange?: (state: ChatStreamConnectionState) => void,
    control?: ChatStreamControl,
  ): Promise<ChatResponse> => {
    return streamChatCommand(payload, onEvent, signal, onConnectionChange, control);
  },

  resumeChatStream: async (
    queryItemId: Uid,
    requestId: string,
    onEvent: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
    onConnectionChange: (state: ChatStreamConnectionState) => void,
    control: ChatStreamControl,
  ): Promise<ChatResponse> => {
    return streamChatCommand({ queryItemId, requestId }, onEvent, signal, onConnectionChange, control, true);
  },

  /**
   * Gives an earlier chat a generated title, if its title is still the one derived from its first prompt. Returns its
   * title afterwards. The server applies the title itself.
   */
  generateChatTitle: async (queryItemId: Uid): Promise<{ title: string }> => {
    const fetchResult = await fetch("/chat/title", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ queryItemId }),
    });
    if (!fetchResult.ok) {
      throw new Error(`Chat title request failed: ${fetchResult.status}`);
    }
    return await fetchResult.json();
  },

  /**
   * Moves an earlier chat into the item tree as a `.chat` text item, created from `chatItem`, placed where the chat was
   * dropped; the server sets its id, title, MIME type and data. Deletes the chat's query item. Returns the new item.
   */
  persistChat: async (queryItemId: Uid, chatItem: object): Promise<{ item: object }> => {
    const fetchResult = await fetch("/chat/persist", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ queryItemId, item: chatItem }),
    });
    if (!fetchResult.ok) {
      const body = await fetchResult.json().catch(() => null);
      throw new Error(typeof body?.error == "string" ? body.error : `Keeping the chat failed: ${fetchResult.status}`);
    }
    return await fetchResult.json();
  },

  /**
   * Continues a persisted chat as the current chat in the Queries page, copying its transcript into a new pinned query
   * item. With `trashOriginal`, the `.chat` item goes to the trash (a move back); otherwise it stays (a copy).
   */
  continueChat: async (chatItemId: Uid, trashOriginal: boolean): Promise<ContinueChatResponse> => {
    const fetchResult = await fetch("/chat/continue", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ chatItemId, trashOriginal }),
    });
    if (!fetchResult.ok) {
      const body = await fetchResult.json().catch(() => null);
      throw new Error(typeof body?.error == "string" ? body.error : `Continuing the chat failed: ${fetchResult.status}`);
    }
    return await fetchResult.json();
  },

  chatBackends: async (): Promise<ChatBackends> => {
    return fetchChatBackends();
  },

  submitChatToolApproval: async (
    payload: { requestId: string, callId: string, approved: boolean },
    signal?: AbortSignal,
  ): Promise<void> => {
    return submitChatToolApprovalCommand(payload, signal);
  },

  emptyTrash: async (): Promise<EmptyTrashResult> => {
    return constructCommandPromise(null, COMMAND_EMPTY_TRASH, {}, null)
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
  ): Promise<Array<SyncContainerUpdate>> => {
    return constructCommandPromise(null, COMMAND_SYNC_CONTAINERS, { subscriptions }, null)
      .then((response: { updates?: Array<SyncContainerUpdate> }) => response.updates ?? []);
  }
}



const commandQueue_remote: Array<ServerCommand> = [];
let inProgressNonGet_remote: ServerCommand | null = null; // any non-get-items command currently running remotely
const inProgressGetItems_remote: Array<ServerCommand> = [];

function serveWaiting_remote() {
  syncBaseNetworkStatus();
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
      startCommand(command);
      syncBaseNetworkStatus();
      syncGlobalRequestTracker();

      const DEBUG = false;
      if (DEBUG) { console.debug(command.command, command.payload); }

      const finalizeCommand = () => {
        inProgressNonGet_remote = null;
        decrementPendingMutations(command.command);
        serveWaiting_remote();
      };

      sendCommand(command.host, command.command, command.payload, command.base64data)
        .then((resp: any) => {
          command.resolve(resp);
          trackNetworkCommandFinished(command, "done");
        })
        .catch((error) => {
          command.reject(error);
          trackNetworkCommandError(command, error);
          if (isMutationCommand(command.command)) {
            handleFailedRemoteMutation(command, error);
          }
        })
        .finally(finalizeCommand);

      return;
    }

    if (inProgressNonGet_remote != null) {
      return;
    }

    const command = commandQueue_remote.shift() as ServerCommand;
    inProgressGetItems_remote.push(command);
    startCommand(command);
    syncBaseNetworkStatus();
    syncGlobalRequestTracker();

    const DEBUG = false;
    if (DEBUG) { console.debug(command.command, command.payload); }

    const finalizeCommand = () => {
      const index = inProgressGetItems_remote.findIndex(active => active.requestId === command.requestId);
      if (index !== -1) {
        inProgressGetItems_remote.splice(index, 1);
      }
      decrementPendingMutations(command.command);
      serveWaiting_remote();
    };

    sendCommand(command.host, command.command, command.payload, command.base64data)
      .then((resp: any) => {
        command.resolve(resp);
        trackNetworkCommandFinished(command, "done");
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
  base64data: string | null): Promise<any> {
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    const commandObj: ServerCommand = {
      requestId: nextNetworkRequestId++,
      host, command, payload, base64data,
      resolve, reject
    };
    incrementPendingMutations(command);
    commandQueue_remote.push(commandObj);
    serveWaiting_remote();
  })
}

export const remote = {
  /**
   * fetch an item and/or it's children and their attachments.
   */
  fetchItems: async (host: string, id: string, mode: string): Promise<ItemsAndTheirAttachments> => {
    return constructCommandPromise_remote(host, COMMAND_GET_ITEMS, { id, mode }, null)
      .then((response: any) => normalizeFetchedItemsResponse(id, mode, response, false));
  },

  /**
   * update an item
   */
  updateItem: async (host: string, item: Item): Promise<void> => {
    if (shouldSkipClientOnlyItemUpdate(item)) {
      console.warn(`Skipping remote update for client-only item '${item.id}'.`);
      return;
    }
    return constructCommandPromise_remote(host, COMMAND_UPDATE_ITEM, ItemFns.toObject(item), null);
  },

}


export const serverOrRemote = {
  updateItem: async (item: Item) => {
    if (item.origin == null) {
      await server.updateItem(item);
    } else {
      await remote.updateItem(item.origin, item);
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

/** As textEditInProgressForContainerSync, also recording whether sync is paused for the network status. */
function containerSyncPausedForTextEdit(store: StoreContextModel): boolean {
  const paused = textEditInProgressForContainerSync(store);
  store.general.setSyncPausedReason(paused ? "text-edit" : null);
  return paused;
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

  if (containerSyncPausedForTextEdit(targetStore)) {
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
  if (containerSyncPausedForTextEdit(store)) {
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

  if (!isTextSaveRetry(store, command)) {
    showFailedMutationMessage(store, error);
  }
  if (error instanceof CommandFailedError) {
    void logoutIfSessionEnded(store);
  }
  requestContainerSyncSoon(store);
}

/**
 * Remote containers are not synced, so unlike handleFailedMutation this can't reconcile the item: the local copy
 * keeps the change until the remote item is loaded again.
 */
function handleFailedRemoteMutation(command: ServerCommand, error: unknown): void {
  const store = activeContainerSyncStore;
  if (store == null || isTextSaveRetry(store, command)) {
    return;
  }
  showFailedMutationMessage(store, error, command.host);
}

/** A failing text save is retried on a timer, and the network status shows it, so only its first failure is shown. */
function isTextSaveRetry(store: StoreContextModel, command: ServerCommand): boolean {
  const payload = command.payload as { id?: unknown };
  return command.command == COMMAND_UPDATE_ITEM && typeof payload.id == "string" &&
    store.textEdit.failedSaves().some(save => save.itemId == payload.id);
}

function hostLabel(host: string): string {
  try {
    return new URL(host).host;
  } catch (_e) {
    return host;
  }
}

function showFailedMutationMessage(store: StoreContextModel, error: unknown, host: string | null = null): void {
  // The open network status dialog shows the failure, and the message would cover its top.
  if (store.overlay.networkOverlayVisible.get()) {
    return;
  }
  const where = host == null ? "the server" : hostLabel(host);
  const text = !(error instanceof CommandFailedError)
    ? `Couldn't save change: ${where} could not be reached.`
    : error.failReason == "not-found"
      ? "Couldn't save change: the item no longer exists."
      : host == null ? "Couldn't save change." : `Couldn't save change on ${where}.`;
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
  // Once known to have ended, only recheckExpiredSession looks again.
  if (sessionCheckInFlight || userId == null || logoutMaybe == null || store.general.sessionExpired()) {
    return;
  }
  // Held through the logout, which saves pending text edits: those fail too, and must not start another.
  sessionCheckInFlight = true;
  try {
    const r = await post(null, "/account/validate-session", {});
    // A different user may have logged in, in another tab.
    if (r?.success === false || (r?.success === true && r.userId !== userId)) {
      if (!await logoutMaybe()) {
        // Unsaved text keeps the user here: to save it after logging in again in another tab, copy it, or discard it.
        store.general.setSessionExpired(true);
      }
    }
  } catch (_e) {
    // Without a response, whether the session has ended is unknown.
  } finally {
    sessionCheckInFlight = false;
  }
}

/**
 * After the session ended with text unsaved, checks whether the same user has logged in again (in another tab,
 * sharing the session cookie), and if so saves the text.
 */
export async function recheckExpiredSession(store: StoreContextModel): Promise<void> {
  const userId = store.user.getUserMaybe()?.userId;
  if (!store.general.sessionExpired() || sessionCheckInFlight || userId == null) {
    return;
  }
  sessionCheckInFlight = true;
  try {
    const r = await post(null, "/account/validate-session", {});
    if (r?.success === true && r.userId === userId) {
      store.general.setSessionExpired(false);
      void store.textEdit.flush();
    }
  } catch (_e) {
    // Try again on the next check.
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
    server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY)));
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
  if (containerSyncPausedForTextEdit(store)) {
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

    const updates = await server.syncContainers(subscriptions);
    if (containerSyncPausedForTextEdit(store)) {
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

    // A sync deletion can remove the currently focused item, including the selected panel of a list page.
    const focusPath = store.history.getFocusPathMaybe();
    if (focusPath != null && focusPath.split("-").some(part =>
      part != UMBRELLA_PAGE_UID && itemState.get(VeFns.veidFromPath(part).itemId) == null)) {
      store.history.popAllPopups();
      const pagePath = store.history.currentPagePath();
      if (pagePath != null && itemState.get(VeFns.veidFromPath(pagePath).itemId) != null) {
        store.history.setFocus(pagePath);
        shouldArrange = true;
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
      void recheckExpiredSession(store);
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

function isRetryableChatError(error: unknown): boolean {
  return error instanceof ChatStreamTransportError ||
    (error instanceof ChatStreamHttpError && ([408, 429, 500, 502, 503, 504].includes(error.status) ||
      (error.status == 409 && error.code == "chat_busy"))) ||
    (error instanceof CommandFailedError && error.failReason == "server");
}

function waitForChatRetry(delay: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", ready);
      window.removeEventListener("focus", ready);
      signal?.removeEventListener("abort", abort);
    };
    const ready = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    const timer = window.setTimeout(ready, delay);
    window.addEventListener("online", ready);
    window.addEventListener("focus", ready);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); }
  });
}

function isChatRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value == "object" && !Array.isArray(value);
}

function parseChatJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new Error("The chat server returned invalid JSON.");
  }
}

const chatNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const chatItems = (value: unknown): value is Array<object> => Array.isArray(value) && value.every(isChatRecord);
const chatNullableString = (value: unknown): boolean => value == null || typeof value == "string";

function validChatRounds(value: unknown): value is Array<QueryChatActivityModelRound> {
  return Array.isArray(value) && value.every(round => isChatRecord(round) && chatNumber(round.number) &&
    typeof round.reasoning == "string" && typeof round.answer == "string" && typeof round.complete == "boolean" &&
    Array.isArray(round.toolCalls) && round.toolCalls.every(call => isChatRecord(call) &&
      typeof call.callId == "string" && typeof call.name == "string" &&
      typeof call.status == "string" && ["running", "complete", "awaiting_approval"].includes(call.status) && chatNullableString(call.summary) &&
      [call.source, call.query, call.url].every(chatNullableString) && (call.durationMs == null || chatNumber(call.durationMs))));
}

function validChatSnapshot(value: unknown): value is ChatRunSnapshot {
  if (!isChatRecord(value)) { return false; }
  const phases = ["submitted", "thinking", "answering", "awaiting_approval", "using_tools", "materializing", "complete", "cancelled", "error", "interrupted"];
  return chatNumber(value.revision) && value.revision > 0 && chatNumber(value.startedAt) &&
    (value.endedAt === null || chatNumber(value.endedAt)) && typeof value.phase == "string" && phases.includes(value.phase) &&
    typeof value.statusText == "string" && validChatRounds(value.rounds) && typeof value.answerPreview == "string" &&
    (value.contextTokens === null || (isChatRecord(value.contextTokens) && chatNumber(value.contextTokens.tokens) &&
      typeof value.contextTokens.exact == "boolean")) &&
    Array.isArray(value.pendingApprovals) && value.pendingApprovals.every(id => typeof id == "string") &&
    typeof value.cancellationRequested == "boolean" && chatNullableString(value.errorMessage) &&
    (value.result === null || (isChatRecord(value.result) && typeof value.result.text == "string" && chatItems(value.result.items))) &&
    (value.phase != "complete" || value.result != null);
}

function parseChatStreamEvent(value: unknown): ChatStreamEvent {
  if (!isChatRecord(value) || typeof value.requestId != "string" || typeof value.type != "string") {
    throw new Error("Chat stream returned a malformed event.");
  }
  let valid: boolean;
  switch (value.type) {
    case "snapshot": valid = validChatSnapshot(value.snapshot); break;
    case "status": valid = typeof value.text == "string"; break;
    case "model_round_started": valid = chatNumber(value.round); break;
    case "reasoning_delta":
    case "answer_delta": valid = chatNumber(value.round) && typeof value.text == "string"; break;
    case "tool_approval_required":
    case "tool_call_started":
    case "tool_call_finished":
      valid = chatNumber(value.round) && typeof value.callId == "string" && typeof value.name == "string" &&
        [value.source, value.query, value.url].every(chatNullableString) &&
        (value.type != "tool_call_finished" || (typeof value.summary == "string" && chatNumber(value.durationMs)));
      break;
    case "turn_accepted":
      valid = chatNumber(value.revision) && (value.scopeAttachments == null || (Array.isArray(value.scopeAttachments) &&
        value.scopeAttachments.every(attachment => isChatRecord(attachment) && typeof attachment.id == "string" &&
          typeof attachment.title == "string" && typeof attachment.mimeType == "string" && chatNumber(attachment.sizeBytes))));
      break;
    case "transcript_conflict": valid = chatNumber(value.revision); break;
    case "context_tokens": valid = chatNumber(value.tokens) && typeof value.exact == "boolean"; break;
    case "final_items":
      valid = typeof value.text == "string" && chatItems(value.items) && (value.messages == null ||
        (Array.isArray(value.messages) && value.messages.every(message => isChatRecord(message) && typeof message.role == "string")));
      break;
    case "error": valid = typeof value.message == "string"; break;
    case "materializing":
    case "cancelled": valid = true; break;
    default: valid = false;
  }
  if (!valid) { throw new Error(`Chat stream returned an invalid '${value.type}' event.`); }
  return value as unknown as ChatStreamEvent;
}

async function chatHttpError(response: Response, readText: (response: Response) => Promise<string>): Promise<ChatStreamHttpError> {
  const text = await readText(response);
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body: unknown = JSON.parse(text);
    if (isChatRecord(body)) {
      if (typeof body.error == "string") { detail = body.error.slice(0, 300); }
      if (typeof body.code == "string") { code = body.code; }
    }
  } catch { /* A proxy's HTML/empty error response is still an HTTP error, not a JSON failure. */ }
  return new ChatStreamHttpError(response.status, code, detail);
}

async function reconcileMissingChatRun(
  queryItemId: Uid,
  requestId: string,
  fetchResponse: (path: string, body: string, accept: string) => Promise<Response>,
  readText: (response: Response) => Promise<string>,
): Promise<ChatStreamEvent> {
  const response = await fetchResponse("/command", JSON.stringify({
    command: COMMAND_LOAD_CHAT, jsonData: JSON.stringify({ queryItemId }),
  }), "application/json");
  if (!response.ok) { throw await chatHttpError(response, readText); }
  const envelope = parseChatJson(await readText(response));
  if (!isChatRecord(envelope) || typeof envelope.success != "boolean") { throw new Error("Invalid chat transcript response."); }
  if (!envelope.success) {
    throw new CommandFailedError(COMMAND_LOAD_CHAT, typeof envelope.failReason == "string" ? envelope.failReason : null);
  }
  if (typeof envelope.jsonData != "string") { throw new Error("Missing chat transcript response."); }
  const loaded = parseChatJson(envelope.jsonData);
  if (!isChatRecord(loaded) || !Array.isArray(loaded.turns)) { throw new Error("Invalid chat transcript."); }
  const index = loaded.turns.findIndex(turn => isChatRecord(turn) && turn.requestId == requestId);
  if (index == -1) { throw new Error("The server no longer has this recorded response. Reopen the chat to reconcile its history."); }
  const turn = loaded.turns[index];
  if (!isChatRecord(turn) || typeof turn.status != "string") { throw new Error("Invalid saved chat turn."); }
  if (turn.status == "running") { throw new ChatStreamTransportError("The recorded response is still running; retrying resume."); }
  const phases: Record<string, string> = { completed: "complete", cancelled: "cancelled", error: "error", interrupted: "interrupted" };
  return parseChatStreamEvent({
    requestId, type: "snapshot", snapshot: {
      revision: index + 1, startedAt: turn.startedAt, endedAt: turn.endedAt, phase: phases[turn.status],
      statusText: turn.status == "completed" ? "Chat complete" : `Chat ${turn.status}`,
      rounds: turn.rounds, answerPreview: turn.assistantText ?? "",
      contextTokens: index == loaded.turns.length - 1 ? loaded.contextTokens : null,
      pendingApprovals: [], cancellationRequested: false,
      errorMessage: turn.error ?? (turn.status == "interrupted" ? "The server stopped before this response finished." : null),
      result: turn.status == "completed" ? { text: turn.assistantText, items: turn.items } : null,
    },
  });
}

async function sendChatStream(
  path: string,
  body: string,
  requestId: string,
  queryItemId: Uid | undefined,
  onEvent: (event: ChatStreamEvent) => boolean,
  controller: AbortController,
  onConnected: () => void,
): Promise<void> {
  const signal = controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let watchdog: number | undefined;
  let lastActivity = Date.now();
  const armWatchdog = () => {
    window.clearTimeout(watchdog);
    if (document.visibilityState != "hidden" && !signal.aborted) {
      watchdog = window.setTimeout(() => {
        if (document.visibilityState != "hidden") {
          controller.abort(new ChatStreamTransportError("The chat connection received no data for 45 seconds."));
        }
      }, Math.max(0, 45_000 - (Date.now() - lastActivity)));
    }
  };
  const activity = () => { lastActivity = Date.now(); armWatchdog(); };
  const fetchResponse = async (url: string, data: string, accept: string): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", headers: { "Accept": accept, "Content-Type": "application/json", "X-Infumap-Chat-Request-Id": requestId },
        body: data, signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new ChatStreamTransportError(error instanceof Error ? error.message : "Could not reach the chat server.");
    }
    signal.throwIfAborted();
    activity();
    return response;
  };
  const readChunk = async (source: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await source.read(); } catch (error) {
      signal.throwIfAborted();
      throw new ChatStreamTransportError(error instanceof Error ? error.message : "Could not read the chat response.");
    }
    signal.throwIfAborted();
    if (!chunk.done && chunk.value.byteLength > 0) { activity(); }
    return chunk;
  };
  const readText = async (response: Response): Promise<string> => {
    if (!response.body) { return ""; }
    const source = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const chunk = await readChunk(source);
        if (chunk.done) { return text + decoder.decode(); }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      void source.cancel().catch(() => {});
      source.releaseLock();
    }
  };
  document.addEventListener("visibilitychange", armWatchdog);
  window.addEventListener("focus", armWatchdog);
  armWatchdog();
  try {
    const response = await fetchResponse(path, body, path == "/chat/cancel" ? "application/json" : "application/x-ndjson");
    if ((path == "/chat/resume" || path == "/chat/cancel") && response.status == 404 && queryItemId != null) {
      // A missing run must never fall back to resubmitting an accepted prompt. Consult its saved transcript,
      // using this attempt's abort signal/watchdog so account changes also cancel reconciliation.
      void response.body?.cancel().catch(() => {});
      const recovered = await reconcileMissingChatRun(queryItemId, requestId, fetchResponse, readText);
      signal.throwIfAborted();
      onConnected();
      if (!onEvent(recovered)) { throw new Error("Chat reconciliation returned no terminal outcome."); }
      return;
    }
    if (!response.ok) { throw await chatHttpError(response, readText); }
    if (path == "/chat/cancel") {
      const snapshot = parseChatJson(await readText(response));
      if (!validChatSnapshot(snapshot)) { throw new Error("Invalid chat cancellation outcome."); }
      onConnected();
      if (!onEvent({ requestId, type: "snapshot", snapshot })) {
        throw new ChatStreamTransportError("Chat cancellation is still pending.");
      }
      return;
    }
    if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/x-ndjson") || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Chat stream response was not NDJSON. Check the server or proxy configuration.");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let firstEvent = true;
    const parseLine = (line: string): boolean => {
      if (line.trim() == "") { return false; }
      signal.throwIfAborted();
      const event = parseChatStreamEvent(parseChatJson(line));
      if (firstEvent && path == "/chat/resume" && event.type != "snapshot") {
        throw new Error("Resuming a chat requires an initial snapshot.");
      }
      const terminal = onEvent(event);
      // Until the first event (the snapshot on resume) is applied, old approval prompts must stay disabled.
      if (firstEvent) { firstEvent = false; onConnected(); }
      return terminal;
    };
    while (true) {
      const chunk = await readChunk(reader);
      if (chunk.done) {
        try { buffer += decoder.decode(); } catch {
          throw new ChatStreamTransportError("The chat stream ended in an incomplete text sequence.");
        }
        if (buffer.trim() != "") {
          // A dropped connection may end in the middle of JSON; a complete terminal record still counts even
          // if only its trailing newline was lost. Other premature EOF is recovered using a new parser.
          try { JSON.parse(buffer); } catch { throw new ChatStreamTransportError("The chat stream ended in an incomplete event."); }
          if (parseLine(buffer)) { return; }
        }
        throw new ChatStreamTransportError("The chat stream ended before its terminal outcome.");
      }
      // readChunk resets the watchdog for every byte, including blank heartbeat frames.
      try { buffer += decoder.decode(chunk.value, { stream: true }); } catch {
        throw new Error("Chat stream returned invalid UTF-8 text.");
      }
      let newline = buffer.indexOf("\n");
      while (newline != -1) {
        if (parseLine(buffer.slice(0, newline))) { return; }
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    window.clearTimeout(watchdog);
    document.removeEventListener("visibilitychange", armWatchdog);
    window.removeEventListener("focus", armWatchdog);
    // Stop immediately after a terminal event; a later reset or malformed trailing frame cannot revoke it.
    controller.abort();
    if (reader != null) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
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
  signal?: AbortSignal,
): Promise<void> {
  const fetchResult = await fetch("/chat/tool-approval", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Infumap-Chat-Request-Id": payload.requestId,
    },
    body: JSON.stringify(payload),
    signal,
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
