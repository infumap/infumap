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

import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VisualElement } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import type { QueryChatCompletedActivity } from "../store/StoreProvider_PerItem";
import { newOrdering } from "../util/ordering";
import { Uid } from "../util/uid";
import { queryChatCompletedActivityPlacementForComposite } from "./query-chat-activity-ui";
import { TextFns, TextItem, asTextItem, isText } from "./text-item";

const TITLE_MAX_CHARS = 60;

/**
 * The title of a turn as a markdown text item: the first line of its prompt, so that it still says what it is once it
 * is out of the chat, or "Turn N" for a message that was only attachments.
 */
export function queryChatTurnMarkdownTitle(activity: QueryChatCompletedActivity, turnNumber: number): string {
  const firstLine = activity.promptText.split("\n").map(line => line.trim()).find(line => line != "") ?? "";
  let chars = [...firstLine];
  if (chars.length > TITLE_MAX_CHARS) {
    chars = chars.slice(0, TITLE_MAX_CHARS);
    const lastSpace = chars.lastIndexOf(" ");
    if (lastSpace >= TITLE_MAX_CHARS / 2) { chars = chars.slice(0, lastSpace); }
  }
  // "What is X?.md" reads badly.
  const title = chars.join("").replace(/[\s?.!,:;…]+$/u, "");
  return `${title == "" ? `Turn ${turnNumber}` : title}.md`;
}

/**
 * A turn's answer as a markdown text item. Its text is only in the client (`clientText`) until the item is added to the
 * server, with that text as its content. The answer is the model's markdown, from which the chat's items were made.
 */
export function createQueryChatTurnMarkdownItem(
  ownerId: Uid,
  parentId: Uid,
  ordering: Uint8Array,
  activity: QueryChatCompletedActivity,
  turnNumber: number,
): TextItem {
  const item = TextFns.create(
    ownerId, parentId, RelationshipToParent.Child, queryChatTurnMarkdownTitle(activity, turnNumber), ordering);
  item.mimeType = "text/markdown";
  item.fileSizeBytes = new TextEncoder().encode(activity.assistantText).byteLength;
  item.clientText = activity.assistantText;
  return item;
}

const popupItemIdByTurn = new Map<string, Uid>();

/**
 * The item a turn's markdown popup shows, made once per turn. It is not one of the chat page's children, so it is
 * never shown in the chat itself, only as the popup's document.
 */
export function queryChatTurnMarkdownPopupItem(
  chatPageId: Uid,
  ownerId: Uid,
  queryId: Uid,
  activity: QueryChatCompletedActivity,
  turnNumber: number,
): TextItem {
  const key = `${queryId}|${activity.requestId}`;
  const existingId = popupItemIdByTurn.get(key);
  const existing = existingId == null ? null : itemState.get(existingId);
  if (existing != null && isText(existing)) { return asTextItem(existing); }

  const created = createQueryChatTurnMarkdownItem(ownerId, chatPageId, newOrdering(), activity, turnNumber);
  // Unlike add, this leaves the parent's children unchanged. Client-only fields are not in the object, so are set after.
  const item = asTextItem(itemState.upsertItemFromServerObject(TextFns.toObject(created), null));
  item.clientOnly = true;
  item.clientText = activity.assistantText;
  item.capabilities = { edit: false, move: false, copy: false, resize: false };
  popupItemIdByTurn.set(key, item.id);
  return item;
}

/** Opens the answer of the turn whose composite is `compositeVe` as a markdown document, in a popup. */
export function openQueryChatTurnMarkdownPopup(store: StoreContextModel, compositeVe: VisualElement): void {
  const composite = compositeVe.displayItem;
  const placement = queryChatCompletedActivityPlacementForComposite(store, composite.id, composite.parentId);
  if (placement == null) { return; }
  const item = queryChatTurnMarkdownPopupItem(
    composite.parentId, composite.ownerId, placement.queryId, placement.activity, placement.turnNumber);
  void TextFns.openDocumentPopup(compositeVe, store, item);
}
