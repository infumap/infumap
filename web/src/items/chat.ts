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
import { asContainerItem, isContainer } from "./base/container-item";
import { CompositeFlags, PageFlags } from "./base/flags-item";
import { Item } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { CompositeFns } from "./composite-item";
import { NoteFns, asNoteItem, isNote } from "./note-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns, PageItem } from "./page-item";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { EMPTY_UID, Uid, newUid } from "../util/uid";

export const CHAT_DRAFT_TITLE = "Chat";
const LEGACY_CHAT_DRAFT_TITLE = "New query";

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
  page.flags |= PageFlags.Chat | PageFlags.HideDocumentTitle | PageFlags.ListPagePinTop | PageFlags.DisableLineItemExpand;
  page.orderChildrenBy = "";
  page.childrenLoaded = true;
  markChildrenLoadAsInitiatedOrComplete(page.id);
}

export function ensureClientOnlyChatPageUnderQueries(store: StoreContextModel, queriesPageId: Uid): Uid | null {
  const queriesPageMaybe = itemState.get(queriesPageId);
  if (!queriesPageMaybe || !isPage(queriesPageMaybe)) {
    return null;
  }

  const queriesPage = asPageItem(queriesPageMaybe);
  for (const childId of queriesPage.computed_children) {
    const child = itemState.get(childId);
    if (child && isPage(child)) {
      const page = asPageItem(child);
      if (page.clientOnly === true && isChatPage(page)) {
        if (page.title == LEGACY_CHAT_DRAFT_TITLE) {
          page.title = CHAT_DRAFT_TITLE;
        }
        prepareChatPage(page);
        return page.id;
      }
    }
  }

  const page = PageFns.create(
    queriesPage.ownerId,
    queriesPage.id,
    RelationshipToParent.Child,
    CHAT_DRAFT_TITLE,
    itemState.newOrderingAtBeginningOfChildren(queriesPage.id),
  );
  prepareChatPage(page);
  page.clientOnly = true;
  itemState.add(page);
  requestArrange(store, "chat-draft-page-create");
  return page.id;
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
  return items.map(item => ItemFns.toObject(item));
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

  try {
    if (!clientOnly) {
      await persistItems(store, userItems);
    }

    const response = await server.chat({
      contextItems,
      userText: text,
    }, store.general.networkStatus);

    const assistantItems = addServerReturnedItems(page, response.items, clientOnly);
    requestArrange(store, "chat-assistant-turn");

    if (!clientOnly) {
      await persistItems(store, assistantItems);
    }
  } catch (e) {
    console.error("Failed to submit chat message:", e);
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

function cloneItemForMaterializedChat(source: Item, parentId: Uid): Item {
  const clone = ItemFns.fromObject(ItemFns.toObject(source), null);
  clone.id = newUid();
  clone.parentId = parentId;
  clone.relationshipToParent = RelationshipToParent.Child;
  clone.groupId = null;
  clone.capabilities = null;
  delete clone.clientOnly;
  if (isContainer(clone)) {
    asContainerItem(clone).computed_children = [];
    asContainerItem(clone).childrenLoaded = true;
    markChildrenLoadAsInitiatedOrComplete(clone.id);
  }
  return clone;
}

function cloneChildrenIntoMaterializedChat(sourceParent: PageItem | Item, targetParentId: Uid, result: Array<Item>): void {
  if (!isContainer(sourceParent)) { return; }
  for (const childId of asContainerItem(sourceParent).computed_children) {
    const child = itemState.get(childId);
    if (!child) { continue; }
    const clone = cloneItemForMaterializedChat(child, targetParentId);
    itemState.add(clone);
    result.push(clone);
    cloneChildrenIntoMaterializedChat(child, clone.id, result);
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
