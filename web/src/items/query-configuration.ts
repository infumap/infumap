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

export interface QueryModelFavorite {
  backend: ChatBackendId,
  model: string | null,
}

export interface QueryProfileCollection {
  revision: number,
  /** All profiles in their user-selected order. */
  profiles: Array<QueryProfile>,
  preferences: {
    defaultProfileId: Uid,
    /** Ordered subset for one-click shortcuts. */
    pinnedProfileIds: Array<Uid>,
    modelFavorites: Array<QueryModelFavorite>,
  },
}

export type QueryProfileOperation =
  | { operation: "list" }
  | { operation: "create", name: string, configuration: QueryConfiguration }
  | { operation: "update", id: Uid, name: string, configuration: QueryConfiguration }
  | { operation: "duplicate", id: Uid, name: string }
  | { operation: "delete", id: Uid, replacementDefaultProfileId?: Uid }
  | { operation: "reorder", profileIds: Array<Uid> }
  | { operation: "setPinned", profileIds: Array<Uid> }
  | { operation: "setDefault", id: Uid }
  | { operation: "setModelFavorites", favorites: Array<QueryModelFavorite> };

export interface QueryProfilesResponse {
  userId: Uid,
  collection: QueryProfileCollection,
  conflict: boolean,
  /** A rejected mutation leaves the collection unchanged. */
  error: string | null,
  /** Created, updated or duplicated profile, when applicable. */
  profileId: Uid | null,
}

export function cloneQueryProfileCollection(collection: QueryProfileCollection): QueryProfileCollection {
  return {
    revision: collection.revision,
    profiles: collection.profiles.map(snapshotQueryProfile),
    preferences: {
      defaultProfileId: collection.preferences.defaultProfileId,
      pinnedProfileIds: [...collection.preferences.pinnedProfileIds],
      modelFavorites: collection.preferences.modelFavorites.map(favorite => ({ ...favorite })),
    },
  };
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
    capabilities: [...new Set(configuration.capabilities)],
  };
}

/** Captures the profile as applied; later renames and configuration edits cannot change this snapshot. */
export function snapshotQueryProfile(profile: QueryProfile): QueryProfile {
  return { id: profile.id, name: profile.name, configuration: cloneQueryConfiguration(profile.configuration) };
}

/** Capability order and duplicate entries cannot make an otherwise identical setup appear modified. */
export function queryConfigurationsEqual(left: QueryConfiguration, right: QueryConfiguration): boolean {
  if (left.scopeId != right.scopeId) { return false; }
  if (left.model == null || right.model == null) {
    if (left.model !== right.model) { return false; }
  } else if (left.model.backend != right.model.backend || left.model.model != right.model.model ||
    left.model.reasoningEffort != right.model.reasoningEffort) {
    return false;
  }
  const leftCapabilities = new Set(left.capabilities);
  const rightCapabilities = new Set(right.capabilities);
  return leftCapabilities.size == rightCapabilities.size &&
    [...leftCapabilities].every(capability => rightCapabilities.has(capability));
}
