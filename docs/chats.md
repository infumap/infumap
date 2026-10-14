# Chats

Chats run in the **Queries** page. Each chat is kept as you go: reloading the page or closing the browser does not
lose it, and you can keep a chat in your item tree, continue it later, or copy parts of it into your pages.

## New Query and earlier chats

**New Query**, pinned at the top of the Queries page, is where you start a search or a chat.

- **Starting a chat** moves it down into the list, as the newest earlier chat, as soon as your first message is
  accepted. The chat stays open while its response runs, and a new, empty New Query takes its place at the top. To
  start another chat, select New Query.
- **Earlier chats** are listed below New Query, newest first. Select one to read it, and send a message to
  continue it. Earlier chats are only for chatting: their search mode is not offered.
- A chat is named from the first words of its first message. When it becomes an earlier chat, it is given a short
  title describing it, unless you have renamed it.

A chat records every message you send and how each response ended. A response you stop, or that fails, is shown
with a note saying so, and is left out of what the model sees from then on.

If you send a message in a chat that changed elsewhere since you last loaded it, for example in another tab, the
chat is reloaded and your message is put back in the input for you to send again. Only one response runs in a chat
at a time.

## Attaching text

Long text, such as a video transcript to summarize, can be attached to a message instead of filling it. Each
attachment is shown above the input, with its size and an estimate of its tokens, and is sent with the message.
There are several ways to attach text:

- **Paste it.** A paste of 4,000 characters or more, or 40 lines or more, becomes an attachment named "Pasted text".
  A shorter paste goes into the message as usual. To put an attachment's text into the message after all, use its
  insert-as-text button; × removes it.
- **Pick files** with the + button next to the input, or **drop files** from your computer onto the input. Any
  UTF-8 text file can be attached, named by its file name. A Markdown file (`.md`) opens as Markdown.
- **Drag a text item or a note** from your items onto the input. Its content is attached as it is now; later edits
  to the item don't change the attachment. The item stays where it was.

You can attach in the chat input, and in New Query when Chat or Deep research is selected. A message can be
attachments alone, with no text.

Attachments are text only: PDFs, images and other binary files are refused. A message can have up to 10, of up to
1 MB each. Nothing checks that they fit the model's context; a message too large for it fails like any other, with
the model's error.

The model gets the whole text of each attachment, before your message, and it stays in what the model sees for the
rest of the chat. Large attachments use up context in every later turn.

In the chat, a message's attachments are listed above its text. Click one to open it. Shift-drag one onto a page to
copy it there as a text item, or shift-drag the whole message to copy it with its attachments. Attachments are kept
with the chat, including when you keep it as a `.chat` item, and copied when you continue one.

## Deleting an earlier chat

Drag it to the trash. New Query cannot be deleted. A chat in the trash can be dragged
back to the Queries page. Emptying the trash deletes it for good.

## Keeping a chat in your items

Drag an earlier chat out of the Queries page onto a page. It becomes a `.chat` item there and is removed from the
Queries page. The item keeps the whole chat, including what the model read and how it reasoned, and opens as a
read-only page laid out like the chat window. Shift-drag a `.chat` item to make an ordinary page from it that you
can edit.

A chat can't be dragged while a response is running in it, and New Query can't be dragged.

## Continuing a kept chat

- **Continue** (the chat button in the toolbar of a `.chat` item, or of its page) opens a copy of it as the newest
  earlier chat. The `.chat` item stays where it is.
- Dragging a `.chat` item onto the Queries page moves it back: it becomes the newest earlier chat, and the `.chat`
  item goes to the trash.

Either way New Query stays at the top. A `.chat` item can't be changed in place: keeping a continued chat again
makes a second `.chat` item, and you delete the old one if you only want one.

## Copying part of a chat

Hover a turn in a chat, or on a `.chat` item's page, to show its handle, then shift-drag the handle onto a page. The
turn is copied there as editable items: your message, or the response with its text, tables and lists. The chat is
unchanged.

## Search

- `.chat` items are searchable by their conversation: your messages and the responses. What the model read and its
  reasoning are not searched.
- Chats in the Queries page are not found by search. Keep a chat to make it searchable.
- Attachments are not searched, in `.chat` items either, and the model's `search` tool doesn't see them. To make an
  attachment's text searchable, copy it out of the chat as a text item.
- The chat's own `search` tool never returns `.chat` items, so a model does not find its earlier answers, including
  wrong ones, and cite them as sources.

## Things to know

- **Chats in the Queries page are not backed up.** They are kept in the server's data directory, not in your items,
  so backups do not include them, and losing the data directory loses them. The crossed-out cloud next to a chat's
  settings is this reminder. Surviving a reload does not mean a chat
  is safe. Keep a chat to store it with your items: its content is then held in the object store like any other file.
- **Chats in the Queries page are not encrypted on disk.** Unlike your files in the object store, they are stored as
  plain text in the data directory. See [Security](security.md).
- **A scope limits what the model can find, not what is already in a chat.** Continuing a chat under a different
  [scope](scopes.md) keeps the earlier answers and everything the model read for them. A `.chat` item is searched
  according to where it is, not where the items it quotes are: an answer can repeat text from items outside the
  scope of a later search.
