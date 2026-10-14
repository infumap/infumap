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
import { newUid, Uid } from "../util/uid";

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

/** An estimate, as for draft text: about four characters a token, plus the tags around the text. */
export function estimateChatAttachmentTokens(attachments: Array<ChatDraftAttachment>): number {
  return attachments.reduce(
    (sum, attachment) => sum + Math.floor(([...attachment.text].length + [...attachment.title].length + 3) / 4) + 8,
    0,
  );
}
