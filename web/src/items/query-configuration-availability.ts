/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import type { ChatModelSelection, QueryConfiguration, ScopeRef } from "./query-configuration";
import { queryModelRouteLabel, queryProviderLabel } from "./query-configuration-labels";
import {
  queryCollectionsError, queryCollectionsLoading, queryScopeCollection, queryScopeEmptyText,
  queryScopeName, queryScopeUnavailableText, refreshQueryCollections,
} from "./query-scope";

export interface QueryConfigurationIssue {
  resource: "scope" | "model" | "tools",
  status: "unavailable" | "unverified" | "checking" | "warning",
  /** The resource in a few words, such as "Web search", for compact lists. */
  subject: string,
  message: string,
  /** Inactive resources are retained, but never prevent the current operation. */
  active: boolean,
}

type ResourceIssue = Omit<QueryConfigurationIssue, "active">;

/** Server reasons are fragments such as "Not configured on this server"; end them as a sentence. */
const sentence = (text: string) => /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

export function queryModelIssues(store: StoreContextModel, selection: ChatModelSelection | null): ResourceIssue[] {
  const issue = (status: ResourceIssue["status"], message: string): ResourceIssue[] =>
    [{ resource: "model", status, subject: selection == null ? "Model" : queryModelRouteLabel(store, selection), message }];
  if (selection == null) { return issue("unavailable", "Choose a model and provider for Chat."); }
  const catalog = store.general.chatBackends();
  if (catalog == null || store.general.chatBackendsError() != null) {
    if (catalog == null && store.general.chatBackendsRefreshing() && store.general.chatBackendsError() == null) {
      return issue("checking", `Checking availability of ${queryModelRouteLabel(store, selection)}…`);
    }
    return issue("unverified", `Could not verify ${queryModelRouteLabel(store, selection)}.`);
  }
  const provider = catalog.backends.find(backend => backend.id == selection.backend);
  if (provider == null || !provider.available) {
    return issue("unavailable", `Provider ${queryProviderLabel(store, selection.backend)} is unavailable. ${sentence(provider?.unavailableReason ?? "It is not configured on this server")} Choose another provider.`);
  }
  if (selection.model == null) { return issue("unavailable", `Choose an explicit model for ${provider.label}.`); }
  if (provider.modelsError != null) {
    return issue("unverified", `${provider.label}: ${provider.modelsError} The saved model and reasoning effort will be sent unchanged.`);
  }
  const model = provider.models.find(model => model.id == selection.model);
  if (model == null) { return issue("unavailable", `Model ${selection.model} is not in the ${provider.label} catalog. Choose another model.`); }
  if (selection.reasoningEffort != null && !model.reasoningEfforts.includes(selection.reasoningEffort)) {
    return issue("unavailable", `${model.name} does not support reasoning effort ${selection.reasoningEffort}. Choose Default or a supported effort.`);
  }
  return [];
}

function queryScopeIssues(scope: ScopeRef): ResourceIssue[] {
  if (scope.kind == "everything") { return []; }
  const unavailable = (): ResourceIssue[] =>
    [{ resource: "scope", status: "unavailable", subject: queryScopeName(scope), message: queryScopeUnavailableText(scope)! }];
  if (scope.kind == "unavailable") { return unavailable(); }
  const collection = queryScopeCollection(scope);
  if (collection === undefined || queryCollectionsError() != null) {
    const checking = queryCollectionsLoading() && queryCollectionsError() == null;
    return [{ resource: "scope", status: checking ? "checking" : "unverified", subject: "Scope",
      message: checking ? "Checking the saved collection's availability…" : "Could not verify the saved collection." }];
  }
  if (collection == null) { return unavailable(); }
  const empty = queryScopeEmptyText(scope);
  return empty == null ? [] : [{ resource: "scope", status: "warning", subject: queryScopeName(scope), message: empty }];
}

export const RETIRED_CHAT_SCOPE_MESSAGE = "This chat used an item limit. Choose a collection in Scope or turn off Infumap tools to continue.";

const FIXED_SCOPE_UNAVAILABLE = "This chat's collection no longer exists, and a chat's scope can't change. Start a new chat.";

/**
 * Reports availability without substituting a saved resource. In a chat whose setup its first message fixed
 * (`fixedSetup`), a missing tool source doesn't stop the chat: it keeps the tools it was given, and calls to that
 * source fail until it is back. A missing scope does, and can only be fixed by starting a new chat.
 */
export function queryConfigurationIssues(
  store: StoreContextModel,
  configuration: QueryConfiguration,
  mode: "search" | "chat",
  scopeItemIds: Array<Uid> = [],
  fixedSetup = false,
): QueryConfigurationIssue[] {
  const issues: QueryConfigurationIssue[] = [];
  const scopeActive = mode == "search" || (configuration.capabilities.includes("infumap_data") && scopeItemIds.length == 0);
  issues.push(...queryScopeIssues(configuration.scope).map(issue => ({
    ...issue,
    active: scopeActive,
    message: fixedSetup && issue.status == "unavailable" ? FIXED_SCOPE_UNAVAILABLE : issue.message,
  })));
  if (mode == "chat" && scopeItemIds.length > 0) {
    issues.push({ resource: "scope", status: "unavailable", active: configuration.capabilities.includes("infumap_data"),
      subject: "Previous item limit", message: RETIRED_CHAT_SCOPE_MESSAGE });
  }
  issues.push(...queryModelIssues(store, configuration.model).map(issue => ({ ...issue, active: mode == "chat" })));
  for (const id of new Set(configuration.capabilities)) {
    if (id == "infumap_data") { continue; }
    const catalog = store.general.chatBackends();
    const source = catalog?.toolServers?.find(server => server.id == id);
    const unverified = catalog == null || store.general.chatBackendsError() != null;
    if (unverified || source == null || !source.available) {
      const checking = catalog == null && store.general.chatBackendsRefreshing() && store.general.chatBackendsError() == null;
      const reason = sentence(source?.unavailableReason ?? "It is not configured on this server");
      issues.push({ resource: "tools", active: mode == "chat",
        status: checking ? "checking" : unverified ? "unverified" : fixedSetup ? "warning" : "unavailable",
        subject: id,
        message: checking ? `Checking availability of tool source ${id}…` : unverified ? `Could not verify tool source ${id}.`
          : fixedSetup ? `Tool source ${id} is unavailable. ${reason} Calls to it fail until it is back.`
          : `Tool source ${id} is unavailable. ${reason} Disable it or choose another profile.` });
    }
  }
  return issues;
}

export function queryConfigurationUnavailableReason(
  store: StoreContextModel, configuration: QueryConfiguration, mode: "search" | "chat", scopeItemIds: Array<Uid> = [],
  fixedSetup = false,
): string | null {
  const messages = queryConfigurationIssues(store, configuration, mode, scopeItemIds, fixedSetup).filter(issue => issue.active && issue.status == "unavailable").map(issue => issue.message);
  return messages.length == 0 ? null : messages.join("\n");
}

export async function refreshQueryConfigurationAvailability(store: StoreContextModel): Promise<void> {
  await Promise.all([refreshQueryCollections(store), store.general.refreshChatBackends()]);
}
