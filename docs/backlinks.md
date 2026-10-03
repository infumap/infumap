# Backlinks

An item's backlinks are your links and notes that refer to it. Use them to find where you have
linked to something, or to check whether a page is an include or exclude root of a [scope](scopes.md).

## Seeing backlinks

Select an item and click the info button (ⓘ) in the toolbar. The popup shows **Linked from** and the
number of backlinks. Click it to list them. Each row shows where the link or note is, as the path of
pages and other containers above it. Clicking a row opens the page that holds the link or note, with
it selected.

The list is loaded each time you open the popup.

## What counts

- A link that points to the item.
- A note with an `infumap://<item id>` URL that points to the item, on the whole note or on part of
  its text. A note with several such URLs to the item counts once.

These do not count:

- Links and notes in the trash.
- Links and notes owned by other users, even when the item is public.
- The item's web address (`https://<server>/<item id>`), and `infumap://` URLs inside the content of
  text items.
- Links to the item from another Infumap server. Backlinks are only tracked within your server, and
  the info popup does not show them for items from other servers.
