# Scopes

A scope limits which of your items search, chat and deep research can see. For example, you can
keep a journal out of chat, or search only a project's key sources. A scope is **Everything**, a
[collection](#collections), or everything except a collection.

## Collections

A collection is a page that names a set of items without moving or copying them. Make one with
**Make collection** in a page's **…** (More actions) menu, and turn it back into an ordinary page with
**Make ordinary page**. A collection shows a collection icon by its title.

- **Links** directly inside the collection page are its members. Each member covers the linked item and
  everything inside it. Linking the same item twice adds it once.
- Anything else in the page, such as a note saying what the collection is for or a subpage, is not a
  member, and neither is anything inside it.
- A collection with no members covers nothing.

To add an item, put a link to it in the collection page. To remove one, delete its link. Deleting a link, or the collection, never deletes the item it
points to.

```
Research
└── Northstar
    ├── Financials
    ├── Interviews
    └── Collections
        └── Key sources        (a collection)
            ├── → Financials   member
            ├── → Industry report (elsewhere)  member
            └── Why these      a note, not a member
```

A collection can live anywhere, and its members can be anywhere. Moving or renaming it, or moving its
members, does not change what it covers.

The rules:

- "Everything inside" means children and attachments, at any depth. Links inside a member are not
  followed: the item a link points to is only covered if it is covered itself.
- A link must point at an item, not at another link. A link to a deleted item covers nothing until you
  remove it.
- A member that is itself a collection page covers that page and what is in it, not that collection's
  members.
- Changes take effect on the next search or chat message. There is nothing to save.

## Curating a collection

To add items to a collection from wherever they are, click the collections button in the toolbar, left of the
user button, and choose a collection. It lists collections near the page you are on under **Here**, and every
collection under **All collections**. You stay where you are, in collection mode: the collections button shows the
name of the collection being curated, inside a green border. Hover over it to see how many members the collection
has. Click it to leave collection mode.

In collection mode, items show how the collection covers them:

- A **green** item is a member, wherever it appears, including links to it.
- A **light green** item is covered because a member above it covers it. Inside a member that is itself shown green,
  the items it covers aren't tinted again.

In collection mode, the gestures that select items change membership instead. Plain clicks still open and edit items.

- **Cmd-click** (Ctrl-click on Windows and Linux) an item to make it a member, or to stop it being one. A link adds
  the item it points to. Clicking an item covered through a member above it makes it a member itself, so it stays
  covered if that member is removed. In a composite, Cmd-click adds or removes the part you click. Attachments,
  such as the cells in a table's second and later columns, can be added or removed this way too.
- **Shift-click** in a list, table or composite does what your last Cmd-click did, adding or removing, to every item
  from that one to the one you click. On a free-form or calendar page it adds or removes the one item.
- **Drag a rectangle** over items to add them all. If they are all members already, it removes them all instead, so
  dragging over the same items again undoes it. A rectangle over a composite adds or removes the whole composite.

To add the page you are on, go up to the page that holds it and Cmd-click it there.

Removing an item covered through a member above it leaves it covered, and a message says which member covers it. To
leave out part of a member, remove the member and add the parts you want.

Each change is saved straight away, and the colour changes as you click. To reverse a change, click or drag over
the same items again. If an item can't be added, or a change can't be saved, a message under the toolbar says so, and
the colour goes back; click again to retry. Click the collections button, or press Escape when nothing is selected
and no popup is open, to leave collection mode. Right-click goes back as usual and leaves you in collection mode.
Reloading the page leaves it too. If the collection is deleted while you curate it, the button's border turns
amber. To select items for something else, such as moving them, leave collection mode first.

## Choosing a scope

The **Scope** control sits below the query input, on the search results border, and beside the
independent **Model** and **Tools** controls in chat. It lists **Everything**, then your collections:
under **Here**, those nearest the page you were on before opening search, nearest first, and under
**All collections**, every collection by name with the pages above it. Choose a collection to search
only what it covers, or click **Except** beside it to search everything except what it covers. The
control's label states the choice in full, such as **Key sources** or **Everything except Private**.
Exclusion wins: an item a collection covers stays hidden even if it is also linked from somewhere else.

Search remembers the last scope you chose for it, separately for each account in each browser. Until you choose
one, search covers everything. Chats instead copy the scope from the default [query profile](chats.md#query-profiles).
Changing a chat's scope affects only that chat; it does not change the default profile or other queries. On New Query,
switching between Search and Chat switches the scope shown.

In a chat, changing the scope applies from the next message. Earlier answers keep what they found.
Items you add to a chat's context yourself are always sent, whatever the scope. Choosing a collection
does not send its contents to the model; it only limits what the model can find.

When Infumap tools are off, the control displays **Scope: Not used** and retains its saved selection.
Turn Infumap on again to use that scope. Search always uses scope, regardless of chat tool choices.
The scope popup is labelled **Search within Infumap**: it does not constrain web tools or existing chat context.

If a chosen collection is deleted, moved to the trash or made an ordinary page, the control shows it
as unavailable, such as **Key sources (unavailable)**, and it covers nothing. It never falls back to
searching everything. Search finds nothing, and a chat using Infumap tools cannot send until you choose
another scope. Restoring the page from the trash, or making it a collection again, makes it work again.
A failed request for the list of collections is labelled **Unverified**, rather than treated as evidence
that the collection is gone.

### Scopes from earlier versions

Earlier versions defined scopes as pages in a **Scopes** page. Those definitions are no longer used: a
profile, chat or search that used one shows **Old scope (unavailable)** until you choose again. The pages
themselves are kept: the **Scopes** page is now an ordinary page listed in the Queries page, which you can
move or delete. A scope page whose links were all includes can become a collection with **Make
collection**, since its links are already the members. Its **Exclude** page is not a member and is
ignored. For an exclusion, make a separate collection of what to hide and choose **Except** beside it.

### Chats with item limits from earlier versions

If an earlier chat used **Search limited to** with individual items, open **Scope** to see its previous items and
choose a collection before sending with Infumap tools enabled. You can also continue with Infumap tools off and
choose a collection later. Previously attached content stays in the conversation. To include a specific item in a new
message, paste its ID or link into the chat input. See [Attaching text](chats.md#attaching-text).

## What a scope does not do

A scope limits what search and the chat tools return. It is not a permission: you can still open and
browse every item, and result previews show a page's contents as usual. Titles of the pages that
contain an included item may appear in search result paths.

A scope limits what a chat can find, not what is already in it. A chat continued under a different scope keeps its
earlier answers and everything the model read for them, whatever their scope. A [chat kept as a `.chat` item](chats.md)
is searched according to where the item is, not where the items its answers quote are, so its text can repeat content
from outside the scope of a later search.
