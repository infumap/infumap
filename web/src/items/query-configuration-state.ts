/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import type { StoreContextModel } from "../store/StoreProvider";
import { getQueryRuntime, updateQueryRuntime, type QueryItem } from "./query-item";
import {
  cloneQueryConfiguration,
  queryConfigurationsEqual,
  snapshotQueryProfile,
  type ChatRunMode,
  type QueryChatSettings,
  type QueryConfiguration,
  type QueryProfile,
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
  replaceQueryProfile(store, queryItem, profile);
}

/** A late default can initialize a pending query, but cannot change an applied, edited or restored setup. */
export function initializeQueryConfiguration(store: StoreContextModel, queryItem: QueryItem): boolean {
  if (getQueryRuntime(store, queryItem).configurationInitialized) { return true; }
  const profile = store.general.defaultQueryProfile();
  if (profile == null) { return false; }
  // Initialization is also needed while a first request waits for its complete default setup.
  replaceQueryProfile(store, queryItem, profile);
  return true;
}

/** Commands wait for the complete default setup rather than sending a partially initialized query. */
export async function ensureQueryConfigurationReady(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  if (initializeQueryConfiguration(store, queryItem)) { return; }
  await store.general.queryProfiles.retrieve();
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error(store.general.queryProfiles.error() ?? "Could not load the default query profile.");
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
    throw new Error("The default query profile has not loaded yet.");
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
    throw new Error("The default query profile has not loaded yet.");
  }
  const capabilities = new Set(getQueryRuntime(store, queryItem).configuration.capabilities);
  if (enabled) { capabilities.add(capability); }
  else { capabilities.delete(capability); }
  updateQueryConfiguration(store, queryItem, { capabilities: [...capabilities] });
}

/** The saved profile this query's setup came from, as it is saved now. Null once that profile is deleted. */
export function appliedSavedProfile(store: StoreContextModel, queryItem: QueryItem): QueryProfile | null {
  const applied = getQueryRuntime(store, queryItem).appliedProfile;
  if (applied == null) { return null; }
  return store.general.queryProfiles.collection()?.profiles.find(profile => profile.id == applied.id) ?? null;
}

/** Re-applies the applied profile as it is saved now. */
export function resetQueryConfiguration(store: StoreContextModel, queryItem: QueryItem): boolean {
  const profile = appliedSavedProfile(store, queryItem);
  if (profile == null) { return false; }
  applyQueryProfile(store, queryItem, profile);
  return true;
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
    throw new Error("The default query profile has not loaded yet.");
  }
  const runtime = getQueryRuntime(store, queryItem);
  return {
    configuration: cloneQueryConfiguration(runtime.configuration),
    appliedProfile: runtime.appliedProfile == null ? null : snapshotQueryProfile(runtime.appliedProfile),
    mode,
  };
}
