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
import { Item } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { CompositeFns } from "./composite-item";
import { NoteFns, asNoteItem, isNote } from "./note-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns, PageItem } from "./page-item";
import { SearchItem, markAsQueryChatPage, tempQueryChatPageUid } from "./search-item";
import { server, type ChatStreamEvent } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { newOrdering } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";

export const CHAT_DRAFT_TITLE = "Chat";
const LEGACY_CHAT_DRAFT_TITLE = "New query";

export interface ChatProgress {
  text: string,
}

const chatProgressByPageId = new Map<Uid, ChatProgress>();
const [chatProgressRevision, setChatProgressRevision] = createSignal(0, { equals: false });

export function chatProgressForPage(pageId: Uid): ChatProgress | null {
  chatProgressRevision();
  return chatProgressByPageId.get(pageId) ?? null;
}

function setChatProgress(pageId: Uid, text: string): void {
  chatProgressByPageId.set(pageId, { text });
  setChatProgressRevision(chatProgressRevision() + 1);
}

function clearChatProgress(pageId: Uid): void {
  if (!chatProgressByPageId.delete(pageId)) {
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

export function isChatPage(page: PageItem): boolean {
  return page.arrangeAlgorithm == ArrangeAlgorithm.Document && !!(page.flags & PageFlags.Chat);
}

function titleFromPrompt(prompt: string): string {
  const titleWords = prompt.trim().replace(/\s+/g, " ").split(" ").filter(word => word != "").slice(0, 3);
  if (titleWords.length == 0) {
    return CHAT_DRAFT_TITLE;
  }
  return titleWords.join(" ");
}

function prepareChatPage(page: PageItem): void {
  page.arrangeAlgorithm = ArrangeAlgorithm.Document;
  page.flags &= ~PageFlags.ListPagePinBottom;
  page.flags |= PageFlags.Chat |
    PageFlags.HideDocumentTitle |
    PageFlags.ListPagePinTop |
    PageFlags.DisableLineItemExpand |
    PageFlags.DisableManualChildAdd;
  page.orderChildrenBy = "";
  page.childrenLoaded = true;
  markChildrenLoadAsInitiatedOrComplete(page.id);
}

export function removeClientOnlyChatPagesUnderQueries(_store: StoreContextModel, queriesPageId: Uid): void {
  const queriesPageMaybe = itemState.get(queriesPageId);
  if (!queriesPageMaybe || !isPage(queriesPageMaybe)) {
    return;
  }

  const queriesPage = asPageItem(queriesPageMaybe);
  for (const childId of [...queriesPage.computed_children]) {
    const child = itemState.get(childId);
    if (!child || !isPage(child)) {
      continue;
    }
    const page = asPageItem(child);
    if (page.clientOnly === true && isChatPage(page)) {
      clearDraftChatPage(page);
      itemState.delete(page.id);
    }
  }
}

export function ensureClientOnlyChatPageUnderQueryItem(searchItem: SearchItem): PageItem {
  const pageId = tempQueryChatPageUid(searchItem.id);
  let pageItem = itemState.get(pageId);
  if (!pageItem || !isPage(pageItem)) {
    const tempPage = PageFns.create(
      searchItem.ownerId,
      searchItem.id,
      RelationshipToParent.Child,
      CHAT_DRAFT_TITLE,
      newOrdering(),
    );
    tempPage.id = pageId;
    tempPage.origin = null;
    markAsQueryChatPage(tempPage);
    pageItem = itemState.upsertItemFromServerObject(PageFns.toObject(tempPage), null);
  }

  const page = asPageItem(pageItem);
  page.origin = null;
  page.ownerId = searchItem.ownerId;
  page.parentId = searchItem.id;
  page.relationshipToParent = RelationshipToParent.Child;
  markAsQueryChatPage(page);
  if (page.title == LEGACY_CHAT_DRAFT_TITLE) {
    page.title = CHAT_DRAFT_TITLE;
  }
  prepareChatPage(page);
  return page;
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
  }
  itemState.add(note);
  return note;
}

function addLocalUserTurn(page: PageItem, text: string): Array<Item> {
  const clientOnly = page.clientOnly === true;
  const composite = createTurnComposite(
    page.ownerId,
    page.id,
    "You",
    itemState.newOrderingAtEndOfChildren(page.id),
    clientOnly,
  );
  const note = createTurnNote(
    page.ownerId,
    composite.id,
    text,
    itemState.newOrderingAtEndOfChildren(composite.id),
    clientOnly,
  );
  return [composite, note];
}

function prepareReturnedItem(item: Item, clientOnly: boolean): void {
  if (clientOnly) {
    item.clientOnly = true;
  }
  if (isContainer(item)) {
    asContainerItem(item).childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(item.id);
  }
}

function addServerReturnedItems(page: PageItem, itemObjects: Array<object>, clientOnly: boolean): Array<Item> {
  const returnedItems = itemObjects.map(itemObject => ItemFns.fromObject(itemObject, null));
  const pending = new Map<Uid, Item>();
  const addedItems: Array<Item> = [];

  for (const item of returnedItems) {
    pending.set(item.id, item);
  }

  const roots = returnedItems.filter(item => item.parentId == null || item.parentId == EMPTY_UID);
  for (const root of roots) {
    root.parentId = page.id;
    root.relationshipToParent = RelationshipToParent.Child;
    root.ordering = itemState.newOrderingAtEndOfChildren(page.id);
    prepareReturnedItem(root, clientOnly);
    itemState.add(root);
    addedItems.push(root);
    pending.delete(root.id);
  }

  while (pending.size > 0) {
    let addedThisPass = false;
    for (const item of [...pending.values()]) {
      if (item.parentId == null || item.parentId == EMPTY_UID || itemState.get(item.parentId) == null) {
        continue;
      }
      prepareReturnedItem(item, clientOnly);
      itemState.add(item);
      addedItems.push(item);
      pending.delete(item.id);
      addedThisPass = true;
    }
    if (!addedThisPass) {
      console.error("Could not insert all chat response items; some parent links were unresolved:", [...pending.values()]);
      break;
    }
  }

  return addedItems;
}

function collectChatContextItemObjects(page: PageItem): Array<object> {
  const items: Array<Item> = [];
  for (const childId of page.computed_children) {
    collectSubtreeItems(childId, items);
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

export async function submitChatMessage(store: StoreContextModel, page: PageItem, rawText: string): Promise<void> {
  const text = rawText.trim();
  if (text == "") {
    return;
  }

  const clientOnly = page.clientOnly === true;
  const contextItems = collectChatContextItemObjects(page);

  const userItems = addLocalUserTurn(page, text);
  requestArrange(store, "chat-user-turn");

  let clearProgressOnExit = true;
  setChatProgress(page.id, "Preparing request");
  try {
    if (!clientOnly) {
      setChatProgress(page.id, "Saving your message");
      await persistItems(store, userItems);
    }

    const response = await server.chatStream({
      contextItems,
      userText: text,
    }, store.general.networkStatus, (event) => {
      const progressText = chatProgressTextFromEvent(event);
      if (progressText != null) {
        setChatProgress(page.id, progressText);
      }
    });

    const assistantItems = addServerReturnedItems(page, response.items, clientOnly);
    requestArrange(store, "chat-assistant-turn");

    if (!clientOnly) {
      setChatProgress(page.id, "Saving response");
      await persistItems(store, assistantItems);
    }
  } catch (e) {
    const failedProgress = "Chat failed";
    setChatProgress(page.id, failedProgress);
    window.setTimeout(() => {
      if (chatProgressByPageId.get(page.id)?.text == failedProgress) {
        clearChatProgress(page.id);
      }
    }, 3000);
    clearProgressOnExit = false;
    console.error("Failed to submit chat message:", e);
  } finally {
    if (clearProgressOnExit) {
      clearChatProgress(page.id);
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

function firstPromptInChatPage(page: PageItem): string {
  for (const childId of page.computed_children) {
    const child = itemState.get(childId);
    if (!child) { continue; }
    if (isNote(child)) {
      return asNoteItem(child).title;
    }
    if (!isContainer(child)) { continue; }
    for (const grandchildId of asContainerItem(child).computed_children) {
      const grandchild = itemState.get(grandchildId);
      if (grandchild && isNote(grandchild)) {
        return asNoteItem(grandchild).title;
      }
    }
  }
  return "";
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

function cloneChildrenIntoMaterializedChat(sourceParent: PageItem | Item, targetParentId: Uid, result: Array<Item>): void {
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

function clearDraftChatPage(page: PageItem): void {
  const itemsToDelete: Array<Item> = [];
  for (const childId of page.computed_children) {
    collectSubtreeItems(childId, itemsToDelete);
  }
  for (const item of itemsToDelete.reverse()) {
    itemState.delete(item.id);
  }
  page.title = CHAT_DRAFT_TITLE;
}

export async function materializeChatPage(store: StoreContextModel, page: PageItem): Promise<boolean> {
  if (page.clientOnly !== true) {
    return true;
  }
  if (page.computed_children.length == 0) {
    return false;
  }

  const materializedPage = PageFns.create(
    page.ownerId,
    page.parentId,
    RelationshipToParent.Child,
    titleFromPrompt(firstPromptInChatPage(page)),
    itemState.newOrderingDirectlyAfterChild(page.parentId, page.id),
  );
  materializedPage.arrangeAlgorithm = ArrangeAlgorithm.Document;
  materializedPage.flags |= PageFlags.HideDocumentTitle;
  materializedPage.orderChildrenBy = "";
  materializedPage.childrenLoaded = true;
  markChildrenLoadAsInitiatedOrComplete(materializedPage.id);

  itemState.add(materializedPage);
  const clonedItems: Array<Item> = [];
  cloneChildrenIntoMaterializedChat(page, materializedPage.id, clonedItems);
  requestArrange(store, "chat-materialize-local");

  try {
    await server.addItem(materializedPage, null, store.general.networkStatus);
    await persistItems(store, clonedItems);
    clearDraftChatPage(page);
    store.perItem.setSelectedListPageItem(
      { itemId: materializedPage.parentId, linkIdMaybe: null },
      { itemId: materializedPage.id, linkIdMaybe: null },
    );
    requestArrange(store, "chat-materialize-complete");
    return true;
  } catch (e) {
    console.error("Failed to materialize chat page:", e);
    for (const item of clonedItems.reverse()) {
      itemState.delete(item.id);
    }
    itemState.delete(materializedPage.id);
    requestArrange(store, "chat-materialize-rollback");
    return false;
  }
}
