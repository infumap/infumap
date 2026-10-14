# Chat attachments (proposal)

Status: in progress. Discussed 2026-10-14; steps 1–6 done 2026-10-14.

A common use of chat is pasting something long, such as a video transcript, and asking for a summary. Today the
pasted text goes into the message itself: the composer fills with it, and the "You" turn shows it as a wall of text.
Instead, text can be **attached** to a message. An attachment is shown as an item in the turn, opens as a text
document, and is sent to the model with the message.

## Design

### An attachment is a text item without object store content

An attachment has the fields of a text item made by pasting
([text_clipboard_create.ts](../web/src/input/text_clipboard_create.ts)): a title, a MIME type, a byte size and the
text. Only where the text is stored differs. Creating a text item in the item DB for a live chat is wrong, so the
text is kept in the chat's transcript. In the chat window, and on a `.chat` item's page, each attachment is a
read-only virtual text item, which can be opened, and copied out of the chat as a real text item.

### Attachments are stored in the transcript

`UserRecord` ([transcript.rs](../infumap/src/web/routes/command/chat/transcript.rs)) gets an `attachments` field:

```json
{"type":"user","requestId":"r1","startedAt":1,"text":"summarize this","attachments":[
  {"id":"<uid>","title":"Pasted text","mimeType":"text/plain","sizeBytes":48211,"text":"..."}],"settings":{...}}
```

- The attachments are appended and synced with the message, in one record. The revision (the count of `user`
  records) is unchanged, and an unsuccessful turn's attachments leave the model history with its text, as
  `Transcript::history` already does.
- A persisted `.chat` item stays a single self-contained blob. Files next to the transcript would need copying on
  persist and continue, and their own orphan cleanup.
- The field is optional with a serde default, so existing transcripts parse unchanged and the format version stays
  1. A server older than this change would ignore attachments when reading a newer transcript, dropping them from
  the model history. That is accepted.
- Only text for now. A later binary attachment (an image for a vision model) can add `"encoding": "base64"` and
  `"data"` without changing the format.
- The id is a uid made by the client when the attachment is added, so a virtual item for it can be made before the
  server has accepted the turn. The server rejects a malformed id or one repeated within the transcript.

### The model gets the attachments inline

The model's user message is the attachments, then the text:

```
<attachment name="Pasted text">
...
</attachment>

summarize this
```

Two alternatives were rejected:

- **A reference the model reads with `get_fragment`.** Weak models skip reads, as seen with a page's second
  fragment, and for "summarize this" a skipped part is the worst failure. Attachments also have to work with
  Infumap data off, when the model has no tools.
- **Truncating to fit the context.** A summary of part of a transcript, presented as a summary of all of it, is
  worse than an error.

The `<attachment>` tags follow the `<fragment>` wrapping used for `get_fragment` results. A `"` in a title is
replaced with `'`. No system prompt change is planned; the tags are self-explanatory.

### What reads attachments and what doesn't

| Reader | Sees attachment text |
| --- | --- |
| The model's history (`Transcript::history`) and the current turn | yes, inline |
| `load-chat` | no: metadata only (`id`, `title`, `mimeType`, `sizeBytes`) |
| `load-chat-attachment` (new) | yes, one attachment |
| Title generation (`chat_title_input_messages`) | no |
| Search indexing of `.chat` items (`chat_visible_text`) | no |

`load-chat` returns every turn whenever a chat is selected, so it must not carry attachment text. Search and titles
already read only `text`, so excluding attachments needs only tests. Leaving attachment text out of search is
deliberate: the answer usually indexes what the attachment was about, and copying the attachment out of the chat
makes it a searchable text item.

### Limits

- At most 1 MiB of UTF-8 per attachment, reusing `MAX_CLIPBOARD_TEXT_BYTES`, and at most 10 attachments per message.
  The server checks both and requires each `mimeType` to be `text/*`.
- The command request limit (`COMMAND_REQUEST_MAX_BYTES`, 256 MiB) is not a constraint.
- Nothing is truncated, and nothing is checked against the model's context size. A message too large for the
  context fails like any other turn, with the backend's error.

### Composer

- **Paste.** A paste over 4,000 characters or 40 lines becomes an attachment chip instead of text in the input. A
  smaller paste goes into the input as now.
- **Chips** sit in a row above the input: a file icon, the title, the size and estimated tokens, an "insert as
  text" action, and ×. Pasted text is titled "Pasted text", numbered when there are several ("Pasted text 2").
  A title from the first line is unreliable for transcripts ("[Music]", "Kind: captions").
- **+ button**, left of the input: a file picker for text files. A file that isn't valid UTF-8 is refused with a
  message. Files dropped onto the composer from the OS are attached the same way.
- **Attachments without text** can be sent. The turn then has no message note.
- **Restoring the draft.** Wherever the draft is given back (a revision conflict, or a turn refused before it was
  recorded), the attachments are given back with it.

### Rendering

A "You" composite holds the turn's attachments, as text items, before the message note, which is left out when the
message has no text. Each attachment item has a client-only field naming its source,
`chatAttachmentSource: { chat: { queryItemId } | { chatItemId }, attachmentId }`, like `clipboardTextContent`.
`fetchTextItemContent` ([text-document.ts](../web/src/items/text-document.ts)) loads such an item's text with
`load-chat-attachment` instead of from `/files/{id}`, cached by attachment rather than by item. Item ids follow the
other items of the view they are in: new uids in the chat window, as for its notes, and stable ids from the turn and
attachment index on a `.chat` page.

Opening an attachment shows the usual text document page, as a popup. The page must not put the attachment's id in
the URL: a reload would look the id up on the server and not find it (`Main.tsx`, `openTextDocumentProjection`). A
popup keeps the address of the page it opens over.

## Implementation steps

Each step can be committed on its own. Steps 1–4 cover pasting a transcript and asking for a summary.

1. **Transcript and model input (server).**
   - Add `ChatAttachment { id, title, mime_type, size_bytes, text }` and `UserRecord.attachments`
     (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) in
     [transcript.rs](../infumap/src/web/routes/command/chat/transcript.rs).
   - Add `UserRecord::model_content()`, which builds the wrapped content, and use it in `Transcript::history` and in
     `start_live_chat_turn`'s current message ([chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs)), so
     the two can't disagree.
   - Add `attachments` to `ChatRequest`. They are accepted only with a query item id; a request without one rejects
     them. In `start_live_chat_turn`, validate (count, size, `text/*` MIME, uid ids not already in the transcript,
     non-empty title of at most 200 characters, `size_bytes` recomputed by the server), and require non-empty text
     **or** at least one attachment.
   - Derived title: `title_from_prompt` falls back to the first attachment's title when the text is empty.
   - Tests: round-trip with attachments; a record without the field parses; history wraps attachments before the
     text, in order; a failed turn's attachments are not in the history; title input and `chat_visible_text` leave
     out attachment text; each validation failure.

   Done 2026-10-14: `ChatAttachment` and `UserRecord::model_content` in
   [transcript.rs](../infumap/src/web/routes/command/chat/transcript.rs); `ChatAttachmentRequest` and
   `chat_attachments_from_request` in [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs). Details:
   - The server trims titles and rejects one with control characters. It also rejects an attachment whose text is
     only whitespace. The text itself is stored as sent, not trimmed.
   - A request without a query item id that has attachments is refused before anything runs.
   - The client no longer derives titles (`archive_used_query_entry` does, on the server), so there was no client
     copy of `title_from_prompt` to change. Its comment saying there was is corrected.
   - Not checked end to end: no client sends attachments until step 3.

2. **Load metadata and attachment content (server).**
   - Add `attachments: Vec<{ id, title, mimeType, sizeBytes }>` to `LoadChatTurn`, for live and persisted chats
     alike.
   - Add a `load-chat-attachment` command taking `{ queryItemId | chatItemId, attachmentId }` and returning
     `{ text }`, with the same ownership checks as `handle_load_chat` (`live_chat_data_dir`,
     `read_persisted_chat`). It reads the whole transcript; that is fine at these sizes.
   - Add `loadChat`/`loadPersistedChat` response types and `server.loadChatAttachment` in
     [server.ts](../web/src/server.ts).
   - Test: the load response holds no attachment text.

   Done 2026-10-14: `LoadChatAttachment` and `handle_load_chat_attachment` in
   [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs), sharing `read_chat_for_load` with `load-chat`;
   `LoadChatAttachment` and `server.loadChatAttachment(chat, attachmentId)` in [server.ts](../web/src/server.ts),
   where `chat` is `{ queryItemId }` or `{ chatItemId }`. An attachment id not in the chat is an error. Tested on a
   live chat only: no test covers a persisted chat, which goes through the same `read_persisted_chat` as
   `load-chat`. Not checked end to end; the command is one line of dispatch.

3. **Composer (client).**
   - Hold the draft's attachments next to `chatText` in [Query.tsx](../web/src/components/items/Query.tsx):
     `{ id, title, mimeType, text }[]`.
   - Handle `onPaste` on the chat textarea: above the threshold, prevent the default and add a chip.
   - Render the chip row and include its height in `wrapperHeightPx` and in the height passed to
     `setQueryChatComposerHeightPx`, so the transcript's bottom inset accounts for it.
   - Change `sendChatMessage` and `submitQueryChatMessage` to take attachments. Enable the send button when there
     is text or an attachment, and send `attachments` in `server.chatStream`.
   - Give the attachments back wherever the text is given back (`!recorded`).
   - Add attachment text to the draft estimate in `queryChatContextTokenDisplay` and in the post-submit estimate in
     `submitQueryChatMessage`.
   - Also on the New Query input when it is in chat or deep research mode, since a first message is often a
     paste: the same paste handling and chips there, and `startQueryChat` passes the attachments on. In search mode
     a paste stays plain text.
   - At this point attachments are sent and recorded, but a turn shows only its text.

   Done 2026-10-14: [chat-attachment.ts](../web/src/items/chat-attachment.ts) (the draft attachment type, the paste
   threshold, titles and limits) and [Query.tsx](../web/src/components/items/Query.tsx). Details:
   - One draft signal serves both inputs, since they belong to the same query item: attachments pasted into the New
     Query input are the ones the chat composer shows once the chat starts.
   - In the New Query input the chips sit above the input, which stays where it was. They are shown only in chat and
     deep research modes. A search ignores them, and they come back on switching to chat.
   - The chat composer's height for the transcript layout is now set by an effect from the input height plus the
     chip row, not in `resizeChatTextarea`.
   - "Insert as text" puts the text at the caret, as the paste would have. Chip buttons prevent the default on mouse
     down, so the input keeps the focus and the caret.
   - Over the limits (10 attachments, 1 MiB), a paste is refused with a message rather than inserted as text.
   - Checked end to end with Playwright against a fake llama-server: a paste in the New Query input in chat mode,
     sent with text; the model got `<attachment name="Pasted text">…</attachment>\n\nsummarize this`. In the
     composer: a short paste stayed text, insert as text, two chips numbered "Pasted text" and "Pasted text 2", ×,
     sending an attachment alone, and a revision conflict giving back both the text and the attachment. The
     transcript and `load-chat-attachment` had the expected content. As expected until step 4, a turn of only
     attachments shows an empty "You".

4. **Attachments in turns (client).**
   - Add `chatAttachmentSource` to `TextItem` ([text-item.ts](../web/src/items/text-item.ts)), client-only like
     `clipboardTextContent`, and route `fetchTextItemContent` through `server.loadChatAttachment` for it.
   - Add a `createChatAttachmentItem` helper used by `addLocalQueryUserTurn` ([chat.ts](../web/src/items/chat.ts)),
     for both submitted and loaded turns, and by `createChatDocumentItems`
     ([text-document.ts](../web/src/items/text-document.ts)). The attachment items come before the note, and the
     note is left out when the text is empty.
   - On submit, seed the content cache (`textContentPromises`) with the local text, so an attachment opens before
     the turn is accepted, without asking the server.
   - Check that a text item renders and opens inside a "You" composite. Settle how the document page opens without
     a URL change.
   - **Copying turns must keep working.** A shift-dragged "You" turn now has text item descendants, and adding a
     text item needs its data. `cloneDescendantsForCopy`
     ([mouse_move_move.ts](../web/src/input/mouse_move_move.ts)) goes through `toObject`, which drops client-only
     fields, so copy `chatAttachmentSource` across explicitly. Where copied descendants are added
     ([mouse_up.ts](../web/src/input/mouse_up.ts)), fetch an attachment's text and pass it as base64 to
     `server.addItem`, as `finishPendingClipboardTextItem` does. Do the same for the non-virtual `.chat` page
     (`createMaterializedTextDocumentItems`). The copy is then an ordinary text item and no longer carries
     `chatAttachmentSource`.
   - Check end to end on a throwaway test server with the fake llama-server: paste,
     send, check the model request in `/tmp/llm.txt`, reload, open the attachment, persist the chat, open the
     `.chat` page and its attachment, Continue, shift-drag a "You" turn into a page, and a revision conflict giving
     back text and attachments.

   Done 2026-10-14: `createChatAttachmentItem` in [chat-attachment.ts](../web/src/items/chat-attachment.ts), used by
   `addLocalQueryUserTurn` ([chat.ts](../web/src/items/chat.ts)) and `createChatDocumentItems`;
   `ChatAttachmentSource` in [text-item.ts](../web/src/items/text-item.ts); `seedChatAttachmentContent` and
   `chatAttachmentCopyData` in [text-document.ts](../web/src/items/text-document.ts). Details:
   - `TextFns.handleLinkClick` opens an attachment with `TextFns.openDocumentPopup`.
   - `chatAttachmentSource` is not in `TextFns.toObject`, so it never reaches the server. `toVirtualServerObject`
     writes it and `TextFns.fromObject` reads it, because the virtual `.chat` page round-trips its items through
     objects. `cloneDescendantsForCopy` copies it across explicitly.
   - `chatAttachmentCopyData` gives an attachment copy its text as base64 for `add-item`, and removes
     `chatAttachmentSource` from it, so the copy is an ordinary text item. It is called by the three add loops that
     can meet a copy: copied descendants of a shift-dragged turn (`enqueueUpdateItem` in
     [mouse_up.ts](../web/src/input/mouse_up.ts)), text document materialization on drop
     (`enqueueTextDocumentMaterializationIfPending`), and `materializeTextDocumentPage`.
   - The "Open text file" toolbar button opens an attachment's text as a blob URL in a new tab. Not tested.
   - `fetchTextItemContent` now takes the network status signal, for `load-chat-attachment`.
   - Checked end to end with Playwright against a fake llama-server: a turn shows its attachment then its text, and
     a turn of an attachment alone shows no empty note. Opening an attachment shows a popup with its text, without a
     URL change, in the chat window, after a reload (text from the server), and on a persisted `.chat` page.
     Shift-dragging a "You" turn into a page made a composite with a text item holding the attachment's 3,289 bytes
     in the object store, then the note. Shift-dragging the `.chat` item made an editable page whose attachment items
     had their text.
   - Seen in the test, not changed: a `text/plain` document page shows single line breaks as spaces, so a
     transcript of short lines reads as one paragraph. That is how text documents render today.

5. **Copying a single attachment out.** Shift-dragging an attachment item out of a turn makes a real text item where
   it is dropped. This uses step 4's copy path; make the attachment item itself `readonlyCopyableCapabilities`. Check
   from both the chat window and a `.chat` page.

   Done 2026-10-14, in [mouse_move_move.ts](../web/src/input/mouse_move_move.ts). Details:
   - Attachment items are now copyable, in the chat window (`makeQueryChatTurnCopyable`) and on a `.chat` page
     (`makeCopyable`).
   - Shift-dragging a text item normally makes a page from its document (`textDocumentMaterializeMoveRequested`). A
     chat attachment (`isChatAttachmentItem`) is excluded and copied instead.
   - Shift-drag doesn't clone data items, whose content would need copying. A chat attachment is the exception: its
     content comes from the chat.
   - Moving an item out of a composite (`moving_activeItemToPage`) used to add a shift-drag clone to the server at
     once, and to require a page that can take a live move. With `copyOnly` (the item can be copied but not moved),
     the clone is added on drop with its descendants, as a turn copy is (`setItemCopyMove`), and the page only has
     to hold the clone during the drag (`pageCanHostPendingCopy`). The chat window's page is client only and a
     `.chat` page is read only, so neither could start a live move.
   - On drop, the copy is added with its text (`chatAttachmentCopyData`), in the same branch of `enqueueUpdateItem`
     as a turn copy.
   - The copy is titled "Pasted text (copy)", as other shift-drag copies are.
   - Checked end to end with Playwright: a plain drag did nothing. A shift-drag onto a dock page, from the chat
     window and from a `.chat` page, made a text item there with the attachment's 3,289 bytes, and the chat was
     unchanged. Shift-dragging the copy, now an ordinary text item, still made a page from it.

6. **+ button and dropped files.**
   - Add a hidden file input with `accept` for `.txt`, `.md`, `.srt`, `.vtt`, `.csv`, `.json`, `.log` and common
     source extensions. Read files with `TextDecoder("utf-8", { fatal: true })` and refuse invalid UTF-8.
   - The title is the file name. The MIME type is `text/markdown` for `.md`, so it opens as Markdown, and
     `text/plain` otherwise.
   - Handle OS file drops on the composer the same way, and stop them from reaching the page's own upload-on-drop.

   Done 2026-10-14: `fileAttachment` and `CHAT_ATTACHMENT_FILE_ACCEPT` in
   [chat-attachment.ts](../web/src/items/chat-attachment.ts), and [Query.tsx](../web/src/components/items/Query.tsx).
   Details:
   - The + button is left of the chat composer's input. It is also inside the New Query input, on the left, in chat
     and deep research modes only, and is in that input's Tab order (mode, +, input, send).
   - The `accept` list only filters the picker. A file is attached if it decodes as UTF-8 and holds no NUL, whatever
     its name: a dropped file has no filter. Files are read one at a time, so the count limit applies across a
     multiple selection. Each refusal shows a message naming the file: not text, empty, or over 1 MB.
   - A file's title is its name. Its MIME type is `text/markdown` for `.md` and `.markdown`, and `text/plain`
     otherwise, so `.csv` and `.json` open as plain text.
   - Drops are taken on the chat composer, including its settings row and chips, and on the New Query controls in
     chat mode. The window's capture-phase guard in `Main.tsx` still allows the drop. The composer's `onDrop` stops
     propagation, so the window's bubble-phase upload listener (`externalFileDropFallbackListener`) never sees it, and
     it clears the upload hover.
   - Checked end to end with Playwright. The picker took `notes.md` and `talk.srt` and refused `image.png` with "image.png
     is not a text file". The model got both wrapped before the text. `notes.md` was stored as `text/markdown`, opened
     as Markdown, and shows the Markdown icon. A `DragEvent` drop of `dropped.txt` on the composer made a chip and
     uploaded nothing: the home and Queries pages gained no item.

7. **Attaching an item from the tree** (later). Dropping a text item or note onto the composer attaches a copy of
   its content at that moment, and the item snaps back. Infumap drags are hit-tested by the layout, not by DOM drag
   events, so the composer needs to be a drop target in [mouse_up.ts](../web/src/input/mouse_up.ts)
   terms. Investigate that first.

8. **Docs.** [chats.md](chats.md): attaching, limits, attachments not being searched, copying an attachment out.
   [chat-tools.md](chat-tools.md): how attachments reach the model.

## Not planned

- A warning, before sending, that a message won't fit the model's context. The turn fails with the backend's error
  instead.

- PDFs, images and other binary attachments. PDFs could go through the existing text extraction and be attached as
  text; images need vision-capable models and the base64 form above.
- Summarizing an attachment too large for the context, for example in pieces.
- Removing timestamps from `.srt`/`.vtt` text. It would save tokens, but it changes what the user attached.
