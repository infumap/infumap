/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import type { StoreContextModel } from "../store/StoreProvider";
import type { Uid } from "../util/uid";
import type { ChatModelSelection, QueryConfiguration } from "./query-configuration";
import { queryModelRouteLabel, queryProviderLabel } from "./query-configuration-labels";
import { queryScopeName, queryScopeProblemText, queryScopeSummary, queryScopesError, queryScopesLoading, refreshQueryScopes } from "./query-scope";

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

/**
 * Reports facts from discovery without substituting or deleting any saved resource. In a chat, items chosen as its
 * scope replace the selected scope, so that scope's issues are inactive while there are any. Search ignores them.
 */
export function queryConfigurationIssues(
  store: StoreContextModel,
  configuration: QueryConfiguration,
  mode: "search" | "chat",
  scopeItemIds: Array<Uid> = [],
): QueryConfigurationIssue[] {
  const issues: QueryConfigurationIssue[] = [];
  const scopeActive = mode == "search" || (configuration.capabilities.includes("infumap_data") && scopeItemIds.length == 0);
  if (configuration.scopeId != null) {
    const summary = queryScopeSummary(configuration.scopeId);
    if (summary === undefined || queryScopesError() != null) {
      const checking = queryScopesLoading() && queryScopesError() == null;
      issues.push({ resource: "scope", status: checking ? "checking" : "unverified", active: scopeActive, subject: "Scope",
        message: checking ? "Checking the saved scope's availability…" : "Could not verify the saved scope." });
    } else if (summary == null) {
      issues.push({ resource: "scope", status: "unavailable", active: scopeActive, subject: "Scope",
        message: `Scope ${configuration.scopeId} no longer exists or is not accessible. Choose another scope.` });
    } else {
      const problem = queryScopeProblemText(summary.problems);
      if (problem != null) { issues.push({ resource: "scope", status: "warning", active: scopeActive, subject: queryScopeName(configuration.scopeId), message: `${queryScopeName(configuration.scopeId)}: ${problem}.` }); }
    }
  }
  issues.push(...queryModelIssues(store, configuration.model).map(issue => ({ ...issue, active: mode == "chat" })));
  for (const id of new Set(configuration.capabilities)) {
    if (id == "infumap_data") { continue; }
    const catalog = store.general.chatBackends();
    const source = catalog?.toolServers?.find(server => server.id == id);
    const unverified = catalog == null || store.general.chatBackendsError() != null;
    if (unverified || source == null || !source.available) {
      const checking = catalog == null && store.general.chatBackendsRefreshing() && store.general.chatBackendsError() == null;
      issues.push({ resource: "tools", active: mode == "chat", status: checking ? "checking" : unverified ? "unverified" : "unavailable",
        subject: id,
        message: checking ? `Checking availability of tool source ${id}…` : unverified ? `Could not verify tool source ${id}.`
          : `Tool source ${id} is unavailable. ${sentence(source?.unavailableReason ?? "It is not configured on this server")} Disable it or choose another profile.` });
    }
  }
  return issues;
}

export function queryConfigurationUnavailableReason(
  store: StoreContextModel, configuration: QueryConfiguration, mode: "search" | "chat", scopeItemIds: Array<Uid> = [],
): string | null {
  const messages = queryConfigurationIssues(store, configuration, mode, scopeItemIds).filter(issue => issue.active && issue.status == "unavailable").map(issue => issue.message);
  return messages.length == 0 ? null : messages.join("\n");
}

export async function refreshQueryConfigurationAvailability(store: StoreContextModel): Promise<void> {
  await Promise.all([refreshQueryScopes(store), store.general.refreshChatBackends()]);
}
