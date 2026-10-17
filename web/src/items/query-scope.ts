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
import { QueryItem, getQueryRuntime } from "./query-item";
import { updateQueryConfiguration } from "./query-configuration-state";


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
