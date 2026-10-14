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

import { createSignal } from "solid-js";
import { MAX_CLIPBOARD_TEXT_BYTES } from "../input/text_clipboard_create";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import type { LoadChatAttachment } from "../server";
import { Vector } from "../util/geometry";
import { NumberSignal } from "../util/signals";
import { newUid, Uid } from "../util/uid";
import { Item } from "./base/item";
import { asNoteItem, isNote } from "./note-item";
import { fetchTextItemContent } from "./text-document";
import { asTextItem, ChatAttachmentSource, isText, TextFns, TextItem } from "./text-item";

/**
 * Text attached to a chat message that has not been sent yet. Sent with the message and kept in the chat's transcript.
 * See docs/chat-attachments.md.
 */
export interface ChatDraftAttachment {
  id: Uid,
  title: string,
  mimeType: string,
  text: string,
}

/** The server's limits, `CHAT_ATTACHMENTS_MAX_COUNT` and `CHAT_ATTACHMENT_MAX_BYTES`. */
export const CHAT_ATTACHMENTS_MAX_COUNT = 10;
export const CHAT_ATTACHMENT_MAX_BYTES = MAX_CLIPBOARD_TEXT_BYTES;

const PASTE_ATTACHMENT_MIN_CHARS = 4000;
const PASTE_ATTACHMENT_MIN_LINES = 40;
const PASTED_TEXT_TITLE = "Pasted text";

const encoder = new TextEncoder();

export function chatAttachmentSizeBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Whether pasted text is long enough to be attached rather than put into the message. */
export function pastedTextIsAttachment(text: string): boolean {
  if (text.length >= PASTE_ATTACHMENT_MIN_CHARS) {
    return true;
  }
  let lines = 1;
  for (let i = 0; i < text.length; ++i) {
    if (text[i] == "\n" && ++lines >= PASTE_ATTACHMENT_MIN_LINES) {
      return true;
    }
  }
  return false;
}

/**
 * Pasted text as a new attachment after `existing`, titled "Pasted text", or "Pasted text 2" and on if that is taken.
 * A string is the reason it can't be attached.
 */
export function pastedTextAttachment(
  existing: Array<ChatDraftAttachment>,
  text: string,
): ChatDraftAttachment | string {
  if (existing.length >= CHAT_ATTACHMENTS_MAX_COUNT) {
    return `A message can have at most ${CHAT_ATTACHMENTS_MAX_COUNT} attachments`;
  }
  if (text.trim() == "") {
    return "The pasted text is empty";
  }
  if (chatAttachmentSizeBytes(text) > CHAT_ATTACHMENT_MAX_BYTES) {
    return "The pasted text is larger than 1 MB";
  }
  const titles = new Set(existing.map(attachment => attachment.title));
  let title = PASTED_TEXT_TITLE;
  for (let n = 2; titles.has(title); ++n) {
    title = `${PASTED_TEXT_TITLE} ${n}`;
  }
  return { id: newUid(), title, mimeType: "text/plain", text };
}

/** The file picker's suggestions. A dropped file of any name is attached if it is UTF-8 text. */
export const CHAT_ATTACHMENT_FILE_ACCEPT = [
  "text/*", ".txt", ".md", ".markdown", ".srt", ".vtt", ".csv", ".tsv", ".json", ".jsonl", ".log", ".xml", ".yaml",
  ".yml", ".toml", ".ini", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".kt", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".sh", ".sql",
].join(",");

/** The server's `CHAT_ATTACHMENT_TITLE_MAX_CHARS`. */
const ATTACHMENT_TITLE_MAX_CHARS = 200;

/**
 * A text file as a new attachment after `existing`, titled with the file's name. A string is the reason it can't be
 * attached: it is not UTF-8 text, or is empty or too large, or there are already as many attachments as allowed.
 */
export async function fileAttachment(
  existing: Array<ChatDraftAttachment>,
  file: File,
): Promise<ChatDraftAttachment | string> {
  if (existing.length >= CHAT_ATTACHMENTS_MAX_COUNT) {
    return `A message can have at most ${CHAT_ATTACHMENTS_MAX_COUNT} attachments`;
  }
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
    return `${file.name} is larger than 1 MB`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch (_e) {
    return `${file.name} is not a text file`;
  }
  // Valid UTF-8 can still be binary.
  if (text.includes("\u0000")) {
    return `${file.name} is not a text file`;
  }
  if (text.trim() == "") {
    return `${file.name} is empty`;
  }
  const title = [...file.name.trim()].slice(0, ATTACHMENT_TITLE_MAX_CHARS).join("") || "File";
  const lowerName = file.name.toLowerCase();
  const isMarkdown = lowerName.endsWith(".md") || lowerName.endsWith(".markdown");
  return { id: newUid(), title, mimeType: isMarkdown ? "text/markdown" : "text/plain", text };
}

/** An estimate, as for draft text: about four characters a token, plus the tags around the text. */
export function estimateChatAttachmentTokens(attachments: Array<ChatDraftAttachment>): number {
  return attachments.reduce(
    (sum, attachment) => sum + Math.floor(([...attachment.text].length + [...attachment.title].length + 3) / 4) + 8,
    0,
  );
}

/**
 * A chat attachment shown as a text item in its message's "You" composite. The item has no content in the object store:
 * its text is loaded from the chat (`chatAttachmentSource`). The caller sets its id and capabilities.
 */
export function createChatAttachmentItem(
  ownerId: Uid,
  parentId: Uid,
  ordering: Uint8Array,
  attachment: LoadChatAttachment,
  chat: ChatAttachmentSource["chat"],
): TextItem {
  const item = TextFns.create(ownerId, parentId, RelationshipToParent.Child, attachment.title, ordering);
  item.mimeType = attachment.mimeType;
  item.fileSizeBytes = attachment.sizeBytes;
  item.chatAttachmentSource = { chat, attachmentId: attachment.id };
  return item;
}

/**
 * The content of an item dropped on a chat's composer, as a new attachment after `existing`: a text item's text, or a
 * note's. A copy at the time of the drop: the attachment doesn't change with the item. A string is the reason it can't
 * be attached.
 */
export async function itemAttachment(
  existing: Array<ChatDraftAttachment>,
  item: Item,
  networkStatus: NumberSignal,
): Promise<ChatDraftAttachment | string> {
  if (!isText(item) && !isNote(item)) {
    return "Only text items and notes can be attached";
  }
  if (existing.length >= CHAT_ATTACHMENTS_MAX_COUNT) {
    return `A message can have at most ${CHAT_ATTACHMENTS_MAX_COUNT} attachments`;
  }
  let title: string;
  let text: string;
  let mimeType = "text/plain";
  if (isText(item)) {
    const textItem = asTextItem(item);
    try {
      text = await fetchTextItemContent(textItem, networkStatus);
    } catch (e) {
      console.error(`Could not read text item '${textItem.id}' to attach it:`, e);
      return `Could not read ${textItem.title}`;
    }
    title = textItem.title;
    mimeType = textItem.mimeType.startsWith("text/") ? textItem.mimeType : "text/plain";
  } else {
    text = asNoteItem(item).title;
    title = text.split("\n")[0].trim();
    if ([...title].length > 60) {
      title = [...title].slice(0, 60).join("").trimEnd() + "…";
    }
  }
  if (text.trim() == "") {
    return `${title || "The item"} is empty`;
  }
  if (chatAttachmentSizeBytes(text) > CHAT_ATTACHMENT_MAX_BYTES) {
    return `${title} is larger than 1 MB`;
  }
  title = [...(title.trim() || "Note")].slice(0, ATTACHMENT_TITLE_MAX_CHARS).join("");
  return { id: newUid(), title, mimeType, text };
}

/**
 * Marks an element as a drop target for items, with the key its composer registered: the path of the query item's
 * visual element, since one query item can be shown more than once, each with its own message being written.
 */
export const CHAT_ITEM_DROP_ATTRIBUTE = "data-infumap-chat-item-drop";

const chatItemDropTargets = new Map<string, (item: Item) => void>();
const [chatItemDropHover, setChatItemDropHover] = createSignal<string | null>(null);

/** The key of the composer an item being moved is over, for highlighting it. */
export { chatItemDropHover };

/**
 * Lets a composer accept items dropped on its elements marked with `CHAT_ITEM_DROP_ATTRIBUTE`. Infumap's own drags are
 * hit-tested by the layout, not by DOM drag events, so the drop is found in mouse_up.ts by `chatItemDropTargetAt`.
 * Returns a function that removes it.
 */
export function registerChatItemDropTarget(key: string, accept: (item: Item) => void): () => void {
  chatItemDropTargets.set(key, accept);
  return () => {
    if (chatItemDropTargets.get(key) == accept) {
      chatItemDropTargets.delete(key);
    }
  };
}

/** The key of the composer under a point in client coordinates, if a composer that accepts items is there. */
function chatItemDropKeyAt(clientPx: Vector): string | null {
  for (const el of document.elementsFromPoint(clientPx.x, clientPx.y)) {
    const key = el.closest(`[${CHAT_ITEM_DROP_ATTRIBUTE}]`)?.getAttribute(CHAT_ITEM_DROP_ATTRIBUTE);
    if (key && chatItemDropTargets.has(key)) {
      return key;
    }
  }
  return null;
}

/** The composer under a point in client coordinates, if there is one, as the function that attaches an item to it. */
export function chatItemDropTargetAt(clientPx: Vector): ((item: Item) => void) | null {
  const key = chatItemDropKeyAt(clientPx);
  return key == null ? null : chatItemDropTargets.get(key)!;
}

/** Called as an item is moved, with null when it stops, to highlight the composer under it. */
export function updateChatItemDropHover(clientPx: Vector | null): void {
  const hover = clientPx == null ? null : chatItemDropKeyAt(clientPx);
  if (chatItemDropHover() != hover) {
    setChatItemDropHover(hover);
  }
}
