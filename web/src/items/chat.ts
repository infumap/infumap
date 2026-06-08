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
import { NoteFns } from "./note-item";
import { ArrangeAlgorithm, asPageItem, isPage, PageFns, PageItem } from "./page-item";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";

export const CHAT_DRAFT_TITLE = "New query";

export function isChatPage(page: PageItem): boolean {
  return page.arrangeAlgorithm == ArrangeAlgorithm.Document && !!(page.flags & PageFlags.Chat);
}

function draftTitleFromPrompt(prompt: string): string {
  const title = prompt.trim().replace(/\s+/g, " ");
  if (title == "") {
    return CHAT_DRAFT_TITLE;
  }
  return title.length <= 60 ? title : `${title.slice(0, 57)}...`;
}

function prepareChatPage(page: PageItem): void {
  page.arrangeAlgorithm = ArrangeAlgorithm.Document;
  page.flags |= PageFlags.Chat;
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

function addServerReturnedItems(itemObjects: Array<object>, clientOnly: boolean): Array<Item> {
  const items: Array<Item> = [];
  for (const itemObject of itemObjects) {
    const item = ItemFns.fromObject(itemObject, null);
    if (clientOnly) {
      item.clientOnly = true;
    }
    if (isContainer(item)) {
      asContainerItem(item).childrenLoaded = true;
      markChildrenLoadAsInitiatedOrComplete(item.id);
    }
    itemState.add(item);
    items.push(item);
  }
  return items;
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
  if (clientOnly && page.title == CHAT_DRAFT_TITLE) {
    page.title = draftTitleFromPrompt(text);
  }

  const userItems = addLocalUserTurn(page, text);
  requestArrange(store, "chat-user-turn");

  try {
    if (!clientOnly) {
      await persistItems(store, userItems);
    }

    const response = await server.chatDummy({
      ownerId: page.ownerId,
      pageId: page.id,
      prompt: text,
      compositeOrdering: Array.from(itemState.newOrderingAtEndOfChildren(page.id)),
      clientOnly,
    }, store.general.networkStatus);

    const assistantItems = addServerReturnedItems(response.items, clientOnly);
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

export async function materializeChatPage(store: StoreContextModel, page: PageItem): Promise<boolean> {
  if (page.clientOnly !== true) {
    return true;
  }

  const items: Array<Item> = [];
  collectSubtreeItems(page.id, items);

  try {
    await persistItems(store, items);
    for (const item of items) {
      delete item.clientOnly;
    }
    requestArrange(store, "chat-materialize");
    return true;
  } catch (e) {
    console.error("Failed to materialize chat page:", e);
    return false;
  }
}
