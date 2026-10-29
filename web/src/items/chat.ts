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

import { requestArrange } from "../layout/arrange";
import { markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { batch, createEffect, createRoot, createSignal } from "solid-js";
import { asAttachmentsItem, isAttachmentsItem } from "./base/attachments-item";
import { asContainerItem, isContainer } from "./base/container-item";
import { CompositeFlags, PageFlags } from "./base/flags-item";
import { ClientOnlyItemKind, Item } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { TableFns, asTableItem, isTable } from "./table-item";
import { CompositeFns, asCompositeItem, isComposite } from "./composite-item";
import { NoteFns } from "./note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import { ensureQueryEntryUnderQueries } from "./query-entry";
import { QueryItem, asQueryItem, getQueryRuntime, isQueryItem, setQueryMode, updateQueryRuntime } from "./query-item";
import {
  ensureQueryConfigurationReady,
  restoreQueryConfiguration,
  setQueryConfigurationCapability,
  snapshotQueryChatSettings,
  updateQueryConfiguration,
} from "./query-configuration-state";
import { clearQueryChatCompletedActivityUi } from "./query-chat-activity-ui";
import { queryConfigurationUnavailableReason, refreshQueryConfigurationAvailability } from "./query-configuration-availability";
import {
  ChatStreamControl,
  ChatSubmissionRejectedError,
  ChatTranscriptConflictError,
  server,
  type ChatModelSelection,
  type ChatRequest,
  type ChatStreamEvent,
  type ChatStreamConnectionState,
  type ChatStreamPhase,
  type LoadChatAttachment,
  type LoadChatResponse,
  type LoadChatTurn,
} from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import {
  type ChatCapability,
  type QueryChatActivityModelRound,
  type QueryChatActivityToolCall,
  type QueryChatCompletedActivity,
} from "../store/StoreProvider_PerItem";
import { compareOrderings, newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import {
  ChatDraftAttachment,
  chatAttachmentSizeBytes,
  createChatAttachmentItem,
  estimateChatAttachmentTokens,
} from "./chat-attachment";
import { seedChatAttachmentContent } from "./text-document";

function markAsQueryChatPage(item: Item): void {
  item.clientOnly = true;
  item.clientOnlyKind = ClientOnlyItemKind.QueryChatPage;
  makeQueryChatItemReadOnly(item);
}

function makeQueryChatItemReadOnly(item: Item): void {
  item.capabilities = {
    edit: false,
    move: false,
    copy: false,
    resize: false,
  };
}

/** A turn can be copied out of the chat by shift-dragging it, with its content; nothing in the chat can be moved. */
function makeQueryChatTurnCopyable(item: Item): void {
  item.capabilities = { ...item.capabilities, copy: true };
}

export type ChatStreamingToolCall = QueryChatActivityToolCall;
export type ChatStreamingModelRound = QueryChatActivityModelRound;

export interface ChatStreamingState {
  requestId: string,
  phase: ChatStreamPhase,
  statusText: string,
  rounds: Array<ChatStreamingModelRound>,
  answerPreview: string,
  startedAt: number,
  errorMessage: string | null,
  connectionState?: ChatStreamConnectionState,
  endedAt?: number | null,
  pendingApprovals?: Array<string>,
  cancellationRequested?: boolean,
  recoveryError?: string,
}

const chatStreamingStateByQueryId = new Map<Uid, ChatStreamingState>();
const [chatStreamingStateRevision, setChatStreamingStateRevision] = createSignal(0, { equals: false });

interface ActiveQueryChatRequest {
  requestId: string,
  controller: AbortController,
  control: ChatStreamControl,
  approvals: Set<string>,
}

// Sessions belong to the query rather than a mounted Query component: navigation and another rendering of
// the same item share its activity. Explicit view clearing/account teardown detaches; only Stop cancels.
const activeQueryChatRequestByQueryId = new Map<Uid, ActiveQueryChatRequest>();

interface BufferedChatTextDelta {
  type: "reasoning_delta" | "answer_delta",
  round: number,
  text: string,
}

interface BufferedChatTextDeltas {
  requestId: string,
  deltas: Array<BufferedChatTextDelta>,
  animationFrameId: number | null,
}

const bufferedChatTextDeltasByQueryId = new Map<Uid, BufferedChatTextDeltas>();

export function chatStreamingStateForQuery(queryId: Uid): ChatStreamingState | null {
  chatStreamingStateRevision();
  return chatStreamingStateByQueryId.get(queryId) ?? null;
}

function setQueryChatStreamingState(queryId: Uid, state: ChatStreamingState): void {
  chatStreamingStateByQueryId.set(queryId, state);
  setChatStreamingStateRevision(chatStreamingStateRevision() + 1);
}

function discardBufferedChatTextDeltas(queryId: Uid, requestId?: string): void {
  const buffered = bufferedChatTextDeltasByQueryId.get(queryId);
  if (buffered == null || (requestId != null && buffered.requestId != requestId)) {
    return;
  }
  if (buffered.animationFrameId != null) {
    window.cancelAnimationFrame(buffered.animationFrameId);
  }
  bufferedChatTextDeltasByQueryId.delete(queryId);
}

function clearQueryChatStreamingState(queryId: Uid, requestId?: string): void {
  discardBufferedChatTextDeltas(queryId, requestId);
  const current = chatStreamingStateByQueryId.get(queryId);
  if (current == null || (requestId != null && current.requestId != requestId)) {
    return;
  }
  chatStreamingStateByQueryId.delete(queryId);
  setChatStreamingStateRevision(chatStreamingStateRevision() + 1);
}

export function cancelQueryChatRequest(queryId: Uid): boolean {
  const activeRequest = activeQueryChatRequestByQueryId.get(queryId);
  const current = chatStreamingStateByQueryId.get(queryId);
  if (activeRequest == null || current == null || current.requestId != activeRequest.requestId) {
    return false;
  }
  if (current.phase == "complete" || current.phase == "cancelled" || current.phase == "error") {
    return false;
  }

  setQueryChatStreamingState(queryId, { ...current, cancellationRequested: true });
  activeRequest.control.cancel();
  return true;
}

/** Clearing a view only detaches this viewer. Stop is a separate, explicit server operation. */
function detachQueryChatRequest(queryId: Uid): void {
  const active = activeQueryChatRequestByQueryId.get(queryId);
  activeQueryChatRequestByQueryId.delete(queryId);
  active?.controller.abort();
  discardBufferedChatTextDeltas(queryId);
}

/** Store teardown precedes logout's HTTP acknowledgement; detach before the emptied store can be repopulated. */
export function clearQueryChatSessions(): void {
  const queryIds = new Set([...activeQueryChatRequestByQueryId.keys(), ...queryChatLoads.keys(), ...chatStreamingStateByQueryId.keys()]);
  for (const queryId of queryIds) {
    queryChatGenerations.set(queryId, (queryChatGenerations.get(queryId) ?? 0) + 1);
    detachQueryChatRequest(queryId);
    clearQueryChatStreamingState(queryId);
  }
  queryChatLoads.clear();
}

export function queryChatConnectionStatus(state: ChatStreamingState): string {
  if (["complete", "cancelled", "error"].includes(state.phase)) { return state.statusText; }
  if (state.cancellationRequested) {
    return state.connectionState == "reconnecting" ? "Stop pending — reconnecting…" : "Stopping…";
  }
  if (state.recoveryError) { return `Unable to reconnect: ${state.recoveryError}. Retrying…`; }
  if (state.connectionState == "reconnecting") { return "Reconnecting…"; }
  if (state.connectionState == "connecting") { return "Connecting…"; }
  return state.statusText;
}

export async function submitQueryChatToolApproval(
  requestId: string,
  callId: string,
  approved: boolean,
): Promise<boolean> {
  const entry = [...activeQueryChatRequestByQueryId].find(([, active]) => active.requestId == requestId);
  if (entry == null) { return false; }
  const [queryId, active] = entry;
  const state = chatStreamingStateByQueryId.get(queryId);
  if (active.approvals.has(callId) || active.control.cancellationRequested ||
      state?.connectionState != "connected" || !state.pendingApprovals?.includes(callId)) { return false; }
  active.approvals.add(callId);
  try {
    // A lost acknowledgement says nothing about whether the decision was applied. Never resend it;
    // reconnect and let an authoritative snapshot decide whether the buttons can become usable again.
    try {
      await server.submitChatToolApproval({ requestId, callId, approved },
        AbortSignal.any([active.controller.signal, AbortSignal.timeout(45_000)]));
    } catch (error) {
      console.warn("Chat approval acknowledgement unavailable; refreshing the run:", error);
    }
    if (activeQueryChatRequestByQueryId.get(queryId) != active) { return false; }
    await active.control.refresh();
    const current = chatStreamingStateByQueryId.get(queryId);
    return activeQueryChatRequestByQueryId.get(queryId) == active && !active.control.cancellationRequested &&
      current?.pendingApprovals?.includes(callId) == true;
  } finally {
    active.approvals.delete(callId);
  }
}

function chatStatusTextFromEvent(event: ChatStreamEvent): string {
  switch (event.type) {
    case "snapshot":
      return event.snapshot.statusText;
    case "status":
      return event.text;
    case "model_round_started":
      return "Asking model";
    case "reasoning_delta":
      return "Thinking";
    case "answer_delta":
      return "Answering";
    case "tool_approval_required":
      if (event.name == "web_search") {
        return "Waiting to search the web";
      }
      if (event.name == "web_fetch") {
        return "Waiting to fetch page";
      }
      return "Waiting for approval";
    case "tool_call_started":
      if (event.name == "infumap_search" || event.name == "find" || event.name == "lexical_search") {
        return "Finding items";
      }
      if (event.name == "search_text") {
        return "Searching source text";
      }
      if (event.name == "infumap_get_fragment") {
        return "Reading Infumap item";
      }
      if (event.name == "web_search") {
        return "Searching the web";
      }
      if (event.name == "web_fetch") {
        return "Fetching page";
      }
      return `Running ${event.name}`;
    case "tool_call_finished":
      if (event.name == "infumap_search" || event.name == "find" || event.name == "lexical_search") {
        return "Find complete";
      }
      if (event.name == "search_text") {
        return "Search complete";
      }
      if (event.name == "infumap_get_fragment") {
        return "Item read";
      }
      return event.summary;
    case "context_tokens":
    case "turn_accepted":
    case "transcript_conflict":
      return "";
    case "materializing":
      return "Adding response";
    case "final_items":
      return "Adding response";
    case "cancelled":
      return "Chat cancelled";
    case "error":
      return event.message.trim() == "" ? "Chat failed" : event.message;
  }
}

function emptyStreamingModelRound(number: number): ChatStreamingModelRound {
  return { number, reasoning: "", answer: "", toolCalls: [], complete: false };
}

function updateStreamingModelRound(
  rounds: Array<ChatStreamingModelRound>,
  roundNumber: number,
  update: (round: ChatStreamingModelRound) => ChatStreamingModelRound,
): Array<ChatStreamingModelRound> {
  const existingIndex = rounds.findIndex(round => round.number == roundNumber);
  if (existingIndex == -1) {
    return [...rounds, update(emptyStreamingModelRound(roundNumber))];
  }
  return rounds.map((round, index) => index == existingIndex ? update(round) : round);
}

function completeStreamingModelRounds(rounds: Array<ChatStreamingModelRound>): Array<ChatStreamingModelRound> {
  return rounds.map(round => round.complete ? round : { ...round, complete: true });
}

function updateStreamingToolCall(
  toolCalls: Array<ChatStreamingToolCall>,
  updated: ChatStreamingToolCall,
): Array<ChatStreamingToolCall> {
  const existingIndex = toolCalls.findIndex(toolCall => toolCall.callId == updated.callId);
  return existingIndex == -1
    ? [...toolCalls, updated]
    : toolCalls.map((toolCall, index) => index == existingIndex ? updated : toolCall);
}

function reduceQueryChatStreamEvent(current: ChatStreamingState, event: ChatStreamEvent): ChatStreamingState {
  if (event.type == "context_tokens" || event.type == "turn_accepted" || event.type == "transcript_conflict") {
    return current;
  }
  const statusText = chatStatusTextFromEvent(event);
  let next: ChatStreamingState;
  switch (event.type) {
    case "snapshot": {
      const snapshot = event.snapshot;
      return {
        ...current,
        phase: snapshot.phase == "interrupted" ? "error" : snapshot.phase,
        statusText: snapshot.statusText,
        rounds: snapshot.rounds,
        answerPreview: snapshot.answerPreview,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
        errorMessage: snapshot.errorMessage,
        pendingApprovals: snapshot.pendingApprovals,
        cancellationRequested: current.cancellationRequested || snapshot.cancellationRequested,
        recoveryError: undefined,
      };
    }
    case "status":
      next = { ...current, statusText };
      break;
    case "model_round_started":
      next = {
        ...current,
        phase: "thinking",
        statusText,
        rounds: updateStreamingModelRound(
          completeStreamingModelRounds(current.rounds),
          event.round,
          round => ({ ...round, complete: false }),
        ),
        answerPreview: "",
      };
      break;
    case "reasoning_delta":
      next = {
        ...current,
        phase: "thinking",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => ({
          ...round,
          reasoning: round.reasoning + event.text,
        })),
      };
      break;
    case "answer_delta":
      next = {
        ...current,
        phase: "answering",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => ({
          ...round,
          answer: round.answer + event.text,
        })),
        answerPreview: current.answerPreview + event.text,
      };
      break;
    case "tool_approval_required":
      next = {
        ...current,
        phase: "awaiting_approval",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => ({
          ...round,
          complete: true,
          toolCalls: updateStreamingToolCall(round.toolCalls, {
            callId: event.callId,
            name: event.name,
            status: "awaiting_approval",
            source: event.source,
            summary: null,
            arguments: event.arguments,
            query: event.query,
            url: event.url,
          }),
        })),
      };
      break;
    case "tool_call_started":
      next = {
        ...current,
        phase: "using_tools",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => {
          const existing = round.toolCalls.find(toolCall => toolCall.callId == event.callId);
          return {
            ...round,
            complete: true,
            toolCalls: updateStreamingToolCall(round.toolCalls, {
              callId: event.callId,
              name: event.name,
              status: "running",
              source: existing?.source,
              summary: null,
              arguments: event.arguments ?? existing?.arguments,
              query: existing?.query,
              url: existing?.url,
            }),
          };
        }),
      };
      break;
    case "tool_call_finished":
      next = {
        ...current,
        phase: "using_tools",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => {
          const existingIndex = round.toolCalls.findIndex(toolCall => toolCall.callId == event.callId);
          const existing = existingIndex == -1 ? null : round.toolCalls[existingIndex];
          const completed = {
            callId: event.callId,
            name: event.name,
            status: "complete" as const,
            source: existing?.source,
            summary: event.summary,
            arguments: existing?.arguments,
            query: existing?.query,
            url: existing?.url,
            durationMs: event.durationMs,
            resultPreview: event.resultPreview,
          };
          return {
            ...round,
            complete: true,
            toolCalls: updateStreamingToolCall(round.toolCalls, completed),
          };
        }),
      };
      break;
    case "materializing":
      next = {
        ...current,
        phase: "materializing",
        statusText,
        rounds: completeStreamingModelRounds(current.rounds),
      };
      break;
    case "final_items":
      next = {
        ...current,
        phase: "complete",
        statusText,
        rounds: completeStreamingModelRounds(current.rounds),
        answerPreview: event.text,
      };
      break;
    case "cancelled":
      next = {
        ...current,
        phase: "cancelled",
        statusText,
        rounds: completeStreamingModelRounds(current.rounds),
      };
      break;
    case "error":
      next = {
        ...current,
        phase: "error",
        statusText,
        rounds: completeStreamingModelRounds(current.rounds),
        errorMessage: event.message,
      };
      break;
  }
  if (event.type == "tool_approval_required") {
    next.pendingApprovals = [...(current.pendingApprovals ?? []).filter(id => id != event.callId), event.callId];
  } else if (event.type == "tool_call_started" || event.type == "tool_call_finished") {
    next.pendingApprovals = current.pendingApprovals?.filter(id => id != event.callId);
  }
  return next;
}

function flushBufferedChatTextDeltas(queryId: Uid, requestId: string): void {
  const buffered = bufferedChatTextDeltasByQueryId.get(queryId);
  if (buffered == null || buffered.requestId != requestId) {
    return;
  }
  if (buffered.animationFrameId != null) {
    window.cancelAnimationFrame(buffered.animationFrameId);
  }
  bufferedChatTextDeltasByQueryId.delete(queryId);

  const current = chatStreamingStateByQueryId.get(queryId);
  if (current == null || current.requestId != requestId) {
    return;
  }
  const next = buffered.deltas.reduce<ChatStreamingState>((state, delta) => reduceQueryChatStreamEvent(state, {
    requestId,
    type: delta.type,
    round: delta.round,
    text: delta.text,
  }), current);
  setQueryChatStreamingState(queryId, next);
}

function bufferQueryChatTextDelta(
  queryId: Uid,
  event: Extract<ChatStreamEvent, { type: "reasoning_delta" | "answer_delta" }>,
): void {
  let buffered = bufferedChatTextDeltasByQueryId.get(queryId);
  if (buffered == null || buffered.requestId != event.requestId) {
    discardBufferedChatTextDeltas(queryId);
    buffered = { requestId: event.requestId, deltas: [], animationFrameId: null };
    bufferedChatTextDeltasByQueryId.set(queryId, buffered);
  }

  const last = buffered.deltas.at(-1);
  if (last?.type == event.type && last.round == event.round) {
    last.text += event.text;
  } else {
    buffered.deltas.push({ type: event.type, round: event.round, text: event.text });
  }
  if (buffered.animationFrameId == null) {
    buffered.animationFrameId = window.requestAnimationFrame(() => {
      flushBufferedChatTextDeltas(queryId, event.requestId);
    });
  }
}

function applyQueryChatStreamEvent(queryId: Uid, event: ChatStreamEvent): void {
  let current = chatStreamingStateByQueryId.get(queryId);
  if (current == null || current.requestId != event.requestId) {
    throw new Error("Received a chat stream event without a matching active request.");
  }
  if (event.type == "context_tokens" || event.type == "turn_accepted" || event.type == "transcript_conflict") {
    return;
  }

  if (event.type == "snapshot") {
    // The snapshot already includes deltas queued by the previous connection. Flushing those animation frames
    // after replacement would append old text twice, so discard them before applying authoritative state.
    discardBufferedChatTextDeltas(queryId, event.requestId);
    setQueryChatStreamingState(queryId, reduceQueryChatStreamEvent(current, event));
    return;
  }

  if (event.type == "reasoning_delta" || event.type == "answer_delta") {
    const targetPhase: ChatStreamPhase = event.type == "reasoning_delta" ? "thinking" : "answering";
    if (current.phase != targetPhase) {
      flushBufferedChatTextDeltas(queryId, event.requestId);
      current = chatStreamingStateByQueryId.get(queryId);
      if (current == null || current.requestId != event.requestId) {
        throw new Error("Chat streaming state changed while flushing text deltas.");
      }
      setQueryChatStreamingState(queryId, reduceQueryChatStreamEvent(current, event));
    } else {
      bufferQueryChatTextDelta(queryId, event);
    }
    return;
  }

  flushBufferedChatTextDeltas(queryId, event.requestId);
  current = chatStreamingStateByQueryId.get(queryId);
  if (current == null || current.requestId != event.requestId) {
    throw new Error("Chat streaming state changed while flushing text deltas.");
  }
  setQueryChatStreamingState(queryId, reduceQueryChatStreamEvent(current, event));
}

function queryChatRootIds(store: StoreContextModel, queryItem: QueryItem): Array<Uid> {
  return getQueryRuntime(store, queryItem).chat.rootItemIds ?? [];
}

function textCharCount(text: string): number {
  return [...text].length;
}

function estimateTextTokens(text: string): number {
  return text == "" ? 0 : Math.floor((textCharCount(text) + 3) / 4);
}

function setQueryChatContextTokens(
  store: StoreContextModel,
  queryItem: QueryItem,
  tokens: number,
  exact: boolean,
): void {
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      contextTokens: tokens,
      contextTokensExact: exact,
    },
  }));
}

export function queryChatContextTokenDisplay(
  store: StoreContextModel,
  queryItem: QueryItem,
  draftText: string,
  draftAttachments: Array<ChatDraftAttachment> = [],
): { label: string, exact: boolean } | null {
  const draft = draftText.trim();
  const stored = getQueryRuntime(store, queryItem).chat;
  const useStored = stored.contextTokens != null && draft == "" && draftAttachments.length == 0;
  // The client keeps no model history, so a draft is estimated on top of the last count the server reported.
  const tokens = useStored
    ? stored.contextTokens!
    : (stored.contextTokens ?? 0) + estimateTextTokens(draft) + estimateChatAttachmentTokens(draftAttachments);
  const exact = useStored && stored.contextTokensExact;
  if (tokens <= 0 && !exact) {
    return null;
  }
  const formatted = tokens.toLocaleString("en-US");
  return {
    label: exact ? `${formatted} tokens` : `~${formatted} tokens`,
    exact,
  };
}

function setQueryChatRootIds(store: StoreContextModel, queryItem: QueryItem, rootItemIds: Array<Uid>): void {
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      rootItemIds,
    },
  }));
  const pageId = getQueryRuntime(store, queryItem).chat.pageId;
  const page = pageId == null ? null : itemState.get(pageId);
  if (page != null && isPage(page)) {
    asPageItem(page).computed_children = [...rootItemIds];
  }
}

export function ensureTemporaryQueryChatPage(store: StoreContextModel, queryItem: QueryItem): PageItem {
  const runtime = getQueryRuntime(store, queryItem);
  const pageId = runtime.chat.pageId ?? newUid();
  if (runtime.chat.pageId == null) {
    updateQueryRuntime(store, queryItem, current => ({
      ...current,
      chat: {
        ...current.chat,
        pageId,
      },
    }));
  }

  let pageItem = itemState.get(pageId);
  if (!pageItem || !isPage(pageItem)) {
    const temporaryPage = PageFns.create(
      queryItem.ownerId,
      queryItem.id,
      RelationshipToParent.Child,
      "",
      newOrdering(),
    );
    temporaryPage.id = pageId;
    temporaryPage.origin = null;
    temporaryPage.arrangeAlgorithm = ArrangeAlgorithm.Document;
    temporaryPage.flags |= PageFlags.HideDocumentTitle;
    temporaryPage.orderChildrenBy = "";
    temporaryPage.title = "";
    markAsQueryChatPage(temporaryPage);
    pageItem = itemState.upsertItemFromServerObject(PageFns.toObject(temporaryPage), null);
  }

  const page = asPageItem(pageItem);
  page.origin = null;
  page.parentId = queryItem.id;
  page.relationshipToParent = RelationshipToParent.Child;
  page.arrangeAlgorithm = ArrangeAlgorithm.Document;
  page.flags = (page.flags | PageFlags.HideDocumentTitle) &
    ~PageFlags.EmbeddedInteractive &
    ~PageFlags.HideEmbeddedInteractiveTitle;
  page.orderChildrenBy = "";
  page.title = "";
  page.childrenLoaded = true;
  page.computed_children = [...queryChatRootIds(store, queryItem)];
  page.computed_attachments = [];
  markAsQueryChatPage(page);
  markChildrenLoadAsInitiatedOrComplete(page.id);
  return page;
}

export function queryChatCapabilities(store: StoreContextModel, queryItem: QueryItem): Array<ChatCapability> {
  return [...getQueryRuntime(store, queryItem).configuration.capabilities];
}

export function queryChatUsesInfumapData(store: StoreContextModel, queryItem: QueryItem): boolean {
  return queryChatCapabilities(store, queryItem).includes("infumap_data");
}

export function queryChatUsesCapability(
  store: StoreContextModel,
  queryItem: QueryItem,
  capability: ChatCapability,
): boolean {
  return queryChatCapabilities(store, queryItem).includes(capability);
}

function setQueryChatCapability(
  store: StoreContextModel,
  queryItem: QueryItem,
  capability: ChatCapability,
  enabled: boolean,
): void {
  setQueryConfigurationCapability(store, queryItem, capability, enabled);
}

export function setQueryChatUsesInfumapData(
  store: StoreContextModel,
  queryItem: QueryItem,
  enabled: boolean,
): void {
  setQueryChatCapability(store, queryItem, "infumap_data", enabled);
}

export function setQueryChatUsesCapability(
  store: StoreContextModel,
  queryItem: QueryItem,
  capability: ChatCapability,
  enabled: boolean,
): void {
  setQueryChatCapability(store, queryItem, capability, enabled);
}

/** The exact selection in this query, including unresolved provider/model references. */
export function queryChatModelSelection(store: StoreContextModel, queryItem: QueryItem): ChatModelSelection | null {
  const selection = getQueryRuntime(store, queryItem).configuration.model;
  return selection == null ? null : { ...selection };
}

/** Sets this query's model without changing its profile snapshot or the default profile. */
export function setQueryChatModelSelection(
  store: StoreContextModel,
  queryItem: QueryItem,
  selection: ChatModelSelection | null,
): void {
  updateQueryConfiguration(store, queryItem, { model: selection });
}

function queryChatRootOrderings(store: StoreContextModel, queryItem: QueryItem): Array<Uint8Array> {
  return queryChatRootIds(store, queryItem)
    .map(id => itemState.get(id)?.ordering)
    .filter((ordering): ordering is Uint8Array => ordering != null);
}

function createTurnComposite(
  ownerId: Uid,
  parentId: Uid,
  title: string,
  ordering: Uint8Array,
  clientOnly: boolean,
) {
  const composite = CompositeFns.create(ownerId, parentId, RelationshipToParent.Child, ordering);
  composite.title = title;
  composite.flags |= CompositeFlags.ShowTitle;
  composite.childrenLoaded = true;
  if (clientOnly) {
    composite.clientOnly = true;
    makeQueryChatItemReadOnly(composite);
  }
  markChildrenLoadAsInitiatedOrComplete(composite.id);
  itemState.add(composite);
  return composite;
}

function createTurnNote(
  ownerId: Uid,
  parentId: Uid,
  text: string,
  ordering: Uint8Array,
  clientOnly: boolean,
) {
  const note = NoteFns.create(ownerId, parentId, RelationshipToParent.Child, text, ordering);
  if (clientOnly) {
    note.clientOnly = true;
    makeQueryChatItemReadOnly(note);
  }
  itemState.add(note);
  return note;
}

/** A "You" composite: the message's attachments, as text items, then its text. */
function addLocalQueryUserTurn(
  store: StoreContextModel,
  queryItem: QueryItem,
  text: string,
  attachments: Array<LoadChatAttachment>,
): Array<Item> {
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const composite = createTurnComposite(
    queryItem.ownerId,
    chatPage.id,
    "You",
    newOrderingAtEnd(queryChatRootOrderings(store, queryItem)),
    true,
  );
  makeQueryChatTurnCopyable(composite);
  const items: Array<Item> = [composite];
  for (const attachment of attachments) {
    const attachmentItem = createChatAttachmentItem(
      queryItem.ownerId,
      composite.id,
      itemState.newOrderingAtEndOfChildren(composite.id),
      attachment,
      { queryItemId: queryItem.id },
    );
    attachmentItem.clientOnly = true;
    makeQueryChatItemReadOnly(attachmentItem);
    makeQueryChatTurnCopyable(attachmentItem);
    itemState.add(attachmentItem);
    items.push(attachmentItem);
  }
  if (text != "") {
    items.push(createTurnNote(
      queryItem.ownerId,
      composite.id,
      text,
      itemState.newOrderingAtEndOfChildren(composite.id),
      true,
    ));
  }
  setQueryChatRootIds(store, queryItem, [...queryChatRootIds(store, queryItem), composite.id]);
  return items;
}

function prepareReturnedItem(item: Item, clientOnly: boolean): void {
  if (clientOnly) {
    item.clientOnly = true;
    makeQueryChatItemReadOnly(item);
  }
  if (isContainer(item)) {
    const container = asContainerItem(item);
    container.computed_children = [];
    container.childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(item.id);
  }
  if (isAttachmentsItem(item)) {
    asAttachmentsItem(item).computed_attachments = [];
  }
}

interface StagedQueryChatItems {
  itemsInInsertionOrder: Array<Item>,
  rootIds: Array<Uid>,
}

function stageServerReturnedQueryItems(
  store: StoreContextModel,
  queryItem: QueryItem,
  itemObjects: Array<object>,
): StagedQueryChatItems {
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const returnedItems = itemObjects.map(itemObject => ItemFns.fromObject(itemObject, null));
  if (returnedItems.length == 0) {
    throw new Error("The assistant returned no items.");
  }

  const itemsById = new Map<Uid, Item>();
  for (const item of returnedItems) {
    if (item.id == EMPTY_UID) {
      throw new Error("The assistant returned an item with an empty id.");
    }
    if (itemsById.has(item.id)) {
      throw new Error(`The assistant returned duplicate item id '${item.id}'.`);
    }
    if (itemState.get(item.id) != null) {
      throw new Error(`The assistant returned item id '${item.id}', which is already in use.`);
    }
    itemsById.set(item.id, item);
  }

  const roots = returnedItems.filter(item => item.parentId == null || item.parentId == EMPTY_UID);
  if (roots.length == 0) {
    throw new Error("The assistant item graph has no root.");
  }

  const rootIds = new Set(roots.map(root => root.id));
  const childrenByParentId = new Map<Uid, Array<Item>>();
  for (const item of returnedItems) {
    if (rootIds.has(item.id)) {
      continue;
    }
    const parent = item.parentId == null ? null : itemsById.get(item.parentId);
    if (parent == null) {
      throw new Error(`The assistant item '${item.id}' refers to missing parent '${item.parentId}'.`);
    }
    if (item.relationshipToParent == RelationshipToParent.Child) {
      if (!isContainer(parent)) {
        throw new Error(`The assistant item '${item.id}' has a parent that cannot contain children.`);
      }
    } else if (item.relationshipToParent == RelationshipToParent.Attachment) {
      if (!isAttachmentsItem(parent)) {
        throw new Error(`The assistant item '${item.id}' has a parent that cannot contain attachments.`);
      }
    } else {
      throw new Error(`The assistant item '${item.id}' has an unsupported parent relationship.`);
    }
    childrenByParentId.set(parent.id, [...(childrenByParentId.get(parent.id) ?? []), item]);
  }

  let rootOrderings = queryChatRootOrderings(store, queryItem);
  for (const root of roots) {
    root.parentId = chatPage.id;
    root.relationshipToParent = RelationshipToParent.Child;
    root.ordering = newOrderingAtEnd(rootOrderings);
    if (isComposite(root)) {
      asCompositeItem(root).flags |= CompositeFlags.ShowTitle;
    }
    rootOrderings = [...rootOrderings, root.ordering];
  }

  const itemsInInsertionOrder: Array<Item> = [];
  const visit = (item: Item): void => {
    itemsInInsertionOrder.push(item);
    for (const child of childrenByParentId.get(item.id) ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  if (itemsInInsertionOrder.length != returnedItems.length) {
    throw new Error("The assistant item graph contains a cycle or an unreachable item.");
  }

  // The server cannot measure text, so size its tables (which wrap the text of their rows) here.
  const byOrdering = (a: Item, b: Item) => compareOrderings(a.ordering, b.ordering);
  const childrenWithRelationship = (parentId: Uid, relationship: string) =>
    (childrenByParentId.get(parentId) ?? []).filter(child => child.relationshipToParent == relationship).sort(byOrdering);
  for (const item of returnedItems) {
    if (!isTable(item)) { continue; }
    TableFns.fitGeneratedTableHeight(asTableItem(item), childrenWithRelationship(item.id, RelationshipToParent.Child).map(row => ({
      item: row,
      attachments: childrenWithRelationship(row.id, RelationshipToParent.Attachment),
    })));
  }

  return { itemsInInsertionOrder, rootIds: roots.map(root => root.id) };
}

function cloneCompletedRounds(rounds: Array<ChatStreamingModelRound>): Array<ChatStreamingModelRound> {
  return rounds.map(round => ({
    ...round,
    toolCalls: round.toolCalls.map(toolCall => ({ ...toolCall })),
    complete: true,
  }));
}

interface QueryChatAssistantTurn {
  requestId: string,
  promptText: string,
  assistantText: string,
  rounds: Array<ChatStreamingModelRound>,
  startedAt: number,
  completedAt: number,
}

/** Adds an assistant turn's items to the chat view, with its activity for the turn dropdown. */
function insertQueryChatAssistantTurn(
  store: StoreContextModel,
  queryItem: QueryItem,
  itemObjects: Array<object>,
  turn: QueryChatAssistantTurn,
): Array<Item> {
  if (getQueryRuntime(store, queryItem).chat.completedActivities.some(activity => activity.requestId == turn.requestId)) {
    return [];
  }
  const staged = stageServerReturnedQueryItems(store, queryItem, itemObjects);
  const previousRuntime = getQueryRuntime(store, queryItem);
  const previousRootIds = [...(previousRuntime.chat.rootItemIds ?? [])];
  const nextRootIds = [...previousRootIds, ...staged.rootIds];
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const insertedItems: Array<Item> = [];

  try {
    batch(() => {
      for (const item of staged.itemsInInsertionOrder) {
        prepareReturnedItem(item, true);
        if (staged.rootIds.includes(item.id)) {
          makeQueryChatTurnCopyable(item);
        }
        insertedItems.push(item);
        itemState.add(item);
      }

      chatPage.computed_children = [...nextRootIds];
      const completedActivity: QueryChatCompletedActivity = {
        requestId: turn.requestId,
        assistantRootIds: [...staged.rootIds],
        promptText: turn.promptText,
        assistantText: turn.assistantText,
        rounds: cloneCompletedRounds(turn.rounds),
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
      };
      updateQueryRuntime(store, queryItem, current => ({
        ...current,
        chat: {
          ...current.chat,
          rootItemIds: nextRootIds,
          completedActivities: [...(current.chat.completedActivities ?? []), completedActivity],
        },
      }));
    });
    } catch (error) {
    for (let i = insertedItems.length - 1; i >= 0; i--) {
      const item = insertedItems[i];
      if (itemState.get(item.id) == item) {
        try {
          itemState.delete(item.id);
        } catch (rollbackError) {
          console.error("Failed to roll back query chat item insertion:", rollbackError);
        }
      }
    }
    chatPage.computed_children = previousRootIds;
    throw error;
  }

  return insertedItems;
}

/** A one-line note after a turn that did not complete, saying what happened to it. */
function addQueryChatOutcomeNote(store: StoreContextModel, queryItem: QueryItem, text: string): void {
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const note = createTurnNote(
    queryItem.ownerId,
    chatPage.id,
    text,
    newOrderingAtEnd(queryChatRootOrderings(store, queryItem)),
    true,
  );
  setQueryChatRootIds(store, queryItem, [...queryChatRootIds(store, queryItem), note.id]);
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: { ...current.chat, outcomeRootIds: [...current.chat.outcomeRootIds, note.id] },
  }));
}

export function queryChatOutcomeText(status: LoadChatTurn["status"], error: string | null): string | null {
  switch (status) {
    case "cancelled":
      return "Response stopped.";
    case "error":
      return error == null || error.trim() == "" ? "Response failed." : `Response failed: ${error}`;
    case "interrupted":
      return "Response interrupted: the server stopped while it was running.";
    case "running":
      return "A response is still running, in another window or tab. Reopen this chat to see it.";
    case "completed":
      return null;
  }
}

/** Removes a root the client added, such as a user turn the server did not record. */
function removeQueryChatRoot(store: StoreContextModel, queryItem: QueryItem, rootId: Uid): void {
  const pageId = getQueryRuntime(store, queryItem).chat.pageId;
  itemState.pruneRelationshipSubtreeIfCurrent(rootId, pageId ?? queryItem.id, RelationshipToParent.Child);
  setQueryChatRootIds(store, queryItem, queryChatRootIds(store, queryItem).filter(id => id != rootId));
}

function setQueryChatRevision(store: StoreContextModel, queryItem: QueryItem, revision: number): void {
  updateQueryRuntime(store, queryItem, current => ({ ...current, chat: { ...current.chat, revision } }));
}

/**
 * Asks the server for a generated title for an earlier chat, in the background, and shows it. The server only
 * replaces a title derived from the first prompt, and applies it itself.
 */
export async function generateQueryChatTitle(store: StoreContextModel, queryItemId: Uid): Promise<void> {
  try {
    const { title } = await server.generateChatTitle(queryItemId);
    const current = itemState.get(queryItemId);
    if (current != null && isQueryItem(current) && asQueryItem(current).title != title) {
      asQueryItem(current).title = title;
      requestArrange(store, "query-chat-generated-title");
    }
  } catch (e) {
    console.warn("Could not generate a chat title:", e);
  }
}

/** On the first accepted turn, moves the current query into chat history and leaves a new query at the top. */
async function archiveQueryChatAfterFirstTurn(
  store: StoreContextModel,
  queryItemMaybeStale: QueryItem,
  isCurrent: () => boolean,
): Promise<void> {
  const user = store.user.getUserMaybe();
  if (user == null || !isLiveQueryChat(store, queryItemMaybeStale)) {
    return;
  }
  await ensureQueryEntryUnderQueries(store, user.queriesPageId, queryItemMaybeStale.id, isCurrent);
  if (!isCurrent()) { return; }
  requestArrange(store, "query-chat-new-query");
}

/**
 * Submits a turn of a live chat. Returns false if the message was not recorded, so the caller should give the text
 * back to the user as a draft: the transcript changed elsewhere (it has been reloaded), or the server refused the turn.
 */
export async function submitQueryChatMessage(
  store: StoreContextModel,
  queryItem: QueryItem,
  rawText: string,
  deepResearch: boolean = false,
  attachments: Array<ChatDraftAttachment> = [],
): Promise<boolean> {
  if (rawText.trim() == "" && attachments.length == 0) { return true; }
  const chat = getQueryRuntime(store, queryItem).chat;
  if (chat.requestId != null || chat.runningElsewhere || activeQueryChatRequestByQueryId.has(queryItem.id)) {
    showChatMessage(store, "A response is already running in this chat.", TransientMessageType.Info);
    return false;
  }
  const requestId = newUid();
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  const generation = queryChatGenerations.get(queryItem.id) ?? 0;
  updateQueryRuntime(store, queryItem, current => ({ ...current, chat: { ...current.chat, requestId } }));
  try {
    return await submitQueryChatTurn(store, queryItem, requestId, rawText, deepResearch, attachments);
  } finally {
    if ((store.user.getUserMaybe()?.userId ?? null) == accountId &&
        (queryChatGenerations.get(queryItem.id) ?? 0) == generation &&
        getQueryRuntime(store, queryItem).chat.requestId == requestId) {
      updateQueryRuntime(store, queryItem, current => ({ ...current, chat: { ...current.chat, requestId: null } }));
    }
  }
}

async function submitQueryChatTurn(
  store: StoreContextModel,
  queryItem: QueryItem,
  requestId: Uid,
  rawText: string,
  deepResearch: boolean,
  attachments: Array<ChatDraftAttachment>,
): Promise<boolean> {
  const text = rawText.trim();
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  const generation = queryChatGenerations.get(queryItem.id) ?? 0;
  const ownsChat = () => (store.user.getUserMaybe()?.userId ?? null) == accountId &&
    (queryChatGenerations.get(queryItem.id) ?? 0) == generation;
  const isCurrent = () => ownsChat() && getQueryRuntime(store, queryItem).chat.requestId == requestId;

  await ensureQueryChatLoaded(store, queryItem);
  if (!isCurrent()) { return false; }
  const loaded = getQueryRuntime(store, queryItem).chat;
  if (loaded.loadState == "failed" || loaded.runningElsewhere) {
    showChatMessage(store, loaded.runningElsewhere ? "A response is already running in this chat." : "Could not load this chat. Reload before sending.", TransientMessageType.Error);
    return false;
  }
  try {
    await ensureQueryConfigurationReady(store, queryItem);
  } catch (error) {
    showChatMessage(store, error instanceof Error ? error.message : String(error), TransientMessageType.Error);
    return false;
  }
  if (!isCurrent()) { return false; }
  const settings = snapshotQueryChatSettings(store, queryItem, deepResearch ? "deep_research" : "chat");
  const unavailable = queryConfigurationUnavailableReason(store, settings.configuration, "chat", settings.scopeItemIds);
  if (unavailable != null) {
    showChatMessage(store, unavailable, TransientMessageType.Error);
    return false;
  }
  const expectedRevision = getQueryRuntime(store, queryItem).chat.revision;
  // The server has the attachments only once the turn is accepted; until then, and after, they open from here.
  for (const attachment of attachments) {
    seedChatAttachmentContent({ chat: { queryItemId: queryItem.id }, attachmentId: attachment.id }, attachment.text);
  }
  const [userTurnRoot] = addLocalQueryUserTurn(store, queryItem, text, attachments.map(attachment => ({
    id: attachment.id,
    title: attachment.title,
    mimeType: attachment.mimeType,
    sizeBytes: chatAttachmentSizeBytes(attachment.text),
  })));
  const stored = getQueryRuntime(store, queryItem).chat.contextTokens ?? 0;
  setQueryChatContextTokens(
    store, queryItem, stored + estimateTextTokens(text) + estimateChatAttachmentTokens(attachments), false,
  );
  requestArrange(store, "query-chat-user-turn");

  return followQueryChatRun(store, queryItem, requestId, {
    submission: {
      userTurnRootId: userTurnRoot.id,
      payload: {
        requestId, queryItemId: queryItem.id, expectedRevision, text,
        attachments: attachments.length > 0
          ? attachments.map(({ id, title, mimeType, text }) => ({ id, title, mimeType, text }))
          : undefined,
        ...settings,
      },
    },
  });
}

/** Submission and attachment use the same event application, final insertion and account/teardown guards. */
async function followQueryChatRun(
  store: StoreContextModel,
  queryItem: QueryItem,
  requestId: Uid,
  options: {
    submission?: { payload: ChatRequest, userTurnRootId: Uid },
    turn?: LoadChatTurn,
    cancellationRequested?: boolean,
  },
): Promise<boolean> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  const generation = queryChatGenerations.get(queryItem.id) ?? 0;
  let accountChanged = false;
  const ownsChat = () => !accountChanged && (store.user.getUserMaybe()?.userId ?? null) == accountId &&
    (queryChatGenerations.get(queryItem.id) ?? 0) == generation;
  const isCurrent = () => ownsChat() && getQueryRuntime(store, queryItem).chat.requestId == requestId;
  const controller = new AbortController();
  const control = new ChatStreamControl();
  if (options.cancellationRequested) { control.cancel(); }
  const disposeAccountWatch = createRoot(dispose => {
    createEffect(() => {
      if ((store.user.getUserMaybe()?.userId ?? null) != accountId) {
        accountChanged = true;
        controller.abort();
        discardBufferedChatTextDeltas(queryItem.id, requestId);
      }
    });
    return dispose;
  });
  const requireCurrent = () => {
    if (!isCurrent()) { controller.abort(); }
    controller.signal.throwIfAborted();
  };
  let accepted = false;
  const firstTurnArchive: { promise: Promise<void> | null } = { promise: null };
  const acceptTurn = (revision: number) => {
    const firstAcceptance = !accepted;
    accepted = true;
    setQueryChatRevision(store, queryItem, revision);
    if (firstAcceptance && revision == 1) {
      firstTurnArchive.promise = archiveQueryChatAfterFirstTurn(store, queryItem, ownsChat);
    }
  };
  let clearStreamingStateOnExit = true;
  discardBufferedChatTextDeltas(queryItem.id);
  activeQueryChatRequestByQueryId.set(queryItem.id, { requestId, controller, control, approvals: new Set() });
  const previous = chatStreamingStateByQueryId.get(queryItem.id);
  const restored = previous?.requestId == requestId ? previous : null;
  setQueryChatStreamingState(queryItem.id, {
    requestId,
    phase: options.turn == null ? "submitted" : "thinking",
    statusText: options.turn == null ? "Preparing request" : "Restoring response",
    rounds: restored?.rounds ?? options.turn?.rounds ?? [],
    answerPreview: restored?.answerPreview ?? "",
    startedAt: restored?.startedAt ?? options.turn?.startedAt ?? Date.now(),
    errorMessage: null,
    connectionState: "connecting",
    pendingApprovals: [],
    cancellationRequested: control.cancellationRequested,
  });
  try {
    const onEvent = (event: ChatStreamEvent) => {
      requireCurrent();
      if (event.type == "turn_accepted") {
        acceptTurn(event.revision);
        return;
      }
      if (event.type == "snapshot") {
        acceptTurn(event.snapshot.revision);
        const context = event.snapshot.contextTokens;
        if (context != null) { setQueryChatContextTokens(store, queryItem, context.tokens, context.exact); }
      }
      if (event.type == "context_tokens") {
        setQueryChatContextTokens(store, queryItem, event.tokens, event.exact);
      }
      applyQueryChatStreamEvent(queryItem.id, event);
    };
    const onConnectionChange = (connectionState: ChatStreamConnectionState) => {
      requireCurrent();
      const current = chatStreamingStateByQueryId.get(queryItem.id);
      if (current?.requestId == requestId) {
        setQueryChatStreamingState(queryItem.id, { ...current, connectionState });
      }
    };
    const response = options.submission != null
      ? await server.chatStream(options.submission.payload, onEvent, controller.signal, onConnectionChange, control)
      : await server.resumeChatStream(queryItem.id, requestId, onEvent, controller.signal, onConnectionChange, control);
    if (!isCurrent()) { return true; }

    flushBufferedChatTextDeltas(queryItem.id, requestId);
    const finalStreamingState = chatStreamingStateByQueryId.get(queryItem.id);
    if (finalStreamingState == null || finalStreamingState.requestId != requestId) {
      throw new Error("Chat streaming state was lost before the response could be finalized.");
    }
    insertQueryChatAssistantTurn(store, queryItem, response.items, {
      requestId,
      promptText: options.submission?.payload.text ?? options.turn?.text ?? "",
      assistantText: response.assistantText,
      rounds: finalStreamingState.rounds,
      startedAt: finalStreamingState.startedAt,
      completedAt: finalStreamingState.endedAt ?? Date.now(),
    });
    requestArrange(store, "query-chat-assistant-turn");
    return true;
  } catch (e) {
    if (!isCurrent()) { return true; }
    flushBufferedChatTextDeltas(queryItem.id, requestId);
    if (e instanceof ChatTranscriptConflictError) {
      // Nothing was recorded. Show the chat as it now is, and give the message back as a draft.
      clearStreamingStateOnExit = true;
      await reloadQueryChat(store, queryItem);
      showChatMessage(store, "This chat changed in another window, so it was reloaded", TransientMessageType.Info);
      return false;
    }
    const current = chatStreamingStateByQueryId.get(queryItem.id);
    if (current?.requestId == requestId && current.phase == "cancelled") {
      clearStreamingStateOnExit = false;
      addQueryChatOutcomeNote(store, queryItem, queryChatOutcomeText("cancelled", null)!);
      return true;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (!accepted && options.submission != null && e instanceof ChatSubmissionRejectedError) {
      // The server refused the turn before recording it, for example because another response is running.
      console.warn("Chat message was not recorded:", message);
      removeQueryChatRoot(store, queryItem, options.submission.userTurnRootId);
      showChatMessage(store, message, TransientMessageType.Error);
      void refreshQueryConfigurationAvailability(store);
      return false;
    }
    console.error("Failed to follow query chat response:", e);
    if (current?.requestId == requestId) {
      if (current.phase != "error") {
        // A transport/auth/protocol failure is not a saved run failure. Keep the composer locked and let
        // transcript polling recover the outcome or attach again, retaining partial output in the meantime.
        setQueryChatStreamingState(queryItem.id, {
          ...current,
          connectionState: "reconnecting",
          recoveryError: message,
        });
        updateQueryRuntime(store, queryItem, runtime => ({
          ...runtime, chat: { ...runtime.chat, runningElsewhere: true },
        }));
        clearStreamingStateOnExit = false;
        return true;
      }
      clearStreamingStateOnExit = false;
    }
    addQueryChatOutcomeNote(store, queryItem, queryChatOutcomeText("error", message)!);
    return true;
  } finally {
    controller.abort();
    disposeAccountWatch();
    if (firstTurnArchive.promise != null) {
      void firstTurnArchive.promise.then(
        () => {
          // Reattachment may find the first turn already archived but its title generation unfinished.
          // The title endpoint only replaces the original prompt-derived title.
          if (ownsChat() && !getQueryRuntime(store, queryItem).chat.runningElsewhere) {
            void generateQueryChatTitle(store, queryItem.id);
          }
        },
        e => console.error("Failed to archive the first query chat turn:", e),
      );
    }
    const activeRequest = activeQueryChatRequestByQueryId.get(queryItem.id);
    if (activeRequest?.controller == controller) {
      activeQueryChatRequestByQueryId.delete(queryItem.id);
      if (clearStreamingStateOnExit || !ownsChat()) {
        clearQueryChatStreamingState(queryItem.id, requestId);
      }
    }
    if (ownsChat()) { requestArrange(store, "query-chat-request-ended"); }
    if (isCurrent()) {
      updateQueryRuntime(store, queryItem, runtime => ({ ...runtime, chat: { ...runtime.chat, requestId: null } }));
    }
  }
}

const queryChatLoads = new Map<Uid, Promise<void>>();
/** Bumped when a chat is cleared, so a load that started before is not applied after. */
const queryChatGenerations = new Map<Uid, number>();

/** Loads a live chat's transcript into the chat view, once until the chat is next cleared. */
export async function ensureQueryChatLoaded(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  if (!isLiveQueryChat(store, queryItem)) {
    return;
  }
  const loadState = getQueryRuntime(store, queryItem).chat.loadState;
  if (loadState == "loaded" || loadState == "failed") {
    return;
  }
  const pending = queryChatLoads.get(queryItem.id);
  if (pending != null) {
    return pending;
  }
  const generation = queryChatGenerations.get(queryItem.id) ?? 0;
  const load: Promise<void> = loadQueryChat(store, queryItem, generation).finally(() => {
    if (queryChatLoads.get(queryItem.id) == load) {
      queryChatLoads.delete(queryItem.id);
    }
  });
  queryChatLoads.set(queryItem.id, load);
  return load;
}

async function loadQueryChat(store: StoreContextModel, queryItem: QueryItem, generation: number): Promise<void> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  const isCurrent = () => (store.user.getUserMaybe()?.userId ?? null) == accountId &&
    (queryChatGenerations.get(queryItem.id) ?? 0) == generation;
  updateQueryRuntime(store, queryItem, current => ({ ...current, chat: { ...current.chat, loadState: "loading" } }));
  try {
    const response = await server.loadChat(queryItem.id);
    if (isCurrent()) {
      applyLoadedQueryChat(store, queryItem, response);
    }
  } catch (e) {
    console.error("Failed to load chat transcript:", e);
    if (isCurrent()) {
      updateQueryRuntime(store, queryItem, current => ({ ...current, chat: { ...current.chat, loadState: "failed" } }));
      showChatMessage(store, "Could not load this chat", TransientMessageType.Error);
    }
  }
}

async function reloadQueryChat(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  clearQueryChat(store, queryItem);
  await ensureQueryChatLoaded(store, queryItem);
  requestArrange(store, "query-chat-reloaded");
}

/** Poll only while no stream is attached, including locks held by non-run operations such as persistence. */
export async function refreshQueryChatRunningElsewhere(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  const chat = getQueryRuntime(store, queryItem).chat;
  if (!chat.runningElsewhere || chat.requestId != null || activeQueryChatRequestByQueryId.has(queryItem.id) || !isLiveQueryChat(store, queryItem)) { return; }
  const generation = queryChatGenerations.get(queryItem.id) ?? 0;
  const accountId = store.user.getUserMaybe()?.userId;
  try {
    const response = await server.loadChat(queryItem.id);
    if (accountId != store.user.getUserMaybe()?.userId || generation != (queryChatGenerations.get(queryItem.id) ?? 0)) { return; }
    const current = getQueryRuntime(store, queryItem).chat;
    if (!current.runningElsewhere || current.requestId != null || activeQueryChatRequestByQueryId.has(queryItem.id)) { return; }
    const runningTurn = response.turns.find(turn => turn.status == "running");
    if (response.running && runningTurn == null) { return; }
    const previous = chatStreamingStateByQueryId.get(queryItem.id);
    const cancellationRequested = previous?.cancellationRequested;
    if (runningTurn != null && previous?.requestId == runningTurn.requestId && current.revision == response.revision) {
      attachLoadedQueryChatRun(store, queryItem, runningTurn, cancellationRequested);
    } else {
      clearQueryChat(store, queryItem);
      applyLoadedQueryChat(store, queryItem, response, cancellationRequested);
    }
  } catch {
    // Keep the running lock; the visible chat retries while the response is outstanding.
  }
}

/** Only query items in the Queries page have transcripts. */
export function isLiveQueryChat(store: StoreContextModel, queryItem: QueryItem): boolean {
  const user = store.user.getUserMaybe();
  return user != null && queryItem.parentId == user.queriesPageId && queryItem.origin == null;
}

function applyLoadedQueryChat(
  store: StoreContextModel, queryItem: QueryItem, response: LoadChatResponse, cancellationRequested = false,
): void {
  batch(() => {
    const settings = response.lastSettings;
    if (settings != null) { restoreQueryConfiguration(store, queryItem, settings); }
    updateQueryRuntime(store, queryItem, current => ({
      ...current,
      chat: {
        ...current.chat,
        revision: response.revision,
        loadState: "loaded",
        runningElsewhere: response.running,
        contextTokens: response.contextTokens?.tokens ?? null,
        contextTokensExact: response.contextTokens?.exact ?? false,
      },
    }));
    if (response.turns.length == 0) {
      return;
    }
    for (const turn of response.turns) {
      addLocalQueryUserTurn(store, queryItem, turn.text, turn.attachments);
      if (turn.status == "completed" && turn.items != null && turn.assistantText != null) {
        insertQueryChatAssistantTurn(store, queryItem, turn.items, {
          requestId: turn.requestId,
          promptText: turn.text,
          assistantText: turn.assistantText,
          rounds: turn.rounds,
          startedAt: turn.startedAt,
          completedAt: turn.endedAt ?? turn.startedAt,
        });
      } else if (turn.status != "running") {
        const outcome = queryChatOutcomeText(turn.status, turn.error);
        if (outcome != null) {
          addQueryChatOutcomeNote(store, queryItem, outcome);
        }
      }
    }
    setQueryMode(store, queryItem, "chat");
    if (store.overlay.autoFocusSearchInput.get()) {
      // The query input that was to be focused is replaced by the chat's composer.
      store.overlay.autoFocusSearchInput.set(false);
      store.overlay.autoFocusChatInput.set(true);
    }
  });
  const runningTurn = response.turns.find(turn => turn.status == "running");
  if (runningTurn != null) { attachLoadedQueryChatRun(store, queryItem, runningTurn, cancellationRequested); }
  requestArrange(store, "query-chat-loaded");
}

function attachLoadedQueryChatRun(
  store: StoreContextModel, queryItem: QueryItem, turn: LoadChatTurn, cancellationRequested = false,
): void {
  if (getQueryRuntime(store, queryItem).chat.requestId != null || activeQueryChatRequestByQueryId.has(queryItem.id) ||
      !isLiveQueryChat(store, queryItem)) { return; }
  updateQueryRuntime(store, queryItem, current => ({
    ...current, chat: { ...current.chat, requestId: turn.requestId, runningElsewhere: false },
  }));
  void followQueryChatRun(store, queryItem, turn.requestId, { turn, cancellationRequested });
}

export function queryChatHasContent(store: StoreContextModel, queryItem: QueryItem): boolean {
  return queryChatRootIds(store, queryItem).length > 0;
}

function showChatMessage(store: StoreContextModel, text: string, type: TransientMessageType): void {
  const message = { text, type };
  store.overlay.toolbarTransientMessage.set(message);
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, 3000);
}

export function clearQueryChat(store: StoreContextModel, queryItem: QueryItem): void {
  detachQueryChatRequest(queryItem.id);
  const runtime = getQueryRuntime(store, queryItem);
  const pageId = runtime.chat.pageId;
  if (pageId != null) {
    itemState.pruneRelationshipSubtreeIfCurrent(pageId, queryItem.id, RelationshipToParent.Child);
  }
  const rootParentId = pageId ?? queryItem.id;
  for (const rootId of runtime.chat.rootItemIds) {
    itemState.pruneRelationshipSubtreeIfCurrent(rootId, rootParentId, RelationshipToParent.Child);
  }
  queryChatGenerations.set(queryItem.id, (queryChatGenerations.get(queryItem.id) ?? 0) + 1);
  queryChatLoads.delete(queryItem.id);
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      pageId: null,
      composerHeightPx: null,
      activityHeightPx: null,
      rootItemIds: [],
      outcomeRootIds: [],
      revision: 0,
      loadState: "unloaded",
      requestId: null,
      runningElsewhere: false,
      completedActivities: [],
      contextTokens: null,
      contextTokensExact: false,
    },
  }));
  clearQueryChatStreamingState(queryItem.id);
  clearQueryChatCompletedActivityUi(queryItem.id);
}
