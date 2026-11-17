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

import { createSignal } from "solid-js";
import { CollectionSummary, ListCollectionsResponse, ScopeItemDescription, server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid, isUid } from "../util/uid";
import { itemState } from "../store/ItemState";
import { itemIdFromInfumapUrl } from "../layout/navigation";
import { asLinkItem, isLink } from "./link-item";
import { asTitledItem, isTitledItem } from "./base/titled-item";
import { QueryItem, getQueryRuntime } from "./query-item";
import { updateQueryConfiguration, updateQueryScopeItemIds } from "./query-configuration-state";
import { ScopeRef, scopeRefCollectionId } from "./query-configuration";

/** The most items a chat can be limited to, as the server allows. */
export const MAX_QUERY_SCOPE_ITEMS = 32;


const [collectionList, setCollectionList] = createSignal<ListCollectionsResponse | null>(null);
const [collectionListError, setCollectionListError] = createSignal<string | null>(null);
const [collectionListLoading, setCollectionListLoading] = createSignal(false);
let collectionListRequest: Promise<void> | null = null;
let collectionListGeneration = 0;
let collectionListAccountId: Uid | null = null;

export function clearQueryCollections(): void {
  collectionListGeneration++;
  collectionListRequest = null;
  collectionListAccountId = null;
  setCollectionList(null);
  setCollectionListError(null);
  setCollectionListLoading(false);
}

export function queryCollectionsLoading(): boolean { return collectionListLoading(); }

/** The user's collections as last fetched, by title then path, or null before the first fetch completes. */
export function queryCollections(): Array<CollectionSummary> | null {
  return collectionList()?.collections ?? null;
}

export function queryCollectionsError(): string | null {
  return collectionListError();
}

/** Collections near the current page, nearest first, as of the last fetch. */
export function queryHereCollections(): Array<CollectionSummary> {
  return (queryCollections() ?? [])
    .filter(collection => collection.hereDepth != null)
    .sort((a, b) => b.hereDepth! - a.hereDepth!);
}

/**
 * The page collections are ranked against for Here: the page being viewed, or, from the Queries page, the page the
 * user came from. Search and chat open on the Queries page, so ranking against it would put nothing under Here.
 */
function collectionRankingPageId(store: StoreContextModel): Uid | null {
  const current = store.history.currentPageVeid()?.itemId ?? null;
  if (current == null || current != store.user.getUserMaybe()?.queriesPageId) { return current; }
  return store.history.peekPrevPageVeid()?.itemId ?? null;
}

/**
 * Collections are made and edited as ordinary pages, and the Here ranking depends on where the user is, so the list
 * is fetched again whenever a picker opens.
 */
export function refreshQueryCollections(store: StoreContextModel): Promise<void> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  if (collectionListAccountId != accountId) { clearQueryCollections(); collectionListAccountId = accountId; }
  if (accountId == null) { return Promise.resolve(); }
  if (collectionListRequest == null) {
    setCollectionListLoading(true);
    const generation = collectionListGeneration;
    const isCurrent = () => generation == collectionListGeneration && accountId == (store.user.getUserMaybe()?.userId ?? null);
    collectionListRequest = server.listCollections(collectionRankingPageId(store))
      .then(response => {
        if (!isCurrent()) { return; }
        setCollectionList(response);
        setCollectionListError(null);
      })
      .catch(e => {
        if (!isCurrent()) { return; }
        console.error("Could not load collections:", e);
        setCollectionListError("Could not load collections.");
      })
      .finally(() => { if (isCurrent()) { collectionListRequest = null; setCollectionListLoading(false); } });
  }
  return collectionListRequest;
}

/** The Infumap scope in this query's resource configuration. */
export function queryScope(store: StoreContextModel, queryItem: QueryItem): ScopeRef {
  return getQueryRuntime(store, queryItem).configuration.scope;
}

export function setQueryScope(store: StoreContextModel, queryItem: QueryItem, scope: ScopeRef): void {
  updateQueryConfiguration(store, queryItem, { scope });
}

/** Items chosen in the chat as its scope. While there are any, they are used in place of the scope. */
export function queryScopeItemIds(store: StoreContextModel, queryItem: QueryItem): Array<Uid> {
  return getQueryRuntime(store, queryItem).scopeItemIds;
}

/** Adds an item to the end. Returns why it was not added, or null. Adding one already there changes nothing. */
export function addQueryScopeItem(store: StoreContextModel, queryItem: QueryItem, itemId: Uid): string | null {
  const current = queryScopeItemIds(store, queryItem);
  if (current.includes(itemId)) { return null; }
  if (current.length >= MAX_QUERY_SCOPE_ITEMS) { return `At most ${MAX_QUERY_SCOPE_ITEMS} items can be in scope.`; }
  updateQueryScopeItemIds(store, queryItem, [...current, itemId]);
  return null;
}

export function removeQueryScopeItem(store: StoreContextModel, queryItem: QueryItem, itemId: Uid): void {
  updateQueryScopeItemIds(store, queryItem, queryScopeItemIds(store, queryItem).filter(id => id != itemId));
}

/** Removing the items restores the selected scope. */
export function clearQueryScopeItems(store: StoreContextModel, queryItem: QueryItem): void {
  updateQueryScopeItemIds(store, queryItem, []);
}

// Titles of items picked from search candidates, shown until the server describes them.
const [scopeItemTitles, setScopeItemTitles] = createSignal<ReadonlyMap<Uid, string>>(new Map());
// The server's descriptions of items chosen as scopes, for every query. Items are edited elsewhere, so these are
// fetched again whenever a scope picker opens.
const [scopeItemDescriptions, setScopeItemDescriptions] = createSignal<ReadonlyMap<Uid, ScopeItemDescription>>(new Map());
const scopeItemDescriptionRequests = new Set<Uid>();

export function rememberQueryScopeItemTitle(itemId: Uid, title: string): void {
  setScopeItemTitles(new Map(scopeItemTitles()).set(itemId, title));
}

/**
 * Fetches descriptions of the items, or of those not yet described unless `refresh`. A failure leaves the titles
 * known here, and is shown in the network status.
 */
export async function describeQueryScopeItems(itemIds: Array<Uid>, refresh: boolean = false): Promise<void> {
  const wanted = itemIds.filter(id => !scopeItemDescriptionRequests.has(id) && (refresh || !scopeItemDescriptions().has(id)));
  if (wanted.length == 0) { return; }
  wanted.forEach(id => scopeItemDescriptionRequests.add(id));
  try {
    const response = await server.describeScopeItems(wanted);
    const descriptions = new Map(scopeItemDescriptions());
    response.items.forEach(item => descriptions.set(item.id, item));
    setScopeItemDescriptions(descriptions);
  } catch (e) {
    console.error("Could not describe scope items:", e);
  } finally {
    wanted.forEach(id => scopeItemDescriptionRequests.delete(id));
  }
}

/** False once the server reports the item would be left out of the scope; true while that is not known. */
export function queryScopeItemResolved(itemId: Uid): boolean {
  return scopeItemDescriptions().get(itemId)?.resolved ?? true;
}

/** A link shows its target's title. An item whose title is not known here shows the start of its id. */
export function queryScopeItemTitle(itemId: Uid): string {
  const description = scopeItemDescriptions().get(itemId);
  if (description != null) {
    if (!description.resolved) { return "Missing item"; }
    return description.title ?? `untitled ${description.itemType}`;
  }
  const remembered = scopeItemTitles().get(itemId);
  if (remembered != null) { return remembered; }
  let item = itemState.get(itemId);
  if (item != null && isLink(item)) { item = itemState.get(asLinkItem(item).linkTo); }
  const title = item != null && isTitledItem(item) ? asTitledItem(item).title.trim() : "";
  return title != "" ? title : `Item ${itemId.slice(0, 8)}…`;
}

/** "3 items", for labels. */
export function queryScopeItemsLabel(count: number): string {
  return `${count} item${count == 1 ? "" : "s"}`;
}

/** An id, an infumap:// link, or a URL of an item on this host, as pasted or typed. */
export function parseQueryScopeItemInput(text: string): { itemId: Uid } | { error: string } {
  const trimmed = text.trim();
  if (isUid(trimmed)) { return { itemId: trimmed }; }
  const linked = itemIdFromInfumapUrl(trimmed);
  if (linked != null) { return { itemId: linked }; }
  try {
    const url = new URL(trimmed);
    const id = url.pathname.replace(/^\/+|\/+$/g, "");
    if ((url.protocol == "http:" || url.protocol == "https:") && isUid(id)) {
      return url.host == window.location.host ? { itemId: id } : { error: "Items on another Infumap host cannot be in scope." };
    }
  } catch (_e) { }
  return { error: "Choose an item from the list, or paste an item link or id." };
}

/**
 * The collection a reference names, as last fetched: null for none or one that is no longer available, undefined
 * while not yet known.
 */
export function queryScopeCollection(scope: ScopeRef): CollectionSummary | null | undefined {
  const id = scopeRefCollectionId(scope);
  if (id == null) { return null; }
  const list = queryCollections();
  if (list == null) { return undefined; }
  return list.find(collection => collection.id == id) ?? null;
}

/** Whether the reference names something that cannot be used now. Unknown while the list is loading or failed. */
export function queryScopeUnavailable(scope: ScopeRef): boolean {
  if (scope.kind == "unavailable") { return true; }
  if (scope.kind == "everything") { return false; }
  return queryScopeCollection(scope) === null && queryCollectionsError() == null;
}

export function queryCollectionTitle(collection: CollectionSummary): string {
  return collection.title.trim() == "" ? "Untitled collection" : collection.title.split("\n")[0].trim();
}

/** A collection that is no longer listed: its title, if its page is loaded here (trashed or unflagged), else null. */
function unlistedCollectionTitle(id: Uid): string | null {
  const item = itemState.get(id);
  const title = item != null && isTitledItem(item) ? asTitledItem(item).title.split("\n")[0].trim() : "";
  return title == "" ? null : title;
}

/**
 * The scope in full, so that an exclusion is never mistaken for an inclusion: "Everything", "Key sources",
 * "Everything except Private", "Key sources (unavailable)".
 */
export function queryScopeName(scope: ScopeRef): string {
  if (scope.kind == "everything") { return "Everything"; }
  if (scope.kind == "unavailable") { return "Old scope (unavailable)"; }
  const collection = queryScopeCollection(scope);
  if (collection === undefined) { return queryCollectionsError() == null ? "Loading…" : "Unverified collection"; }
  const name = collection == null
    ? `${unlistedCollectionTitle(scope.id) ?? "Collection"} (unavailable)`
    : queryCollectionTitle(collection);
  return scope.kind == "everythingExcept" ? `Everything except ${name}` : name;
}

/** Why the reference covers nothing, as a sentence, or null when it does not. */
export function queryScopeUnavailableText(scope: ScopeRef): string | null {
  if (scope.kind == "unavailable") {
    return "Scope pages are no longer used. Choose a collection or Everything.";
  }
  if (!queryScopeUnavailable(scope)) { return null; }
  return "This collection no longer exists, is in the trash or is no longer a collection. Choose another scope.";
}

/** A collection with no members limits search to nothing; excluding it hides nothing, which needs no warning. */
export function queryScopeEmptyText(scope: ScopeRef): string | null {
  if (scope.kind != "collection") { return null; }
  const collection = queryScopeCollection(scope);
  return collection != null && collection.memberCount == 0
    ? `${queryCollectionTitle(collection)} has no members, so nothing can be found. Link items into its page to add them.`
    : null;
}

/** "Research / Northstar · 8 members". */
export function queryCollectionDescription(collection: CollectionSummary): string {
  const members = `${collection.memberCount} member${collection.memberCount == 1 ? "" : "s"}`;
  return collection.path.length == 0 ? members : `${collection.path.join(" / ")} · ${members}`;
}
