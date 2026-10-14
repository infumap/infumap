/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import type { Uid } from "../util/uid";

/** "openrouter", or "llama:<name>" for a configured llama server. */
export type ChatBackendId = string;

/** An explicit provider route. Null model means the provider selects the model; null effort uses its default. */
export interface ChatModelSelection {
  backend: ChatBackendId,
  model: string | null,
  reasoningEffort: string | null,
}

/** Resources used by a query. Execution mode is separate from this configuration. */
export interface QueryConfiguration {
  /** Null covers everything in Infumap. This limits retrieval, not attachments or existing chat context. */
  scopeId: Uid | null,
  /** Null means no model has been selected, for example before the catalog loads or in Search. */
  model: ChatModelSelection | null,
  /** Capability IDs: "infumap_data" and configured MCP server IDs. Order has no meaning. */
  capabilities: Array<string>,
}

/** A named setup. Pinning, ordering and the default profile are separate user preferences. */
export interface QueryProfile {
  id: Uid,
  name: string,
  configuration: QueryConfiguration,
}

export type ChatRunMode = "chat" | "deep_research";

/** Per-turn settings. Resource configuration and profile provenance are independent of execution mode. */
export interface QueryChatSettings {
  configuration: QueryConfiguration,
  appliedProfile: QueryProfile | null,
  mode: ChatRunMode,
}

/** A value copy, so conversation settings never share mutable objects with a saved profile. */
export function cloneQueryConfiguration(configuration: QueryConfiguration): QueryConfiguration {
  return {
    scopeId: configuration.scopeId,
    model: configuration.model == null ? null : { ...configuration.model },
    capabilities: [...configuration.capabilities],
  };
}

/** Captures the profile as applied; later renames and configuration edits cannot change this snapshot. */
export function snapshotQueryProfile(profile: QueryProfile): QueryProfile {
  return { id: profile.id, name: profile.name, configuration: cloneQueryConfiguration(profile.configuration) };
}
