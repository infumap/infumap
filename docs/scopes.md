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

## Limiting a chat to chosen items

A chat or deep research can be limited to particular items without defining a scope. With Infumap tools on, click **+**
beside the **Scope** control, then search titles or paste an item's link or id. The items are shown above the input,
after **Search limited to**. Up to 32 can be chosen, from this Infumap host only. Profiles don't save them.

Chosen items are used in place of the selected scope, which applies again once they are removed: with × on each, or
**Clear** in the scope picker. Search and reading are limited to each item and everything inside it. Choosing a link
means choosing the item it points to. A chosen item that no longer exists is left out, and if none remain the chat
can't send until you change them.

The model is also given each chosen item's content, with the message of the first turn in which the item is in scope:

- A note is its whole text, and a file or image is the whole of the text extracted from it.
- A page or table is its listing, plus the whole text of each note the listing cuts short and each file or image in it.
  Pages and tables inside it are listed but not read. The model can read those with its tools.
- An item with more than 1 MB of this content isn't included. The model is told to read it with its tools instead.

This content stays in what the model sees for the rest of the chat, so large items use up context in every later turn.
A later edit to an item isn't seen unless the model reads it again.

## What a scope does not do

A scope limits what search and the chat tools return. It is not a permission: you can still open and
browse every item, and result previews show a page's contents as usual. Titles of the pages that
contain an included item may appear in search result paths.

A scope limits what a chat can find, not what is already in it. A chat continued under a different scope keeps its
earlier answers and everything the model read for them, whatever their scope. A [chat kept as a `.chat` item](chats.md)
is searched according to where the item is, not where the items its answers quote are, so its text can repeat content
from outside the scope of a later search.
