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

import { MAX_CLIPBOARD_TEXT_BYTES } from "../input/text_clipboard_create";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { itemIdFromInfumapUrl } from "../layout/navigation";
import { server, type LoadChatAttachment } from "../server";
import { isUid, newUid, Uid } from "../util/uid";
import { ChatAttachmentSource, TextFns, TextItem } from "./text-item";

/**
 * Text attached to a chat message that has not been sent yet. Sent with the message and kept in the chat's transcript.
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

/** One item reference on its own can be pasted as a message attachment. */
export function pastedChatItemId(text: string): Uid | null {
  const trimmed = text.trim();
  if (isUid(trimmed)) { return trimmed; }
  if (/\s/.test(trimmed)) { return null; }
  const linked = itemIdFromInfumapUrl(trimmed);
  if (linked != null) { return linked; }

  try {
    const url = new URL(trimmed);
    if ((url.protocol != "http:" && url.protocol != "https:") || url.host != window.location.host) { return null; }
    const id = url.pathname.replace(/^\/+|\/+$/g, "");
    return isUid(id) ? id : null;
  } catch {
    return null;
  }
}

export async function pastedItemAttachment(itemId: Uid, userId: Uid): Promise<ChatDraftAttachment | string> {
  try {
    const result = await server.prepareChatItemAttachment(itemId, userId);
    return "error" in result ? result.error : { id: newUid(), ...result };
  } catch (error) {
    console.error("Could not load the chat item attachment:", error);
    return "Could not read the item to attach it.";
  }
}

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
