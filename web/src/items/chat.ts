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
import { createSignal } from "solid-js";
import { asAttachmentsItem, isAttachmentsItem } from "./base/attachments-item";
import { asContainerItem, isContainer } from "./base/container-item";
import { CompositeFlags, PageFlags } from "./base/flags-item";
import { ClientOnlyItemKind, Item, ItemTypeMixin } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { CompositeFns, asCompositeItem, isComposite } from "./composite-item";
import { NoteFns, asNoteItem, isNote } from "./note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import { QueryItem, getQueryRuntime, setQueryMode, setQueryText, updateQueryRuntime } from "./query-item";
import { server, type ChatStreamEvent } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import type { ChatCapability } from "../store/StoreProvider_PerItem";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";

const MATERIALIZED_QUERY_CHAT_FALLBACK_TITLE = "Chat";

export function markAsQueryChatPage(item: Item): void {
  item.clientOnly = true;
  item.clientOnlyKind = ClientOnlyItemKind.QueryChatPage;
  makeQueryChatItemReadOnly(item);
}

export function isQueryChatPage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  const maybeItem = item as Partial<Item>;
  return maybeItem.clientOnly === true && maybeItem.clientOnlyKind == ClientOnlyItemKind.QueryChatPage;
}

function makeQueryChatItemReadOnly(item: Item): void {
  item.capabilities = {
    edit: false,
    move: false,
    copy: false,
    resize: false,
  };
}

export interface ChatProgress {
  text: string,
}

const chatProgressByQueryId = new Map<Uid, ChatProgress>();
const [chatProgressRevision, setChatProgressRevision] = createSignal(0, { equals: false });

export function chatProgressForQuery(queryId: Uid): ChatProgress | null {
  chatProgressRevision();
  return chatProgressByQueryId.get(queryId) ?? null;
}

function setQueryChatProgress(queryId: Uid, text: string): void {
  chatProgressByQueryId.set(queryId, { text });
  setChatProgressRevision(chatProgressRevision() + 1);
}

function clearQueryChatProgress(queryId: Uid): void {
  if (!chatProgressByQueryId.delete(queryId)) {
    return;
  }
  setChatProgressRevision(chatProgressRevision() + 1);
}

function chatProgressTextFromEvent(event: ChatStreamEvent): string | null {
  switch (event.type) {
    case "status":
      return event.text ?? null;
    case "tool_call_started":
      if (event.name == "find") {
        return "Finding items";
      }
      if (event.name == "search_text") {
        return "Searching source text";
      }
      if (event.name == "get_fragment") {
        return "Reading source text";
      }
      return event.name ? `Running ${event.name}` : "Running tool";
    case "tool_call_finished":
      if (event.name == "find") {
        return "Find complete";
      }
      if (event.name == "search_text") {
        return "Search complete";
      }
      if (event.name == "get_fragment") {
        return "Source text loaded";
      }
      return event.summary ?? "Tool complete";
    case "final_items":
      return "Adding response";
    case "error":
      return "Chat failed";
    default:
      return null;
  }
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
    temporaryPage.flags |= PageFlags.EmbeddedInteractive |
      PageFlags.HideDocumentTitle |
      PageFlags.HideEmbeddedInteractiveTitle;
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
  page.flags |= PageFlags.EmbeddedInteractive |
    PageFlags.HideDocumentTitle |
    PageFlags.HideEmbeddedInteractiveTitle;
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
    asContainerItem(item).childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(item.id);
  }
}

function addServerReturnedQueryItems(store: StoreContextModel, queryItem: QueryItem, itemObjects: Array<object>): Array<Item> {
  const chatPage = ensureTemporaryQueryChatPage(store, queryItem);
  const returnedItems = itemObjects.map(itemObject => ItemFns.fromObject(itemObject, null));
  const pending = new Map<Uid, Item>();
  const addedItems: Array<Item> = [];
  const addedRootIds: Array<Uid> = [];

  for (const item of returnedItems) {
    pending.set(item.id, item);
  }

  const roots = returnedItems.filter(item => item.parentId == null || item.parentId == EMPTY_UID);
  let rootOrderings = queryChatRootOrderings(store, queryItem);
  for (const root of roots) {
    root.parentId = chatPage.id;
    root.relationshipToParent = RelationshipToParent.Child;
    root.ordering = newOrderingAtEnd(rootOrderings);
    if (isComposite(root)) {
      asCompositeItem(root).flags |= CompositeFlags.ShowTitle;
    }
    prepareReturnedItem(root, true);
    itemState.add(root);
    addedItems.push(root);
    addedRootIds.push(root.id);
    rootOrderings = [...rootOrderings, root.ordering];
    pending.delete(root.id);
  }

  while (pending.size > 0) {
    let addedThisPass = false;
    for (const item of [...pending.values()]) {
      if (item.parentId == null || item.parentId == EMPTY_UID || itemState.get(item.parentId) == null) {
        continue;
      }
      prepareReturnedItem(item, true);
      itemState.add(item);
      addedItems.push(item);
      pending.delete(item.id);
      addedThisPass = true;
    }
    if (!addedThisPass) {
      console.error("Could not insert all query chat response items; some parent links were unresolved:", [...pending.values()]);
      break;
    }
  }

  if (addedRootIds.length > 0) {
    setQueryChatRootIds(store, queryItem, [...queryChatRootIds(store, queryItem), ...addedRootIds]);
  }

  return addedItems;
}

function collectQueryChatContextItemObjects(store: StoreContextModel, queryItem: QueryItem): Array<object> {
  const items: Array<Item> = [];
  for (const rootId of queryChatRootIds(store, queryItem)) {
    collectSubtreeItems(rootId, items);
  }
  return items.map(chatContextItemObject);
}

function chatContextItemObject(item: Item): object {
  const titled = item as Item & { title?: unknown };
  return {
    id: item.id,
    parentId: item.parentId,
    itemType: item.itemType,
    title: typeof titled.title == "string" ? titled.title : "",
  };
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

  const contextItems = collectQueryChatContextItemObjects(store, queryItem);
  addLocalQueryUserTurn(store, queryItem, text);
  requestArrange(store, "query-chat-user-turn");

  let clearProgressOnExit = true;
  setQueryChatProgress(queryItem.id, "Preparing request");
  try {
    const response = await server.chatStream({
      contextItems,
      userText: text,
      capabilities: queryChatCapabilities(store, queryItem),
    }, store.general.networkStatus, (event) => {
      const progressText = chatProgressTextFromEvent(event);
      if (progressText != null) {
        setQueryChatProgress(queryItem.id, progressText);
      }
    });

    addServerReturnedQueryItems(store, queryItem, response.items);
    requestArrange(store, "query-chat-assistant-turn");
  } catch (e) {
    const failedProgress = "Chat failed";
    setQueryChatProgress(queryItem.id, failedProgress);
    window.setTimeout(() => {
      if (chatProgressByQueryId.get(queryItem.id)?.text == failedProgress) {
        clearQueryChatProgress(queryItem.id);
      }
    }, 3000);
    clearProgressOnExit = false;
    console.error("Failed to submit query chat message:", e);
  } finally {
    if (clearProgressOnExit) {
      clearQueryChatProgress(queryItem.id);
    }
  }
}

function collectSubtreeItems(itemId: Uid, result: Array<Item>): void {
  const item = itemState.get(itemId);
  if (!item) {
    return;
  }
  result.push(item);

  if (isContainer(item)) {
    for (const childId of asContainerItem(item).computed_children) {
      collectSubtreeItems(childId, result);
    }
  }

  if (isAttachmentsItem(item)) {
    for (const attachmentId of asAttachmentsItem(item).computed_attachments) {
      collectSubtreeItems(attachmentId, result);
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
      rootItemIds: [],
    },
  }));
  clearQueryChatProgress(queryItem.id);
}

export function clearQueryChatForModeSwitch(store: StoreContextModel, queryItem: QueryItem): void {
  clearQueryChat(store, queryItem);
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
