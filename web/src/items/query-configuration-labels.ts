/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import type { StoreContextModel } from "../store/StoreProvider";
import type { ChatModelSelection, QueryConfiguration } from "./query-configuration";
import { queryScopeName } from "./query-scope";

/** Display order of reasoning efforts; unknown values sort last. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function reasoningEffortLabel(effort: string): string {
  return effort == "none" ? "Off" : effort == "xhigh" ? "X-High" : effort[0]?.toUpperCase() + effort.slice(1);
}

/** OpenRouter names models "Vendor: Model"; the vendor is noise in a compact label. */
export function shortModelName(name: string): string {
  return name.includes(": ") ? name.substring(name.indexOf(": ") + 2) : name;
}

/** The configured provider ID, also used as its display label. */
export function queryProviderLabel(store: StoreContextModel, backend: string): string {
  return store.general.chatBackends()?.backends.find(provider => provider.id == backend)?.label
    ?? backend;
}

/**
 * Backend ID and model display name, followed by its reasoning effort when one is set.
 */
export function queryModelLabel(store: StoreContextModel, selection: ChatModelSelection | null, short: boolean = false): string {
  if (selection == null) { return "No model"; }
  const effort = selection.reasoningEffort == null ? "" : ` · ${reasoningEffortLabel(selection.reasoningEffort)}`;
  if (selection.model == null) { return queryProviderLabel(store, selection.backend) + effort; }
  const provider = store.general.chatBackends()?.backends.find(provider => provider.id == selection.backend);
  const name = provider?.models.find(model => model.id == selection.model)?.name ?? selection.model;
  return `${selection.backend}: ${short ? shortModelName(name) : name}${effort}`;
}

/** The full backend and model label for tooltips and summaries. */
export function queryModelRouteLabel(store: StoreContextModel, selection: ChatModelSelection | null): string {
  return queryModelLabel(store, selection);
}

export function queryToolLabel(store: StoreContextModel, capability: string): string {
  return capability == "infumap_data" ? "Infumap"
    : store.general.chatBackends()?.toolServers?.find(server => server.id == capability)?.label ?? capability;
}

export function queryToolsLabel(store: StoreContextModel, capabilities: Array<string>): string {
  // Infumap first; configured sources in their stored order.
  const ordered = [...capabilities].sort((a, b) => Number(b == "infumap_data") - Number(a == "infumap_data"));
  return ordered.length == 0 ? "No tools" : ordered.map(capability => queryToolLabel(store, capability)).join(" + ");
}

/** "Everything · local: default · Infumap + Web search". Search uses only the scope. */
export function queryConfigurationSummary(store: StoreContextModel, configuration: QueryConfiguration): string {
  return [queryScopeName(configuration.scopeId), queryModelLabel(store, configuration.model, true),
    queryToolsLabel(store, configuration.capabilities)].join(" · ");
}
