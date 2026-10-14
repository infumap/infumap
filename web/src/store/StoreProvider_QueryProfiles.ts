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

export class QueryProfileConflictError extends Error {
  constructor() { super("Query profiles changed in another tab or device. Review the updated profiles and try again."); }
}

export interface QueryProfilesStore {
  collection: Accessor<QueryProfileCollection | null>,
  defaultProfile: Accessor<QueryProfile | null>,
  error: Accessor<string | null>,
  loading: Accessor<boolean>,
  retrieve: () => Promise<void>,
  refresh: () => Promise<void>,
  create: (name: string, configuration: QueryConfiguration) => Promise<QueryProfile>,
  update: (profile: QueryProfile) => Promise<QueryProfile>,
  duplicate: (id: Uid, name: string) => Promise<QueryProfile>,
  delete: (id: Uid, replacementDefaultProfileId?: Uid) => Promise<void>,
  reorder: (profileIds: Array<Uid>) => Promise<void>,
  setPinned: (profileIds: Array<Uid>) => Promise<void>,
  setDefault: (id: Uid) => Promise<void>,
  setModelFavorites: (favorites: Array<QueryModelFavorite>) => Promise<void>,
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

  const mutate = (operation: Exclude<QueryProfileOperation, { operation: "list" }>): Promise<QueryProfilesResponse> => {
    synchronizeAccount();
    const owner = ownerId;
    const epoch = generation;
    const run = async () => {
      if (owner == null || !isCurrent(epoch, owner)) { throw new Error("Sign in to manage query profiles."); }
      await retrieve();
      if (!isCurrent(epoch, owner)) { throw new Error("The account changed while updating query profiles."); }
      const collection = storedCollection();
      if (collection == null) { throw new Error(error() ?? "Could not load query profiles."); }
      const response = await server.queryProfiles(operation, networkStatus, owner, collection.revision);
      acceptResponse(response, epoch, owner);
      if (response.conflict) { throw new QueryProfileConflictError(); }
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
    update: profile => mutate({ operation: "update", ...snapshotQueryProfile(profile) }).then(profileFromResponse),
    duplicate: (id, name) => mutate({ operation: "duplicate", id, name }).then(profileFromResponse),
    delete: async (id, replacementDefaultProfileId) => { await mutate({ operation: "delete", id, replacementDefaultProfileId }); },
    reorder: async profileIds => { await mutate({ operation: "reorder", profileIds: [...profileIds] }); },
    setPinned: async profileIds => { await mutate({ operation: "setPinned", profileIds: [...profileIds] }); },
    setDefault: async id => { await mutate({ operation: "setDefault", id }); },
    setModelFavorites: async favorites => {
      await mutate({ operation: "setModelFavorites", favorites: favorites.map(favorite => ({ ...favorite })) });
    },
  };
}
