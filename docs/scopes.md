# Scopes

A scope limits which of your items search, chat and deep research can see. For example, you can
keep a journal out of chat, or search only a project's pages.

## Defining a scope

Scopes live in the **Scopes** page, at the bottom of the Queries page. It is created automatically
and cannot be moved or deleted, but it can be renamed.

Each page directly inside Scopes is one scope, and its title is the scope's name. Inside a scope page:

- **Links** are include roots. The scope covers each linked item and everything inside it.
- A page (or table or composite) titled **Exclude**, in any letter case, holds exclude roots. Each
  link inside it removes the linked item and everything inside it from the scope.
- Anything else, such as a note describing the scope, is ignored.

```
Scopes
├── Work
│   ├── → Projects        included
│   ├── → Clients         included
│   └── Exclude
│       └── → Clients/Old excluded
└── No journal
    └── Exclude           (no include links, so everything else is included)
        └── → Journal
```

The rules:

- "Everything inside" means children and attachments, at any depth. Links inside an included item
  are not followed: the item a link points to is only in scope if it is in scope itself.
- Exclusion always wins. An include root inside an excluded item is excluded.
- A scope with no include links covers everything under your home page, minus its exclusions.
- A scope whose include links all point to deleted or inaccessible items covers nothing, not everything.
- A link must point at an item, not at another link. A scope link that points to a link is reported as a
  problem and includes or excludes nothing.
- Changes take effect on the next search or chat message. There is nothing to save.

To check whether a page is an include or exclude root, open its info popup: its
[backlinks](backlinks.md) list the scope links that point to it, under a path such as
`… / Scopes / Work / Exclude`. A page inside a root has no backlink of its own, so check the pages
above it too.

## Choosing a scope

The **Scope** control sits next to the query input, on the search results border, and beside the
independent **Model** and **Tools** controls in chat. Its list shows each scope's coverage and problems
with its definition, such as a link to a deleted item or a container that is not named Exclude. **Edit scopes** opens the Scopes page.

New queries copy the scope from the default query profile. Changing the scope affects only that query;
it does not change the default profile or other queries.

In a chat, changing the scope applies from the next message. Earlier answers keep what they found.
Items you add to a chat's context yourself are always sent, whatever the scope.

When Infumap tools are off, the control displays **Scope: Not used** and retains its saved selection.
Turn Infumap on again to use that scope. Search always uses scope, regardless of chat tool choices.
The scope popup is labelled **Search within Infumap**: it does not constrain web tools or existing chat context.

If the chosen scope is deleted, the button shows **Missing scope** and searches and chats fail until
you choose another. They never fall back to searching everything.

## What a scope does not do

A scope limits what search and the chat tools return. It is not a permission: you can still open and
browse every item, and result previews show a page's contents as usual. Titles of the pages that
contain an included item may appear in search result paths.

A scope limits what a chat can find, not what is already in it. A chat continued under a different scope keeps its
earlier answers and everything the model read for them, whatever their scope. A [chat kept as a `.chat` item](chats.md)
is searched according to where the item is, not where the items its answers quote are, so its text can repeat content
from outside the scope of a later search.
