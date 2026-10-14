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

/** Applies every resource and the reset baseline in one update. Does not change mode or user defaults. */
export function applyQueryProfile(store: StoreContextModel, queryItem: QueryItem, profile: QueryProfile): void {
  const appliedProfile = snapshotQueryProfile(profile);
  updateQueryRuntime(store, queryItem, current => ({
    ...current,
    configuration: cloneQueryConfiguration(appliedProfile.configuration),
    appliedProfile,
    configurationInitialized: true,
  }));
}

/** A late default can initialize a pending query, but cannot change an applied, edited or restored setup. */
export function initializeQueryConfiguration(store: StoreContextModel, queryItem: QueryItem): boolean {
  if (getQueryRuntime(store, queryItem).configurationInitialized) { return true; }
  const profile = store.general.defaultQueryProfile();
  if (profile == null) { return false; }
  applyQueryProfile(store, queryItem, profile);
  return true;
}

/** Commands wait for the complete default setup rather than sending a partially initialized query. */
export async function ensureQueryConfigurationReady(store: StoreContextModel, queryItem: QueryItem): Promise<void> {
  if (initializeQueryConfiguration(store, queryItem)) { return; }
  await store.general.retrieveChatBackends();
  if (!initializeQueryConfiguration(store, queryItem)) {
    throw new Error(store.general.chatBackendsError() ?? "Could not load the default query profile.");
  }
}

/** Changes only this query. Inputs and the applied snapshot remain independent value copies. */
export function updateQueryConfiguration(
  store: StoreContextModel,
  queryItem: QueryItem,
  patch: Partial<QueryConfiguration>,
): void {
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

/** Restores the snapshot as applied, even if the saved profile was changed or deleted afterwards. */
export function resetQueryConfiguration(store: StoreContextModel, queryItem: QueryItem): boolean {
  const appliedProfile = getQueryRuntime(store, queryItem).appliedProfile;
  if (appliedProfile == null) { return false; }
  applyQueryProfile(store, queryItem, appliedProfile);
  return true;
}

export function isQueryConfigurationModified(store: StoreContextModel, queryItem: QueryItem): boolean {
  const runtime = getQueryRuntime(store, queryItem);
  return runtime.appliedProfile != null &&
    !queryConfigurationsEqual(runtime.configuration, runtime.appliedProfile.configuration);
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

/** Capture exactly what was selected. Sending never replaces selections or changes the reset baseline. */
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
