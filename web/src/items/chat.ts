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
import { QueryItem, getQueryRuntime, setQueryMode, setQueryText, updateQueryRuntime } from "./query-item";
import { server, type ChatMessage, type ChatStreamEvent, type ChatStreamPhase } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import type {
  ChatCapability,
  QueryChatActivityModelRound,
  QueryChatActivityToolCall,
  QueryChatCompletedActivity,
} from "../store/StoreProvider_PerItem";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";

const MATERIALIZED_QUERY_CHAT_FALLBACK_TITLE = "Chat";

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

export function completedQueryChatActivityForQuery(
  store: StoreContextModel,
  queryItem: QueryItem,
): QueryChatCompletedActivity | null {
  const chat = getQueryRuntime(store, queryItem).chat;
  const currentRootIds = new Set(chat.rootItemIds ?? []);
  const activities = chat.completedActivities ?? [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity.assistantRootIds.some(rootId => currentRootIds.has(rootId))) {
      return activity;
    }
  }
  return null;
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
    case "tool_call_started":
      if (event.name == "find" || event.name == "lexical_search") {
        return "Finding items";
      }
      if (event.name == "search_text") {
        return "Searching source text";
      }
      if (event.name == "get_fragment") {
        return "Reading source text";
      }
      return `Running ${event.name}`;
    case "tool_call_finished":
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
    case "materializing":
      return "Adding response";
    case "final_items":
      return "Adding response";
    case "cancelled":
      return "Chat cancelled";
    case "error":
      return "Chat failed";
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
    case "tool_call_started":
      next = {
        ...current,
        phase: "using_tools",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => ({
          ...round,
          complete: true,
          toolCalls: [
            ...round.toolCalls.filter(toolCall => toolCall.callId != event.callId),
            { callId: event.callId, name: event.name, status: "running", summary: null },
          ],
        })),
      };
      break;
    case "tool_call_finished":
      next = {
        ...current,
        phase: "using_tools",
        statusText,
        rounds: updateStreamingModelRound(current.rounds, event.round, round => {
          const existingIndex = round.toolCalls.findIndex(toolCall => toolCall.callId == event.callId);
          const completed = { callId: event.callId, name: event.name, status: "complete" as const, summary: event.summary };
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

function queryChatRootIds(store: StoreContextModel, queryItem: QueryItem): Array<Uid> {
  return getQueryRuntime(store, queryItem).chat.rootItemIds ?? [];
}

function queryChatMessages(store: StoreContextModel, queryItem: QueryItem): Array<ChatMessage> {
  return getQueryRuntime(store, queryItem).chat.messages ?? [];
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

export function queryChatCapabilities(store: StoreContextModel, queryItem: QueryItem): Array<ChatCapability> {
  return getQueryRuntime(store, queryItem).chat.capabilities;
}

export function queryChatUsesInfumapData(store: StoreContextModel, queryItem: QueryItem): boolean {
  return queryChatCapabilities(store, queryItem).includes("infumap_data");
}

export function setQueryChatUsesInfumapData(
  store: StoreContextModel,
  queryItem: QueryItem,
  enabled: boolean,
): void {
  if (queryChatHasContent(store, queryItem)) {
    return;
  }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    chat: {
      ...current.chat,
      capabilities: enabled ? ["infumap_data"] : [],
    },
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

function finalizeServerReturnedQueryItems(
  store: StoreContextModel,
  queryItem: QueryItem,
  itemObjects: Array<object>,
  assistantText: string,
  streamingState: ChatStreamingState,
): Array<Item> {
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
        insertedItems.push(item);
        itemState.add(item);
      }

      chatPage.computed_children = [...nextRootIds];
      const completedActivity: QueryChatCompletedActivity = {
        requestId: streamingState.requestId,
        assistantRootIds: [...staged.rootIds],
        rounds: cloneCompletedRounds(streamingState.rounds),
        startedAt: streamingState.startedAt,
        completedAt: Date.now(),
      };
      updateQueryRuntime(store, queryItem, current => ({
        ...current,
        chat: {
          ...current.chat,
          rootItemIds: nextRootIds,
          messages: [...(current.chat.messages ?? []), { role: "assistant", content: assistantText }],
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

async function persistItems(store: StoreContextModel, items: Array<Item>): Promise<void> {
  for (const item of items) {
    await server.addItem(item, null, store.general.networkStatus);
  }
}

export async function submitQueryChatMessage(store: StoreContextModel, queryItem: QueryItem, rawText: string): Promise<void> {
  const text = rawText.trim();
  if (text == "") {
    return;
  }

  addLocalQueryUserTurn(store, queryItem, text);
  appendQueryChatMessage(store, queryItem, { role: "user", content: text });
  const messages = [...queryChatMessages(store, queryItem)];
  requestArrange(store, "query-chat-user-turn");

  const requestId = newUid();
  let clearStreamingStateOnExit = true;
  discardBufferedChatTextDeltas(queryItem.id);
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
    }, store.general.networkStatus, (event) => {
      applyQueryChatStreamEvent(queryItem.id, event);
    });

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
    );
    requestArrange(store, "query-chat-assistant-turn");
  } catch (e) {
    flushBufferedChatTextDeltas(queryItem.id, requestId);
    const current = chatStreamingStateByQueryId.get(queryItem.id);
    if (current?.requestId == requestId && current.phase != "error") {
      setQueryChatStreamingState(queryItem.id, {
        ...current,
        phase: "error",
        statusText: "Chat failed",
        rounds: completeStreamingModelRounds(current.rounds),
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    clearStreamingStateOnExit = false;
    console.error("Failed to submit query chat message:", e);
  } finally {
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

function cloneItemForMaterializedChat(source: Item, parentId: Uid, relationshipToParent: RelationshipToParent): Item {
  const clone = ItemFns.fromObject(ItemFns.toObject(source), null);
  clone.id = newUid();
  clone.parentId = parentId;
  clone.relationshipToParent = relationshipToParent;
  clone.groupId = null;
  clone.capabilities = null;
  delete clone.clientOnly;
  delete clone.clientOnlyKind;
  if (isContainer(clone)) {
    asContainerItem(clone).computed_children = [];
    asContainerItem(clone).childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(clone.id);
  }
  return clone;
}

function cloneChildrenIntoMaterializedChat(sourceParent: Item, targetParentId: Uid, result: Array<Item>): void {
  const cloneChildSubtree = (sourceId: Uid, relationshipToParent: RelationshipToParent) => {
    const child = itemState.get(sourceId);
    if (!child) { return; }
    const clone = cloneItemForMaterializedChat(child, targetParentId, relationshipToParent);
    itemState.add(clone);
    result.push(clone);
    cloneChildrenIntoMaterializedChat(child, clone.id, result);
  };

  if (isContainer(sourceParent)) {
    for (const childId of asContainerItem(sourceParent).computed_children) {
      cloneChildSubtree(childId, RelationshipToParent.Child);
    }
  }

  if (isAttachmentsItem(sourceParent)) {
    for (const attachmentId of asAttachmentsItem(sourceParent).computed_attachments) {
      cloneChildSubtree(attachmentId, RelationshipToParent.Attachment);
    }
  }
}

export function clearQueryChat(store: StoreContextModel, queryItem: QueryItem): void {
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
    },
  }));
  clearQueryChatStreamingState(queryItem.id);
}

export function resetQueryChatSession(store: StoreContextModel, queryItem: QueryItem, arrangeReason?: string): void {
  clearQueryChat(store, queryItem);
  setQueryMode(store, queryItem, null);
  setQueryText(store, queryItem, "");
  if (arrangeReason != null) {
    requestArrange(store, arrangeReason);
  }
}

export async function materializeQueryChat(store: StoreContextModel, queryItem: QueryItem): Promise<boolean> {
  if (!queryChatHasContent(store, queryItem)) {
    return false;
  }
  const parent = itemState.get(queryItem.parentId);
  if (!parent || !isContainer(parent)) {
    console.error("Failed to materialize query chat: no valid parent container.", queryItem);
    return false;
  }
  const sourceChatPage = ensureTemporaryQueryChatPage(store, queryItem);

  const materializedPage = PageFns.create(
    queryItem.ownerId,
    queryItem.parentId,
    RelationshipToParent.Child,
    titleFromPrompt(firstPromptInQueryChat(store, queryItem)),
    itemState.newOrderingDirectlyAfterChild(queryItem.parentId, queryItem.id),
  );
  materializedPage.arrangeAlgorithm = ArrangeAlgorithm.Document;
  materializedPage.flags |= PageFlags.HideDocumentTitle;
  materializedPage.orderChildrenBy = "";
  materializedPage.childrenLoaded = true;
  markChildrenLoadAsInitiatedOrComplete(materializedPage.id);

  itemState.add(materializedPage);
  const clonedItems: Array<Item> = [];
  cloneChildrenIntoMaterializedChat(sourceChatPage, materializedPage.id, clonedItems);
  requestArrange(store, "query-chat-materialize-local");

  try {
    await server.addItem(materializedPage, null, store.general.networkStatus);
    await persistItems(store, clonedItems);
    resetQueryChatSession(store, queryItem);
    store.perItem.setSelectedListPageItem(
      { itemId: materializedPage.parentId, linkIdMaybe: null },
      { itemId: materializedPage.id, linkIdMaybe: null },
    );
    requestArrange(store, "query-chat-materialize-complete");
    return true;
  } catch (e) {
    console.error("Failed to materialize query chat:", e);
    for (const item of clonedItems.reverse()) {
      itemState.delete(item.id);
    }
    itemState.delete(materializedPage.id);
    requestArrange(store, "query-chat-materialize-rollback");
    return false;
  }
}
