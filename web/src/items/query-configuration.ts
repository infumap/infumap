/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import type { Uid } from "../util/uid";

/** Stable ID of a configured chat_providers entry. */
export type ChatBackendId = string;

export type ToolApproval = "automatic" | "always_ask";

/** An explicit provider and model. Chat requires a model ID; null effort uses its default. */
export interface ChatModelSelection {
  backend: ChatBackendId,
  model: string | null,
  reasoningEffort: string | null,
}

/**
 * What Infumap retrieval covers. The inversion belongs to the reference, not the collection, so the same collection
 * can limit one query and be hidden from another. `unavailable` is what a scope page id saved before collections
 * became: it covers nothing until another scope is chosen.
 */
export type ScopeRef =
  | { kind: "everything" }
  | { kind: "collection", id: Uid }
  | { kind: "everythingExcept", id: Uid }
  | { kind: "unavailable" };

export const EVERYTHING_SCOPE: ScopeRef = { kind: "everything" };

/** The collection a reference names, if any. */
export function scopeRefCollectionId(scope: ScopeRef): Uid | null {
  return scope.kind == "collection" || scope.kind == "everythingExcept" ? scope.id : null;
}

export function scopeRefsEqual(left: ScopeRef, right: ScopeRef): boolean {
  return left.kind == right.kind && scopeRefCollectionId(left) == scopeRefCollectionId(right);
}

/** A value read from storage the server never checked. Anything unrecognised is unavailable, never everything. */
export function parseScopeRef(value: unknown): ScopeRef {
  if (value != null && typeof value == "object") {
    const raw = value as { kind?: unknown, id?: unknown };
    if (raw.kind == "everything") { return EVERYTHING_SCOPE; }
    if (raw.kind == "collection" && typeof raw.id == "string") { return { kind: "collection", id: raw.id }; }
    if (raw.kind == "everythingExcept" && typeof raw.id == "string") { return { kind: "everythingExcept", id: raw.id }; }
  }
  return { kind: "unavailable" };
}

/** Resources used by a query. Execution mode is separate from this configuration. */
export interface QueryConfiguration {
  /** This limits retrieval, not attachments or existing chat context. */
  scope: ScopeRef,
  /** Null means no model has been selected, for example before the catalog loads or in Search. */
  model: ChatModelSelection | null,
  /** Capability IDs: "infumap_data" and configured MCP server IDs. Order has no meaning. */
  capabilities: Array<string>,
  toolApproval: ToolApproval,
}

/** A named setup, also recorded in transcripts as the applied snapshot. Pinning, ordering and the default are account preferences. */
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
  /** Incremented by every change, so a response older than the held collection can be ignored. */
  revision: number,
  /** All profiles in their user-selected order. */
  profiles: Array<QueryProfile>,
  preferences: {
    /** Null: new queries start from the server's catalog-derived configuration. */
    defaultProfileId: Uid | null,
    /** One-click shortcuts, in profile order. */
    pinnedProfileIds: Array<Uid>,
    modelFavorites: Array<QueryModelFavorite>,
  },
}

/** Each mutation states one intent and applies to the saved collection as it is when it arrives. */
export type QueryProfileOperation =
  | { operation: "list" }
  | { operation: "create", name: string, configuration: QueryConfiguration }
  | { operation: "rename", id: Uid, name: string }
  | { operation: "setConfiguration", id: Uid, configuration: QueryConfiguration }
  | { operation: "duplicate", id: Uid }
  | { operation: "delete", id: Uid }
  | { operation: "move", id: Uid, toIndex: number }
  | { operation: "setPinned", id: Uid, pinned: boolean }
  | { operation: "setDefault", id: Uid | null }
  | { operation: "setModelFavorite", backend: ChatBackendId, model: string | null, favorite: boolean };

export interface QueryProfilesResponse {
  userId: Uid,
  collection: QueryProfileCollection,
  /** A rejected mutation leaves the collection unchanged. */
  error: string | null,
  /** The created, changed or duplicated profile, when applicable. */
  profileId: Uid | null,
}

/** What a new query starts with: the default profile, or without one the server's current default configuration. */
export interface InitialQuerySetup {
  configuration: QueryConfiguration,
  profile: QueryProfile | null,
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
  /**
   * Items chosen in the chat, each covering itself and its descendants. When there are any, they limit Infumap tools
   * in place of `configuration.scope`, which stays selected for when they are removed. Not part of the
   * configuration, so profiles never carry them. The server omits an empty list.
   */
  /** Previous item limit retained until the user chooses a collection. */
  scopeItemIds?: Array<Uid>,
  appliedProfile: QueryProfile | null,
  mode: ChatRunMode,
}

/** A value copy, so conversation settings never share mutable objects with a saved profile. */
export function cloneQueryConfiguration(configuration: QueryConfiguration): QueryConfiguration {
  return {
    scope: { ...configuration.scope },
    model: configuration.model == null ? null : { ...configuration.model },
    capabilities: [...new Set(configuration.capabilities)],
    toolApproval: configuration.toolApproval,
  };
}

/** Captures the profile as applied; later renames and configuration edits cannot change this snapshot. */
export function snapshotQueryProfile(profile: QueryProfile): QueryProfile {
  return {
    id: profile.id,
    name: profile.name,
    configuration: cloneQueryConfiguration(profile.configuration),
  };
}

/** Capability order and duplicate entries cannot make an otherwise identical setup appear modified. */
export function queryConfigurationsEqual(left: QueryConfiguration, right: QueryConfiguration): boolean {
  if (!scopeRefsEqual(left.scope, right.scope)) { return false; }
  if (left.toolApproval != right.toolApproval) { return false; }
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
