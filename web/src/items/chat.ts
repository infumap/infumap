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
import { batch, createSignal } from "solid-js";
import { asAttachmentsItem, isAttachmentsItem } from "./base/attachments-item";
import { asContainerItem, isContainer } from "./base/container-item";
import { CompositeFlags, PageFlags } from "./base/flags-item";
import { ClientOnlyItemKind, Item } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { CompositeFns, asCompositeItem, isComposite } from "./composite-item";
import { NoteFns, asNoteItem, isNote } from "./note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import { QueryItem, asQueryItem, getQueryRuntime, isQueryItem, setQueryMode, setQueryText, updateQueryRuntime } from "./query-item";
import { TextFns } from "./text-item";
import { clearQueryChatCompletedActivityUi } from "./query-chat-activity-ui";
import { server, type ChatMessage, type ChatModelSelection, type ChatStreamEvent, type ChatStreamPhase, type ChatToolServerInfo } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { base64ArrayBuffer } from "../util/base64ArrayBuffer";
import {
  setExtraDefaultChatCapabilities,
  type ChatCapability,
  type QueryChatActivityModelRound,
  type QueryChatActivityToolCall,
  type QueryChatCompletedActivity,
} from "../store/StoreProvider_PerItem";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";

const MATERIALIZED_QUERY_CHAT_FALLBACK_TITLE = "Chat";
const MATERIALIZED_QUERY_CHAT_TITLE_MAX_CHARS = 100;
const MATERIALIZED_QUERY_CHAT_TITLE_PROMPT = "Give this conversation a concise, informative document title. " +
  "Name the user's underlying topic or question, not the assistant's process, search method, sources, or caveats. " +
  "Err on the side of terseness: use the shortest natural noun phrase that clearly identifies the subject, usually " +
  "two to four words and never more than six. Use title case. Do not begin with words such as Finding, " +
  "Researching, Searching, Exploring, or Analyzing. " +
  "Use plain text only, with no Markdown, quotation marks, or ending punctuation. Reply with only the title.";

export type QueryChatMaterializationPhase = "generating_title" | "creating_markdown";

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
}

const chatStreamingStateByQueryId = new Map<Uid, ChatStreamingState>();
const [chatStreamingStateRevision, setChatStreamingStateRevision] = createSignal(0, { equals: false });

interface ActiveQueryChatRequest {
  requestId: string,
  controller: AbortController,
}

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

  flushBufferedChatTextDeltas(queryId, activeRequest.requestId);
  const flushed = chatStreamingStateByQueryId.get(queryId);
  if (flushed != null && flushed.requestId == activeRequest.requestId) {
    setQueryChatStreamingState(queryId, reduceQueryChatStreamEvent(flushed, {
      requestId: activeRequest.requestId,
      type: "cancelled",
    }));
  }
  activeRequest.controller.abort();
  return true;
}

export async function submitQueryChatToolApproval(
  requestId: string,
  callId: string,
  approved: boolean,
): Promise<void> {
  await server.submitChatToolApproval({ requestId, callId, approved });
}

function chatStatusTextFromEvent(event: ChatStreamEvent): string {
  switch (event.type) {
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
      if (event.name == "fetch_page") {
        return "Waiting to fetch page";
      }
      return "Waiting for approval";
    case "tool_call_started":
      if (event.name == "read_container") {
        return "Reading Infumap container";
      }
      if (event.name == "find" || event.name == "lexical_search") {
        return "Finding items";
      }
      if (event.name == "search_text") {
        return "Searching source text";
      }
      if (event.name == "get_fragment") {
        return "Reading source text";
      }
      if (event.name == "web_search") {
        return "Searching the web";
      }
      if (event.name == "fetch_page") {
        return "Fetching page";
      }
      return `Running ${event.name}`;
    case "tool_call_finished":
      if (event.name == "read_container") {
        return "Container outline loaded";
      }
      if (event.name == "find" || event.name == "lexical_search") {
        return "Find complete";
      }
      if (event.name == "search_text") {
        return "Search complete";
      }
      if (event.name == "get_fragment") {
        return "Source text loaded";
      }
      return event.summary;
    case "context_tokens":
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

function reduceQueryChatStreamEvent(current: ChatStreamingState, event: ChatStreamEvent): ChatStreamingState {
  if (event.type == "context_tokens") {
    return current;
  }
  const statusText = chatStatusTextFromEvent(event);
  let next: ChatStreamingState;
  switch (event.type) {
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
          toolCalls: [
            ...round.toolCalls.filter(toolCall => toolCall.callId != event.callId),
            {
              callId: event.callId,
              name: event.name,
              status: "awaiting_approval" as const,
              summary: null,
              arguments: event.arguments,
              query: event.query,
              url: event.url,
            },
          ],
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
            toolCalls: [
              ...round.toolCalls.filter(toolCall => toolCall.callId != event.callId),
              {
                callId: event.callId,
                name: event.name,
                status: "running" as const,
                summary: null,
                arguments: event.arguments ?? existing?.arguments,
                query: existing?.query,
                url: existing?.url,
              },
            ],
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
            toolCalls: existingIndex == -1
              ? [...round.toolCalls, completed]
              : round.toolCalls.map((toolCall, index) => index == existingIndex ? completed : toolCall),
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
  if (event.type == "context_tokens") {
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

function titleFromPrompt(prompt: string): string {
  const titleWords = prompt.trim().replace(/\s+/g, " ").split(" ").filter(word => word != "").slice(0, 3);
  if (titleWords.length == 0) {
    return MATERIALIZED_QUERY_CHAT_FALLBACK_TITLE;
  }
  return titleWords.join(" ");
}

function titleFromModelResponse(response: string): string | null {
  const firstLine = response.split(/\r?\n/).find(line => line.trim() != "");
  if (firstLine == null) {
    return null;
  }
  let title = firstLine
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .trim()
    .replace(/^[*_"'`]+|[*_"'`]+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim()
    .replace(/\s+/g, " ");
  if (title == "") {
    return null;
  }
  const chars = [...title];
  if (chars.length <= MATERIALIZED_QUERY_CHAT_TITLE_MAX_CHARS) {
    return title;
  }
  title = chars.slice(0, MATERIALIZED_QUERY_CHAT_TITLE_MAX_CHARS).join("");
  const lastSpace = title.lastIndexOf(" ");
  return (lastSpace > 0 ? title.slice(0, lastSpace) : title).trim();
}

async function generateMaterializedQueryChatTitle(
  store: StoreContextModel,
  queryItem: QueryItem,
  titlePrompt: string = MATERIALIZED_QUERY_CHAT_TITLE_PROMPT,
): Promise<string | null> {
  const messages = queryChatMessages(store, queryItem);
  if (messages.length == 0) {
    return null;
  }
  const response = await server.chatStream({
    requestId: newUid(),
    messages: [...messages, { role: "user", content: titlePrompt }],
    capabilities: queryChatCapabilities(store, queryItem),
    mode: "chat",
    model: effectiveQueryChatModelSelection(store, queryItem) ?? undefined,
  }, store.general.networkStatus, () => {});
  return titleFromModelResponse(response.assistantText);
}

function materializedAssistantSectionTitlePrompt(turnNumber: number, assistantText: string): string {
  const excerptChars = [...assistantText.trim().replace(/\s+/g, " ")].slice(0, 180);
  const excerpt = excerptChars.join("");
  const target = excerpt == ""
    ? `The target is assistant turn ${turnNumber}. `
    : `The target is assistant turn ${turnNumber}, beginning with ${JSON.stringify(excerpt)}. `;
  return "Give the selected assistant response in this conversation a concise, informative document title. " +
    target +
    "Name that response's underlying topic or answer, not the assistant's process, search method, sources, or caveats. " +
    "Err on the side of terseness: use the shortest natural noun phrase that clearly identifies the subject, usually " +
    "two to four words and never more than six. Use title case. Do not begin with words such as Finding, " +
    "Researching, Searching, Exploring, or Analyzing. " +
    "Use plain text only, with no Markdown, quotation marks, or ending punctuation. Reply with only the title.";
}

function queryChatRootIds(store: StoreContextModel, queryItem: QueryItem): Array<Uid> {
  return getQueryRuntime(store, queryItem).chat.rootItemIds ?? [];
}

function queryChatMessages(store: StoreContextModel, queryItem: QueryItem): Array<ChatMessage> {
  return getQueryRuntime(store, queryItem).chat.messages ?? [];
}

function textCharCount(text: string): number {
  return [...text].length;
}

function estimateChatContextTokens(messages: Array<ChatMessage>, extraText: string): number {
  let chars = 0;
  for (const message of messages) {
    if (message.content != null) {
      chars += textCharCount(message.content);
    }
    if (message.reasoningContent != null) {
      chars += textCharCount(message.reasoningContent);
    }
  }
  if (extraText != "") {
    chars += textCharCount(extraText);
  }
  return Math.floor((chars + 3) / 4);
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
): { label: string, exact: boolean } | null {
  const draft = draftText.trim();
  const messages = queryChatMessages(store, queryItem);
  const stored = getQueryRuntime(store, queryItem).chat;
  const useStored = stored.contextTokens != null && draft == "";
  const tokens = useStored
    ? stored.contextTokens!
    : estimateChatContextTokens(messages, draft);
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

function appendQueryChatMessage(store: StoreContextModel, queryItem: QueryItem, message: ChatMessage): void {
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      messages: [...(current.chat.messages ?? []), message],
    },
  }));
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

const CHAT_BUILTIN_CAPABILITIES: Array<ChatCapability> = ["infumap_data"];
const appliedDefaultPluginQueryIds = new Set<string>();

export function queryChatCapabilities(store: StoreContextModel, queryItem: QueryItem): Array<ChatCapability> {
  return getQueryRuntime(store, queryItem).chat.capabilities;
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

function withQueryChatCapability(
  capabilities: Array<ChatCapability>,
  capability: ChatCapability,
  enabled: boolean,
): Array<ChatCapability> {
  const next = new Set(capabilities);
  if (enabled) {
    next.add(capability);
  } else {
    next.delete(capability);
  }
  const builtins = CHAT_BUILTIN_CAPABILITIES.filter(item => next.has(item));
  const plugins = [...next].filter(item => !CHAT_BUILTIN_CAPABILITIES.includes(item));
  return [...builtins, ...plugins];
}

function setQueryChatCapability(
  store: StoreContextModel,
  queryItem: QueryItem,
  capability: ChatCapability,
  enabled: boolean,
): void {
  if (queryChatHasContent(store, queryItem)) {
    return;
  }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      capabilities: withQueryChatCapability(current.chat.capabilities ?? [], capability, enabled),
    },
  }));
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

export function applyQueryChatDefaultPluginCapabilities(
  store: StoreContextModel,
  queryItem: QueryItem,
  toolServers: Array<ChatToolServerInfo>,
): void {
  const defaultIds = toolServers
    .filter(server => server.enabledByDefault && server.available)
    .map(server => server.id);
  setExtraDefaultChatCapabilities(defaultIds);
  if (appliedDefaultPluginQueryIds.has(queryItem.id)) {
    return;
  }
  appliedDefaultPluginQueryIds.add(queryItem.id);
  if (queryChatHasContent(store, queryItem)) {
    return;
  }
  for (const id of defaultIds) {
    setQueryChatCapability(store, queryItem, id, true);
  }
}

/**
 * The backend and model picked for this chat, else the last one picked anywhere, else null for the
 * server's default. A chat that has never had a model picked for it follows the remembered default,
 * including if that changes. This is the raw choice - it may name something the server no longer
 * offers, so send effectiveQueryChatModelSelection rather than this.
 */
export function queryChatModelSelection(store: StoreContextModel, queryItem: QueryItem): ChatModelSelection | null {
  return getQueryRuntime(store, queryItem).chat.model ?? store.general.chatModelSelection();
}

/**
 * The selection to actually send, with anything the server no longer offers dropped so that the
 * server's own default takes over. A remembered choice outlives the configuration it was made
 * under: a key can be removed, and OpenRouter retires models. The server deliberately refuses to
 * substitute a backend that was named explicitly, so a stale choice has to be dropped here or chat
 * stops working until the user happens to open the picker.
 */
export function effectiveQueryChatModelSelection(
  store: StoreContextModel,
  queryItem: QueryItem,
): ChatModelSelection | null {
  const selection = queryChatModelSelection(store, queryItem);
  const backends = store.general.chatBackends();
  if (selection == null || backends == null) {
    // Without the catalog there is nothing to validate against; let the server judge.
    return selection;
  }

  const backend = backends.backends.find(candidate => candidate.id == selection.backend);
  if (backend == null || !backend.available) { return null; }
  if (!backend.supportsModelSelection) { return { backend: backend.id }; }

  const model = backend.models.find(candidate => candidate.id == selection.model);
  if (model == null) { return { backend: backend.id }; }
  const effort = selection.reasoningEffort;
  return {
    backend: backend.id,
    model: model.id,
    reasoningEffort: effort != null && model.reasoningEfforts.includes(effort) ? effort : undefined,
  };
}

/** Sets the model for this chat, and remembers it as the default for new ones. */
export function setQueryChatModelSelection(
  store: StoreContextModel,
  queryItem: QueryItem,
  selection: ChatModelSelection | null,
): void {
  store.general.setChatModelSelection(selection);
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: { ...current.chat, model: selection },
  }));
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

function addLocalQueryUserTurn(store: StoreContextModel, queryItem: QueryItem, text: string): Array<Item> {
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const composite = createTurnComposite(
    queryItem.ownerId,
    chatPage.id,
    "You",
    newOrderingAtEnd(queryChatRootOrderings(store, queryItem)),
    true,
  );
  const note = createTurnNote(
    queryItem.ownerId,
    composite.id,
    text,
    itemState.newOrderingAtEndOfChildren(composite.id),
    true,
  );
  setQueryChatRootIds(store, queryItem, [...queryChatRootIds(store, queryItem), composite.id]);
  return [composite, note];
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

  return { itemsInInsertionOrder, rootIds: roots.map(root => root.id) };
}

function cloneCompletedRounds(rounds: Array<ChatStreamingModelRound>): Array<ChatStreamingModelRound> {
  return rounds.map(round => ({
    ...round,
    toolCalls: round.toolCalls.map(toolCall => ({ ...toolCall })),
    complete: true,
  }));
}

function lastRoundReasoningContent(rounds: Array<ChatStreamingModelRound>): string | undefined {
  const reasoning = rounds[rounds.length - 1]?.reasoning;
  if (reasoning == null || reasoning == "") {
    return undefined;
  }
  return reasoning;
}

function nextQueryChatMessages(
  currentMessages: Array<ChatMessage>,
  assistantText: string,
  reasoningContent: string | undefined,
  transcriptMessages: Array<ChatMessage> | undefined,
): Array<ChatMessage> {
  if (transcriptMessages != null && transcriptMessages.length > 0) {
    return [...transcriptMessages];
  }
  return [
    ...currentMessages,
    {
      role: "assistant",
      content: assistantText,
      ...(reasoningContent == null ? {} : { reasoningContent }),
    },
  ];
}

function finalizeServerReturnedQueryItems(
  store: StoreContextModel,
  queryItem: QueryItem,
  itemObjects: Array<object>,
  assistantText: string,
  streamingState: ChatStreamingState,
  transcriptMessages: Array<ChatMessage> | undefined,
): Array<Item> {
  const staged = stageServerReturnedQueryItems(store, queryItem, itemObjects);
  const previousRuntime = getQueryRuntime(store, queryItem);
  const previousRootIds = [...(previousRuntime.chat.rootItemIds ?? [])];
  const nextRootIds = [...previousRootIds, ...staged.rootIds];
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const insertedItems: Array<Item> = [];
  const reasoningContent = lastRoundReasoningContent(streamingState.rounds);

  try {
    batch(() => {
      for (const item of staged.itemsInInsertionOrder) {
        prepareReturnedItem(item, true);
        insertedItems.push(item);
        itemState.add(item);
      }

      chatPage.computed_children = [...nextRootIds];
      const completedActivity: QueryChatCompletedActivity = {
        requestId: streamingState.requestId,
        assistantRootIds: [...staged.rootIds],
        assistantText,
        rounds: cloneCompletedRounds(streamingState.rounds),
        startedAt: streamingState.startedAt,
        completedAt: Date.now(),
      };
      updateQueryRuntime(store, queryItem, current => ({
        ...current,
        chat: {
          ...current.chat,
          rootItemIds: nextRootIds,
          messages: nextQueryChatMessages(
            current.chat.messages ?? [],
            assistantText,
            reasoningContent,
            transcriptMessages,
          ),
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

export async function submitQueryChatMessage(
  store: StoreContextModel,
  queryItem: QueryItem,
  rawText: string,
  deepResearch: boolean = false,
): Promise<void> {
  const text = rawText.trim();
  if (text == "") {
    return;
  }

  addLocalQueryUserTurn(store, queryItem, text);
  appendQueryChatMessage(store, queryItem, { role: "user", content: text });
  const messages = [...queryChatMessages(store, queryItem)];
  setQueryChatContextTokens(store, queryItem, estimateChatContextTokens(messages, ""), false);
  requestArrange(store, "query-chat-user-turn");

  const requestId = newUid();
  const controller = new AbortController();
  let clearStreamingStateOnExit = true;
  discardBufferedChatTextDeltas(queryItem.id);
  activeQueryChatRequestByQueryId.set(queryItem.id, { requestId, controller });
  setQueryChatStreamingState(queryItem.id, {
    requestId,
    phase: "submitted",
    statusText: "Preparing request",
    rounds: [],
    answerPreview: "",
    startedAt: Date.now(),
    errorMessage: null,
  });
  try {
    const response = await server.chatStream({
      requestId,
      messages,
      capabilities: queryChatCapabilities(store, queryItem),
      mode: deepResearch ? "deep_research" : "chat",
      model: effectiveQueryChatModelSelection(store, queryItem) ?? undefined,
    }, store.general.networkStatus, (event) => {
      if (event.type == "context_tokens") {
        setQueryChatContextTokens(store, queryItem, event.tokens, event.exact);
      }
      applyQueryChatStreamEvent(queryItem.id, event);
    }, controller.signal);

    if (controller.signal.aborted || chatStreamingStateByQueryId.get(queryItem.id)?.phase == "cancelled") {
      clearStreamingStateOnExit = false;
      return;
    }

    flushBufferedChatTextDeltas(queryItem.id, requestId);
    const finalStreamingState = chatStreamingStateByQueryId.get(queryItem.id);
    if (finalStreamingState == null || finalStreamingState.requestId != requestId) {
      throw new Error("Chat streaming state was lost before the response could be finalized.");
    }
    finalizeServerReturnedQueryItems(
      store,
      queryItem,
      response.items,
      response.assistantText,
      finalStreamingState,
      response.messages,
    );
    requestArrange(store, "query-chat-assistant-turn");
  } catch (e) {
    flushBufferedChatTextDeltas(queryItem.id, requestId);
    const current = chatStreamingStateByQueryId.get(queryItem.id);
    if (controller.signal.aborted || (current?.requestId == requestId && current.phase == "cancelled")) {
      if (current?.requestId == requestId && current.phase != "cancelled") {
        setQueryChatStreamingState(queryItem.id, reduceQueryChatStreamEvent(current, {
          requestId,
          type: "cancelled",
        }));
      }
      clearStreamingStateOnExit = false;
    } else {
      if (current?.requestId == requestId) {
        if (current.phase != "error") {
          setQueryChatStreamingState(queryItem.id, {
            ...current,
            phase: "error",
            statusText: "Chat failed",
            rounds: completeStreamingModelRounds(current.rounds),
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
        clearStreamingStateOnExit = false;
      }
      console.error("Failed to submit query chat message:", e);
    }
  } finally {
    const activeRequest = activeQueryChatRequestByQueryId.get(queryItem.id);
    if (activeRequest?.requestId == requestId) {
      activeQueryChatRequestByQueryId.delete(queryItem.id);
    }
    if (clearStreamingStateOnExit) {
      clearQueryChatStreamingState(queryItem.id, requestId);
    }
  }
}

function firstPromptInQueryChat(store: StoreContextModel, queryItem: QueryItem): string {
  for (const rootId of queryChatRootIds(store, queryItem)) {
    const root = itemState.get(rootId);
    if (!root) { continue; }
    if (isNote(root)) {
      return asNoteItem(root).title;
    }
    if (!isContainer(root)) { continue; }
    for (const childId of asContainerItem(root).computed_children) {
      const child = itemState.get(childId);
      if (child && isNote(child)) {
        return asNoteItem(child).title;
      }
    }
  }
  return "";
}

export function queryChatHasContent(store: StoreContextModel, queryItem: QueryItem): boolean {
  return queryChatRootIds(store, queryItem).length > 0;
}

function queryChatMarkdown(store: StoreContextModel, queryItem: QueryItem): string {
  const chat = getQueryRuntime(store, queryItem).chat;
  const activityByRootId = new Map<Uid, QueryChatCompletedActivity>();
  for (const activity of chat.completedActivities) {
    for (const rootId of activity.assistantRootIds) {
      activityByRootId.set(rootId, activity);
    }
  }

  const sections: Array<string> = [];
  const exportedActivities = new Set<string>();
  // Follow the visible turns, not the model transcript, which also contains tool exchanges.
  for (const rootId of chat.rootItemIds) {
    const activity = activityByRootId.get(rootId);
    if (activity != null) {
      if (!exportedActivities.has(activity.requestId)) {
        sections.push(`**Assistant**\n\n${activity.assistantText}`);
        exportedActivities.add(activity.requestId);
      }
      continue;
    }

    const root = itemState.get(rootId);
    if (root == null) { continue; }
    const notes = isContainer(root)
      ? asContainerItem(root).computed_children.map(id => itemState.get(id))
      : [root];
    const text = notes.filter(item => item != null && isNote(item))
      .map(item => asNoteItem(item!).title).join("\n\n");
    if (text != "") {
      sections.push(`**You**\n\n${text}`);
    }
  }
  return sections.join("\n\n---\n\n");
}

async function createQueryChatMarkdownItem(
  store: StoreContextModel,
  queryItem: QueryItem,
  title: string,
  markdown: string,
): Promise<boolean> {
  // The server uses the extension to recognize Markdown when detecting the data's MIME type.
  const filename = /\.(md|markdown)$/i.test(title) ? title : `${title}.md`;
  const textItem = TextFns.create(
    queryItem.ownerId,
    queryItem.parentId,
    RelationshipToParent.Child,
    filename,
    itemState.newOrderingDirectlyAfterChild(queryItem.parentId, queryItem.id),
  );
  const bytes = new TextEncoder().encode(markdown);
  textItem.mimeType = "text/markdown";
  textItem.fileSizeBytes = bytes.byteLength;

  try {
    const returnedItem = await server.addItem(textItem, base64ArrayBuffer(bytes.buffer), store.general.networkStatus);
    itemState.add(ItemFns.fromObject(returnedItem, null));
    requestArrange(store, "query-chat-markdown-created");
    showChatMarkdownMessage(store, "Markdown item created", TransientMessageType.Info);
    return true;
  } catch (e) {
    console.error("Failed to create Markdown from chat:", e);
    showChatMarkdownMessage(store, "Could not create Markdown item", TransientMessageType.Error);
    return false;
  }
}

function showChatMarkdownMessage(store: StoreContextModel, text: string, type: TransientMessageType): void {
  const message = { text, type };
  store.overlay.toolbarTransientMessage.set(message);
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, 3000);
}

export function clearQueryChat(store: StoreContextModel, queryItem: QueryItem): void {
  cancelQueryChatRequest(queryItem.id);
  const runtime = getQueryRuntime(store, queryItem);
  const pageId = runtime.chat.pageId;
  if (pageId != null) {
    itemState.pruneRelationshipSubtreeIfCurrent(pageId, queryItem.id, RelationshipToParent.Child);
  }
  const rootParentId = pageId ?? queryItem.id;
  for (const rootId of runtime.chat.rootItemIds) {
    itemState.pruneRelationshipSubtreeIfCurrent(rootId, rootParentId, RelationshipToParent.Child);
  }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      pageId: null,
      composerHeightPx: null,
      activityHeightPx: null,
      rootItemIds: [],
      messages: [],
      completedActivities: [],
      contextTokens: null,
      contextTokensExact: false,
    },
  }));
  clearQueryChatStreamingState(queryItem.id);
  clearQueryChatCompletedActivityUi(queryItem.id);
}

export function resetQueryChatSession(store: StoreContextModel, queryItem: QueryItem, arrangeReason?: string): void {
  clearQueryChat(store, queryItem);
  setQueryMode(store, queryItem, null);
  setQueryText(store, queryItem, "");
  if (arrangeReason != null) {
    requestArrange(store, arrangeReason);
  }
}

export async function materializeQueryChat(
  store: StoreContextModel,
  queryItem: QueryItem,
  onPhase?: (phase: QueryChatMaterializationPhase) => void,
): Promise<boolean> {
  if (!queryChatHasContent(store, queryItem)) {
    return false;
  }
  const parent = itemState.get(queryItem.parentId);
  if (!parent || !isContainer(parent)) {
    console.error("Failed to materialize query chat: no valid parent container.", queryItem);
    return false;
  }
  const markdown = queryChatMarkdown(store, queryItem);
  if (markdown == "") {
    return false;
  }
  const fallbackTitle = titleFromPrompt(firstPromptInQueryChat(store, queryItem));
  let generatedTitle: string | null = null;
  onPhase?.("generating_title");
  try {
    generatedTitle = await generateMaterializedQueryChatTitle(store, queryItem);
  } catch (e) {
    console.warn("Failed to generate a query chat document title; using the prompt-derived fallback:", e);
  }
  onPhase?.("creating_markdown");
  return createQueryChatMarkdownItem(store, queryItem, generatedTitle ?? fallbackTitle, markdown);
}

export async function materializeQueryChatAssistantSection(
  store: StoreContextModel,
  queryId: Uid,
  sectionRootId: Uid,
  activityRequestId: string,
  turnNumber: number,
  onPhase?: (phase: QueryChatMaterializationPhase) => void,
): Promise<boolean> {
  const queryItemMaybe = itemState.get(queryId);
  if (!queryItemMaybe || !isQueryItem(queryItemMaybe)) {
    console.error("Failed to materialize query chat section: query item is missing.", queryId);
    return false;
  }
  const queryItem = asQueryItem(queryItemMaybe);
  const sectionRoot = itemState.get(sectionRootId);
  const activity = getQueryRuntime(store, queryItem).chat.completedActivities
    .find(candidate => candidate.requestId == activityRequestId);
  if (!sectionRoot || !isContainer(sectionRoot) || !activity?.assistantRootIds.includes(sectionRootId)) {
    console.error("Failed to materialize query chat section: assistant section is missing.", sectionRootId);
    return false;
  }
  const parent = itemState.get(queryItem.parentId);
  if (!parent || !isContainer(parent)) {
    console.error("Failed to materialize query chat section: no valid parent container.", queryItem);
    return false;
  }

  const assistantText = activity.assistantText;
  const cleanedFallbackText = titleFromModelResponse(assistantText) ?? assistantText;
  const fallbackTitle = titleFromPrompt(cleanedFallbackText);
  let generatedTitle: string | null = null;
  onPhase?.("generating_title");
  try {
    generatedTitle = await generateMaterializedQueryChatTitle(
      store,
      queryItem,
      materializedAssistantSectionTitlePrompt(turnNumber, assistantText),
    );
  } catch (e) {
    console.warn("Failed to generate a query chat response document title; using the response-derived fallback:", e);
  }
  onPhase?.("creating_markdown");
  return createQueryChatMarkdownItem(store, queryItem, generatedTitle ?? fallbackTitle, assistantText);
}
