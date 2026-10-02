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
import { ListScopesResponse, ScopeProblem, ScopeSummary, server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";
import { QueryItem, getQueryRuntime, updateQueryRuntime } from "./query-item";


const [scopeList, setScopeList] = createSignal<ListScopesResponse | null>(null);
const [scopeListError, setScopeListError] = createSignal<string | null>(null);
let scopeListRequest: Promise<void> | null = null;

/** The user's scopes as last fetched, or null before the first fetch completes. */
export function queryScopes(): ListScopesResponse | null {
  return scopeList();
}

export function queryScopesError(): string | null {
  return scopeListError();
}

/** Scopes are edited as ordinary items, so the list is fetched again whenever a picker opens. */
export function refreshQueryScopes(store: StoreContextModel): Promise<void> {
  if (scopeListRequest == null) {
    scopeListRequest = server.listScopes(store.general.networkStatus)
      .then(response => {
        setScopeList(response);
        setScopeListError(null);
      })
      .catch(e => {
        console.error("Could not load scopes:", e);
        setScopeListError("Could not load scopes.");
      })
      .finally(() => { scopeListRequest = null; });
  }
  return scopeListRequest;
}

/** The scope this query uses: its own choice, else the scope last chosen anywhere. Null means no scope. */
export function queryScopeId(store: StoreContextModel, queryItem: QueryItem): Uid | null {
  const scope = getQueryRuntime(store, queryItem).scope;
  return scope != null ? scope.id : store.general.queryScopeId();
}

export function setQueryScopeId(store: StoreContextModel, queryItem: QueryItem, scopeId: Uid | null): void {
  updateQueryRuntime(store, queryItem, current => ({ ...current, scope: { id: scopeId } }));
  store.general.setQueryScopeId(scopeId);
}

/**
 * The scope to send with a search or chat request. It is pinned to the query on first use, so choosing a
 * scope in another query later cannot change the scope of a search or chat that is already under way.
 */
export function queryScopeIdForRequest(store: StoreContextModel, queryItem: QueryItem): Uid | null {
  const scopeId = queryScopeId(store, queryItem);
  if (getQueryRuntime(store, queryItem).scope == null) {
    updateQueryRuntime(store, queryItem, current => ({ ...current, scope: { id: scopeId } }));
  }
  return scopeId;
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
