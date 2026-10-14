/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import { createSignal, onCleanup, type Accessor } from "solid-js";
import { server } from "../server";
import {
  cloneQueryConfiguration, cloneQueryProfileCollection, snapshotQueryProfile,
  type QueryConfiguration, type QueryModelFavorite, type QueryProfile,
  type QueryProfileCollection, type QueryProfileOperation, type QueryProfilesResponse,
} from "../items/query-configuration";
import type { NumberSignal } from "../util/signals";
import type { Uid } from "../util/uid";

export interface QueryProfilesStore {
  collection: Accessor<QueryProfileCollection | null>,
  defaultProfile: Accessor<QueryProfile | null>,
  error: Accessor<string | null>,
  loading: Accessor<boolean>,
  retrieve: () => Promise<void>,
  refresh: () => Promise<void>,
  create: (name: string, configuration: QueryConfiguration) => Promise<QueryProfile>,
  rename: (id: Uid, name: string) => Promise<QueryProfile>,
  setConfiguration: (id: Uid, configuration: QueryConfiguration) => Promise<QueryProfile>,
  duplicate: (id: Uid) => Promise<QueryProfile>,
  delete: (id: Uid) => Promise<void>,
  move: (id: Uid, toIndex: number) => Promise<void>,
  setPinned: (id: Uid, pinned: boolean) => Promise<void>,
  setDefault: (id: Uid) => Promise<void>,
  setModelFavorite: (model: QueryModelFavorite, favorite: boolean) => Promise<void>,
  clear: () => void,
}

export function makeQueryProfilesStore(accountId: () => Uid | null, networkStatus: NumberSignal): QueryProfilesStore {
  const [storedCollection, setStoredCollection] = createSignal<QueryProfileCollection | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let ownerId: Uid | null = null;
  let generation = 0;
  let pendingRead: Promise<void> | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  const clear = () => {
    generation++;
    pendingRead = null;
    mutationQueue = Promise.resolve();
    setStoredCollection(null);
    setError(null);
    setLoading(false);
  };
  const synchronizeAccount = () => {
    const current = accountId();
    if (current != ownerId) { clear(); ownerId = current; }
  };
  const isCurrent = (epoch: number, owner: Uid) => epoch == generation && owner == ownerId && owner == accountId();
  const acceptResponse = (response: QueryProfilesResponse, epoch: number, owner: Uid) => {
    if (!isCurrent(epoch, owner) || response.userId != owner) {
      throw new Error("The account changed while loading query profiles.");
    }
    if (storedCollection() == null || response.collection.revision >= storedCollection()!.revision) {
      setStoredCollection(cloneQueryProfileCollection(response.collection));
    }
    setError(null);
  };

  const refresh = (): Promise<void> => {
    synchronizeAccount();
    if (ownerId == null) { return Promise.resolve(); }
    if (pendingRead != null) { return pendingRead; }
    const owner = ownerId;
    const epoch = generation;
    setLoading(true);
    const request = server.queryProfiles({ operation: "list" }, networkStatus, owner)
      .then(response => acceptResponse(response, epoch, owner))
      .catch(error => {
        if (isCurrent(epoch, owner)) {
          setError(error instanceof Error ? error.message : "Could not load query profiles.");
        }
      })
      .finally(() => {
        if (isCurrent(epoch, owner)) {
          pendingRead = null;
          setLoading(false);
        }
      });
    pendingRead = request;
    return request;
  };
  const retrieve = (): Promise<void> => {
    synchronizeAccount();
    return storedCollection() == null ? refresh() : Promise.resolve();
  };

  // Local mutations are sent one at a time, so they reach the server in the order they were made.
  const mutate = (operation: Exclude<QueryProfileOperation, { operation: "list" }>): Promise<QueryProfilesResponse> => {
    synchronizeAccount();
    const owner = ownerId;
    const epoch = generation;
    const run = async () => {
      if (owner == null || !isCurrent(epoch, owner)) { throw new Error("Sign in to manage query profiles."); }
      const response = await server.queryProfiles(operation, networkStatus, owner);
      acceptResponse(response, epoch, owner);
      if (response.error != null) { throw new Error(response.error); }
      return response;
    };
    const result = mutationQueue.then(run, run);
    mutationQueue = result.catch(() => {});
    return result;
  };
  const profileFromResponse = (response: QueryProfilesResponse): QueryProfile => {
    const profile = response.collection.profiles.find(profile => profile.id == response.profileId);
    if (profile == null) { throw new Error("The saved query profile was not returned."); }
    return snapshotQueryProfile(profile);
  };

  // Refresh shared account preferences when returning to the app, without changing query snapshots.
  const refreshOnFocus = () => {
    synchronizeAccount();
    if (storedCollection() != null && document.visibilityState == "visible") { void refresh(); }
  };
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", refreshOnFocus);
  onCleanup(() => {
    clear();
    window.removeEventListener("focus", refreshOnFocus);
    document.removeEventListener("visibilitychange", refreshOnFocus);
  });

  return {
    collection: () => {
      synchronizeAccount();
      const collection = storedCollection();
      return collection == null ? null : cloneQueryProfileCollection(collection);
    },
    defaultProfile: () => {
      synchronizeAccount();
      const collection = storedCollection();
      const profile = collection?.profiles.find(profile => profile.id == collection.preferences.defaultProfileId);
      return profile == null ? null : snapshotQueryProfile(profile);
    },
    error: () => { synchronizeAccount(); return error(); },
    loading: () => { synchronizeAccount(); return loading(); },
    retrieve, refresh, clear,
    create: (name, configuration) => mutate({ operation: "create", name, configuration: cloneQueryConfiguration(configuration) })
      .then(profileFromResponse),
    rename: (id, name) => mutate({ operation: "rename", id, name }).then(profileFromResponse),
    setConfiguration: (id, configuration) => mutate({ operation: "setConfiguration", id, configuration: cloneQueryConfiguration(configuration) })
      .then(profileFromResponse),
    duplicate: id => mutate({ operation: "duplicate", id }).then(profileFromResponse),
    delete: async id => { await mutate({ operation: "delete", id }); },
    move: async (id, toIndex) => { await mutate({ operation: "move", id, toIndex }); },
    setPinned: async (id, pinned) => { await mutate({ operation: "setPinned", id, pinned }); },
    setDefault: async id => { await mutate({ operation: "setDefault", id }); },
    setModelFavorite: async (model, favorite) => {
      await mutate({ operation: "setModelFavorite", backend: model.backend, model: model.model, favorite });
    },
  };
}
