/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY, server } from "../server";
import type { Uid } from "../util/uid";
import { ItemType } from "./base/item";
import { rememberQueryScopeItemTitle } from "./query-scope";

/** Fetch each time a profile is selected: the note can have been edited in another window. */
export async function readQueryProfileNote(id: Uid): Promise<string> {
  const response = await server.fetchItems(id, GET_ITEMS_MODE__ITEM_AND_ATTACHMENTS_ONLY);
  const item = response.item as { id?: string, itemType?: string, title?: string } | null;
  if (response.groupId != null || item?.id != id || item.itemType != ItemType.Note || typeof item.title != "string") {
    throw new Error("The query template must be a note.");
  }
  rememberQueryScopeItemTitle(id, item.title.split("\n")[0].trim() || "Untitled note");
  return item.title;
}
