# Chats

Chats run in the **Queries** page. Each chat is kept as you go: reloading the page or closing the browser does not
lose it, and you can keep a chat in your item tree, continue it later, or copy parts of it into your pages.

## The current chat and earlier chats

The query item pinned at the top of the Queries page is the current chat. It is where you start a search or a chat.

- **New chat** (the + button next to the chat input) moves the current chat down into the list, as the newest
  earlier chat, and gives you a new current chat. A chat you never sent a message in is just cleared.
- **Earlier chats** are listed below the current one, newest first. Select one to read it, and send a message to
  continue it. Earlier chats are only for chatting: their search mode is not offered.
- A chat is named from the first words of its first message. When it becomes an earlier chat, it is given a short
  title describing it, unless you have renamed it.

A chat records every message you send and how each response ended. A response you stop, or that fails, is shown
with a note saying so, and is left out of what the model sees from then on.

If you send a message in a chat that changed elsewhere since you last loaded it, for example in another tab, the
chat is reloaded and your message is put back in the input for you to send again. Only one response runs in a chat
at a time.

## Deleting an earlier chat

Drag it to the trash. The current chat cannot be deleted; start a new chat first. A chat in the trash can be dragged
back to the Queries page. Emptying the trash deletes it for good.

## Keeping a chat in your items

Drag an earlier chat out of the Queries page onto a page. It becomes a `.chat` item there and is removed from the
Queries page. The item keeps the whole chat, including what the model read and how it reasoned, and opens as a
read-only page laid out like the chat window. Shift-drag a `.chat` item to make an ordinary page from it that you
can edit.

A chat can't be dragged while a response is running in it, and the current chat can't be dragged; start a new chat
first.

## Continuing a kept chat

- **Continue** (the chat button in the toolbar of a `.chat` item, or of its page) opens a copy of it as the current
  chat. The `.chat` item stays where it is.
- Dragging a `.chat` item onto the Queries page moves it back: it becomes the current chat, and the `.chat` item goes
  to the trash.

Either way the chat you had as current becomes an earlier chat, or is cleared if you never used it. A `.chat` item
can't be changed in place: keeping a continued chat again makes a second `.chat` item, and you delete the old one if
you only want one.

## Copying part of a chat

Hover a turn in a chat to show its handle, then shift-drag the handle onto a page. The turn is copied there as
editable items: your message, or the response with its text, tables and lists. The chat is unchanged.

## Search

- `.chat` items are searchable by their conversation: your messages and the responses. What the model read and its
  reasoning are not searched.
- Chats in the Queries page, current or earlier, are not found by search. Keep a chat to make it searchable.
- The chat's own `search` tool never returns `.chat` items, so a model does not find its earlier answers, including
  wrong ones, and cite them as sources.

## Things to know

- **Chats in the Queries page are not backed up.** They are kept in the server's data directory, not in your items,
  so backups do not include them, and losing the data directory loses them. Surviving a reload does not mean a chat
  is safe. Keep a chat to store it with your items: its content is then held in the object store like any other file.
- **Chats in the Queries page are not encrypted on disk.** Unlike your files in the object store, they are stored as
  plain text in the data directory. See [Security](security.md).
- **A scope limits what the model can find, not what is already in a chat.** Continuing a chat under a different
  [scope](scopes.md) keeps the earlier answers and everything the model read for them. A `.chat` item is searched
  according to where it is, not where the items it quotes are: an answer can repeat text from items outside the
  scope of a later search.
