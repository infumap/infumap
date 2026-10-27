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
import { ListScopesResponse, ScopeItemDescription, ScopeProblem, ScopeSummary, server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid, isUid } from "../util/uid";
import { itemState } from "../store/ItemState";
import { itemIdFromInfumapUrl } from "../layout/navigation";
import { asLinkItem, isLink } from "./link-item";
import { asTitledItem, isTitledItem } from "./base/titled-item";
import { QueryItem, getQueryRuntime } from "./query-item";
import { updateQueryConfiguration, updateQueryScopeItemIds } from "./query-configuration-state";

/** The most items a chat can be limited to, as the server allows. */
export const MAX_QUERY_SCOPE_ITEMS = 32;


const [scopeList, setScopeList] = createSignal<ListScopesResponse | null>(null);
const [scopeListError, setScopeListError] = createSignal<string | null>(null);
const [scopeListLoading, setScopeListLoading] = createSignal(false);
let scopeListRequest: Promise<void> | null = null;
let scopeListGeneration = 0;
let scopeListAccountId: Uid | null = null;

export function clearQueryScopes(): void {
  scopeListGeneration++;
  scopeListRequest = null;
  scopeListAccountId = null;
  setScopeList(null);
  setScopeListError(null);
  setScopeListLoading(false);
}

export function queryScopesLoading(): boolean { return scopeListLoading(); }

/** The user's scopes as last fetched, or null before the first fetch completes. */
export function queryScopes(): ListScopesResponse | null {
  return scopeList();
}

export function queryScopesError(): string | null {
  return scopeListError();
}

/** Scopes are edited as ordinary items, so the list is fetched again whenever a picker opens. */
export function refreshQueryScopes(store: StoreContextModel): Promise<void> {
  const accountId = store.user.getUserMaybe()?.userId ?? null;
  if (scopeListAccountId != accountId) { clearQueryScopes(); scopeListAccountId = accountId; }
  if (accountId == null) { return Promise.resolve(); }
  if (scopeListRequest == null) {
    setScopeListLoading(true);
    const generation = scopeListGeneration;
    const isCurrent = () => generation == scopeListGeneration && accountId == (store.user.getUserMaybe()?.userId ?? null);
    scopeListRequest = server.listScopes()
      .then(response => {
        if (!isCurrent()) { return; }
        setScopeList(response);
        setScopeListError(null);
      })
      .catch(e => {
        if (!isCurrent()) { return; }
        console.error("Could not load scopes:", e);
        setScopeListError("Could not load scopes.");
      })
      .finally(() => { if (isCurrent()) { scopeListRequest = null; setScopeListLoading(false); } });
  }
  return scopeListRequest;
}

/** The explicit Infumap scope in this query's resource configuration. Null means everything. */
export function queryScopeId(store: StoreContextModel, queryItem: QueryItem): Uid | null {
  return getQueryRuntime(store, queryItem).configuration.scopeId;
}

export function setQueryScopeId(store: StoreContextModel, queryItem: QueryItem, scopeId: Uid | null): void {
  updateQueryConfiguration(store, queryItem, { scopeId });
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

/** The summary for a scope id: null for no scope or a scope that no longer exists, undefined while loading. */
export function queryScopeSummary(scopeId: Uid | null): ScopeSummary | null | undefined {
  if (scopeId == null) { return null; }
  const list = scopeList();
  if (list == null) { return undefined; }
  return list.scopes.find(scope => scope.id == scopeId) ?? null;
}

export function queryScopeName(scopeId: Uid | null): string {
  if (scopeId == null) { return "Everything"; }
  const summary = queryScopeSummary(scopeId);
  if (summary === undefined) { return "Scope"; }
  if (summary == null) { return "Missing scope"; }
  return summary.name.trim() == "" ? "Untitled scope" : summary.name;
}

/** What the scope covers, in a few words. */
export function queryScopeDescription(summary: ScopeSummary): string {
  const excluded = summary.excludeCount == 0 ? "" : ` · ${summary.excludeCount} excluded`;
  if (summary.includeCount == null) { return `Everything${excluded}`; }
  return `${summary.includeCount} included${excluded}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count == 1 ? "" : "s"}`;
}

/** The problems with a scope's definition, as one line, or null when there are none. */
export function queryScopeProblemText(problems: Array<ScopeProblem>): string | null {
  if (problems.some(problem => problem.kind == "noResolvedIncludes")) {
    return "No included link works, so this scope matches nothing";
  }
  const parts: Array<string> = [];
  const brokenIncludes = problems.filter(problem => problem.kind == "unresolvedLink" && !problem.exclude).length;
  const brokenExcludes = problems.filter(problem => problem.kind == "unresolvedLink" && problem.exclude).length;
  const ignored = problems.filter(problem => problem.kind == "ignoredContainer").length;
  if (brokenIncludes > 0) { parts.push(`${plural(brokenIncludes, "broken include link")}`); }
  if (brokenExcludes > 0) { parts.push(`${plural(brokenExcludes, "broken exclude link")}`); }
  if (ignored > 0) { parts.push(`${plural(ignored, "ignored container")}`); }
  if (problems.some(problem => problem.kind == "multipleExcludeContainers")) { parts.push("several Exclude containers"); }
  return parts.length == 0 ? null : parts.join(" · ");
}
