/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import type { StoreContextModel } from "../store/StoreProvider";
import { getQueryRuntime, updateQueryRuntime, type QueryItem } from "./query-item";
import {
  cloneQueryConfiguration,
  queryConfigurationsEqual,
  scopeRefCollectionId,
  snapshotQueryProfile,
  type ChatRunMode,
  type InitialQuerySetup,
  type QueryChatSettings,
  type QueryConfiguration,
  type QueryProfile,
  type ScopeRef,
} from "./query-configuration";

/** Editing affects the next turn. Loading and active requests own the current turn's settings. */
export function queryConfigurationChangeBlockedReason(store: StoreContextModel, queryItem: QueryItem): string | null {
  const chat = getQueryRuntime(store, queryItem).chat;
  if (chat.requestId != null) { return "Wait for the current response to finish."; }
  if (chat.runningElsewhere) { return "A response is running in another window. This chat will refresh when it finishes."; }
  if (chat.loadState == "loading") { return "Wait for this chat to load before changing settings."; }
  if (chat.loadState == "failed") { return "This chat could not be loaded. Reload it before changing settings."; }
  return null;
}

/** Why this chat's scope, tools and mode can't change, or null if they can. The model and tool approval always can. */
export function queryChatSetupFixedReason(store: StoreContextModel, queryItem: QueryItem): string | null {
  return getQueryRuntime(store, queryItem).chat.fixedSetup == null ? null
    : "Fixed by this chat's first message. Start a new chat to change it.";
}

function assertQueryChatSetupEditable(store: StoreContextModel, queryItem: QueryItem): void {
  const reason = queryChatSetupFixedReason(store, queryItem);
  if (reason != null) { throw new Error(reason); }
}

function assertQueryConfigurationEditable(store: StoreContextModel, queryItem: QueryItem): void {
  const reason = queryConfigurationChangeBlockedReason(store, queryItem);
  if (reason != null) { throw new Error(reason); }
}

function replaceQueryProfile(store: StoreContextModel, queryItem: QueryItem, profile: QueryProfile): void {
  const appliedProfile = snapshotQueryProfile(profile);
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration(appliedProfile.configuration),
    appliedProfile,
    configurationInitialized: true,
  }));
}

/** Applies every resource in one update and records the profile as applied. Does not change mode or user defaults. */
export function applyQueryProfile(store: StoreContextModel, queryItem: QueryItem, profile: QueryProfile): void {
  assertQueryConfigurationEditable(store, queryItem);
  assertQueryChatSetupEditable(store, queryItem);
  replaceQueryProfile(store, queryItem, profile);
}

function initializeFromSetup(store: StoreContextModel, queryItem: QueryItem, setup: InitialQuerySetup): void {
  if (setup.profile != null) { replaceQueryProfile(store, queryItem, setup.profile); return; }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration(setup.configuration),
    appliedProfile: null,
    configurationInitialized: true,
  }));
}

/** A late default can initialize a pending query, but cannot change an applied, edited or restored setup. */
export function initializeQueryConfiguration(store: StoreContextModel, queryItem: QueryItem): boolean {
  if (getQueryRuntime(store, queryItem).configurationInitialized) { return true; }
  const setup = store.general.initialQuerySetup();
  if (setup == null) { return false; }
  // Initialization is also needed while a first request waits for its complete default setup.
  initializeFromSetup(store, queryItem, setup);
  return true;
}

/** Commands wait for the complete default setup rather than sending a partially initialized query. */
export async function ensureQueryConfigurationReady(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  if (initializeQueryConfiguration(store, queryItem)) { return; }
  await Promise.all([store.general.queryProfiles.retrieve(), store.general.retrieveChatBackends()]);
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error(store.general.queryProfiles.error() ?? store.general.chatBackendsError() ?? "Could not load the default query settings.");
  }
}

/** Changes only this query. Inputs and the applied snapshot remain independent value copies. */
export function updateQueryConfiguration(
  store: StoreContextModel,
  queryItem: QueryItem,
  patch: Partial<QueryConfiguration>,
): void {
  assertQueryConfigurationEditable(store, queryItem);
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error("The default query settings have not loaded yet.");
  }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration({ ...current.configuration, ...patch }),
  }));
}

export function setQueryConfigurationCapability(
  store: StoreContextModel,
  queryItem: QueryItem,
  capability: string,
  enabled: boolean,
): void {
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error("The default query settings have not loaded yet.");
  }
  assertQueryChatSetupEditable(store, queryItem);
  const capabilities = new Set(getQueryRuntime(store, queryItem).configuration.capabilities);
  if (enabled) { capabilities.add(capability); }
  else { capabilities.delete(capability); }
  updateQueryConfiguration(store, queryItem, { capabilities: [...capabilities] });
}

/** An explicit collection choice replaces a retired item limit for the next turn. */
export function setQueryChatScope(store: StoreContextModel, queryItem: QueryItem, scope: ScopeRef): void {
  assertQueryConfigurationEditable(store, queryItem);
  assertQueryChatSetupEditable(store, queryItem);
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error("The default query settings have not loaded yet.");
  }
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration({ ...current.configuration, scope }),
    scopeItemIds: scopeRefCollectionId(scope) != null ? [] : current.scopeItemIds,
  }));
}

/** The saved profile this query's setup came from, as it is saved now. Null once that profile is deleted. */
export function appliedSavedProfile(store: StoreContextModel, queryItem: QueryItem): QueryProfile | null {
  const applied = getQueryRuntime(store, queryItem).appliedProfile;
  if (applied == null) { return null; }
  return store.general.queryProfiles.collection()?.profiles.find(profile => profile.id == applied.id) ?? null;
}

/** Whether this query's setup differs from its applied profile as saved now. */
export function isQueryConfigurationModified(store: StoreContextModel, queryItem: QueryItem): boolean {
  const profile = appliedSavedProfile(store, queryItem);
  return profile != null && !queryConfigurationsEqual(getQueryRuntime(store, queryItem).configuration, profile.configuration);
}

/** Restore recorded resources and provenance together; default initialization cannot overwrite them. */
export function restoreQueryConfiguration(
  store: StoreContextModel,
  queryItem: QueryItem,
  settings: QueryChatSettings,
): void {
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration(settings.configuration),
    appliedProfile: settings.appliedProfile == null ? null : snapshotQueryProfile(settings.appliedProfile),
    scopeItemIds: [...(settings.scopeItemIds ?? [])],
    configurationInitialized: true,
  }));
}

/** Capture exactly what was selected. Sending never replaces selections or the applied profile. */
export function snapshotQueryChatSettings(
  store: StoreContextModel,
  queryItem: QueryItem,
  mode: ChatRunMode,
): QueryChatSettings {
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error("The default query settings have not loaded yet.");
  }
  const runtime = getQueryRuntime(store, queryItem);
  return {
    configuration: cloneQueryConfiguration(runtime.configuration),
    appliedProfile: runtime.appliedProfile == null ? null : snapshotQueryProfile(runtime.appliedProfile),
    // Turns with Infumap off retain the old limit so re-enabling the tools still requires a collection choice.
    scopeItemIds: [...runtime.scopeItemIds],
    mode,
  };
}
