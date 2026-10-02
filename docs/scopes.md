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
- Changes take effect on the next search or chat message. There is nothing to save.

## Choosing a scope

The scope button sits next to the query input, on the search results border, and next to the chat
setup button. Its list shows each scope's coverage and any problems with its definition, such as a
link to a deleted item or a container that is not named Exclude. **Edit scopes** opens the Scopes page.

Your choice is remembered in this browser and used for new queries. Once a search or chat has used a scope, that
query keeps it until you change it there.

In a chat, changing the scope applies from the next message. Earlier answers keep what they found.
Items you add to a chat's context yourself are always sent, whatever the scope.

If the chosen scope is deleted, the button shows **Missing scope** and searches and chats fail until
you choose another. They never fall back to searching everything.

## What a scope does not do

A scope limits what search and the chat tools return. It is not a permission: you can still open and
browse every item, and result previews show a page's contents as usual. Titles of the pages that
contain an included item may appear in search result paths.
