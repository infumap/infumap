/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Accessor, createSignal } from "solid-js";
import { ChatBackends, post, server } from "../server";
import type { QueryProfile } from "../items/query-configuration";
import { makeQueryProfilesStore, type QueryProfilesStore } from "./StoreProvider_QueryProfiles";
import { NumberSignal, createNumberSignal } from "../util/signals";
import type { Uid } from "../util/uid";


const LOCALSTORAGE_KEY_NAME = "infudata";

export const NETWORK_STATUS_OK = 0;
export const NETWORK_STATUS_IN_PROGRESS = 1;
export const NETWORK_STATUS_ERROR = 2;
const RECENT_NETWORK_REQUEST_TTL_MS = 9000;

interface InstallationState {
  hasRootUser: boolean,
}

interface LocalStorageData {
  prefer2fa?: boolean,
  searchResultsArrangeAlgorithm?: string,
}

export type QueryInputMode = "search" | "chat";

export type NetworkRequestKind = "write" | "read" | "sync" | "chat";

export type SyncPausedReason = "text-edit";

export interface NetworkRequestInfo {
  requestId: number,
  command: string,
  kind: NetworkRequestKind,
  description: string,
  itemId?: string,
  host?: string | null,
  /** Unset while the request is queued. */
  startedMs?: number,
  endedMs?: number,
  /** Set on finished requests that did not fail. */
  outcome?: "done" | "cancelled",
}

export type NetworkFailureReason = "unreachable" | "auth" | "not-found" | "server" | "client" | "unknown";

/**
 * A failed request, merged with earlier failures of the same request (see networkProblemKey). A read, sync or chat
 * problem clears when the same request later succeeds. A write problem means a change was reverted to the server's
 * version, which a later success does not undo, so it stays until dismissed.
 */
export interface NetworkProblem {
  key: string,
  kind: NetworkRequestKind,
  description: string,
  itemId?: string,
  host?: string | null,
  reason: NetworkFailureReason,
  message: string,
  firstMs: number,
  lastMs: number,
  count: number,
}

export type NetworkProblemReport = Omit<NetworkProblem, "firstMs" | "lastMs" | "count">;

export function networkProblemKey(request: NetworkRequestInfo): string {
  return `${request.host ?? ""}|${request.command}|${request.itemId ?? ""}`;
}

export interface GeneralStoreContextModel {
  installationState: Accessor<InstallationState | null>,
  retrieveInstallationState: () => Promise<void>,
  clearInstallationState: () => void,

  chatBackends: Accessor<ChatBackends | null>,
  chatBackendsError: Accessor<string | null>,
  chatBackendsRefreshing: Accessor<boolean>,
  retrieveChatBackends: () => Promise<void>,
  refreshChatBackends: () => Promise<void>,

  defaultQueryProfile: Accessor<QueryProfile | null>,
  setDefaultQueryProfile: (id: Uid) => Promise<void>,
  queryProfiles: QueryProfilesStore,

  prefer2fa: () => boolean,
  setPrefer2fa: (prefer2fa: boolean) => void,

  searchResultsArrangeAlgorithm: () => string,
  setSearchResultsArrangeAlgorithm: (arrangeAlgorithm: string) => void,

  queryInputMode: () => QueryInputMode,
  setQueryInputMode: (mode: QueryInputMode) => void,

  networkStatus: NumberSignal,
  inProgressNetworkRequests: Accessor<NetworkRequestInfo[]>,
  setInProgressNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  recentNetworkRequests: Accessor<NetworkRequestInfo[]>,
  addRecentNetworkRequest: (request: NetworkRequestInfo) => void,
  queuedNetworkRequests: Accessor<NetworkRequestInfo[]>,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  networkProblems: Accessor<NetworkProblem[]>,
  recordNetworkProblem: (problem: NetworkProblemReport) => void,
  /** Clears the read, sync and chat problems with this key, after the request succeeded. */
  resolveNetworkProblems: (key: string) => void,
  dismissNetworkProblem: (key: string) => void,
  dismissAllNetworkProblems: () => void,
  /** False after a request to the local server could not reach it, until one does. */
  serverReachable: Accessor<boolean>,
  setServerReachable: (reachable: boolean) => void,
  clearNetworkHistory: () => void,

  /** Background container sync is not listed as requests; these summarize it instead. */
  lastSyncOkMs: Accessor<number | null>,
  consecutiveSyncFailures: Accessor<number>,
  recordSyncResult: (ok: boolean) => void,
  syncPausedReason: Accessor<SyncPausedReason | null>,
  setSyncPausedReason: (reason: SyncPausedReason | null) => void,
}


export function makeGeneralStore(accountId: () => Uid | null): GeneralStoreContextModel {
  const [localStorageDataString, setLocalStorageDataString] = createSignal<string | null>(window.localStorage.getItem(LOCALSTORAGE_KEY_NAME), { equals: false });

  const [installationState, setInstallationState] = createSignal<InstallationState | null>(null, { equals: false });

  const [chatBackends, setChatBackends] = createSignal<ChatBackends | null>(null, { equals: false });
  const [chatBackendsError, setChatBackendsError] = createSignal<string | null>(null);
  const [chatBackendsRefreshing, setChatBackendsRefreshing] = createSignal<boolean>(false);
  let inProgressChatBackendsRequest: Promise<void> | null = null;

  const networkStatus = createNumberSignal(NETWORK_STATUS_OK);
  const queryProfiles = makeQueryProfilesStore(accountId, networkStatus);
  const defaultQueryProfile = queryProfiles.defaultProfile;
  const setDefaultQueryProfile = queryProfiles.setDefault;

  const [inProgressNetworkRequests, setInProgressNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [recentNetworkRequests, setRecentNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [queuedNetworkRequests, setQueuedNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [networkProblems, setNetworkProblems] = createSignal<NetworkProblem[]>([]);
  const [serverReachable, setServerReachable] = createSignal<boolean>(true);
  const [lastSyncOkMs, setLastSyncOkMs] = createSignal<number | null>(null);
  const [consecutiveSyncFailures, setConsecutiveSyncFailures] = createSignal<number>(0);
  const [syncPausedReason, setSyncPausedReason] = createSignal<SyncPausedReason | null>(null);
  const [queryInputMode, setQueryInputModeSignal] = createSignal<QueryInputMode>("search");
  const recentNetworkRequestTimeouts = new Map<number, number>();

  const normalizeSearchResultsArrangeAlgorithm = (arrangeAlgorithm: string | null | undefined): string =>
    arrangeAlgorithm == "grid" ? "grid" : "catalog";
  const normalizeQueryInputMode = (mode: string | null | undefined): QueryInputMode =>
    mode == "chat" ? "chat" : "search";

  const readLocalStorageData = (): LocalStorageData => {
    const lcDs = localStorageDataString();
    if (lcDs == null) { return {}; }
    const parsed = JSON.parse(lcDs);
    return parsed != null && typeof parsed == "object" ? parsed : {};
  };

  const writeLocalStorageData = (data: LocalStorageData): void => {
    const lcDs = JSON.stringify(data);
    window.localStorage.setItem(LOCALSTORAGE_KEY_NAME, lcDs);
    setLocalStorageDataString(lcDs);
  };

  const addRecentNetworkRequest = (request: NetworkRequestInfo): void => {
    setRecentNetworkRequests((current) => [request, ...current]);
    const timeoutId = window.setTimeout(() => {
      recentNetworkRequestTimeouts.delete(request.requestId);
      setRecentNetworkRequests((current) => current.filter((existing) => existing.requestId !== request.requestId));
    }, RECENT_NETWORK_REQUEST_TTL_MS);
    recentNetworkRequestTimeouts.set(request.requestId, timeoutId);
  };

  const recordNetworkProblem = (problem: NetworkProblemReport) => {
    const nowMs = Date.now();
    setNetworkProblems((current) => {
      const existing = current.find(p => p.key == problem.key);
      if (existing == null) {
        return [...current, { ...problem, firstMs: nowMs, lastMs: nowMs, count: 1 }];
      }
      return current.map(p => p === existing
        ? { ...problem, firstMs: existing.firstMs, lastMs: nowMs, count: existing.count + 1 }
        : p);
    });
  };

  const resolveNetworkProblems = (key: string) => {
    // Called on every successful request, so leave the signal alone when there is nothing to clear.
    if (!networkProblems().some(p => p.key == key && p.kind != "write")) { return; }
    setNetworkProblems((current) => current.filter(p => p.key != key || p.kind == "write"));
  };

  const dismissNetworkProblem = (key: string) => {
    setNetworkProblems((current) => current.filter(p => p.key != key));
  };

  const dismissAllNetworkProblems = () => {
    setNetworkProblems([]);
  };

  const recordSyncResult = (ok: boolean) => {
    if (ok) {
      setLastSyncOkMs(Date.now());
      setConsecutiveSyncFailures(0);
      setSyncPausedReason(null);
    } else {
      setConsecutiveSyncFailures(consecutiveSyncFailures() + 1);
    }
  };

  const clearNetworkHistory = () => {
    recentNetworkRequestTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    recentNetworkRequestTimeouts.clear();
    setInProgressNetworkRequests([]);
    setRecentNetworkRequests([]);
    setQueuedNetworkRequests([]);
    setNetworkProblems([]);
    setServerReachable(true);
    setLastSyncOkMs(null);
    setConsecutiveSyncFailures(0);
    setSyncPausedReason(null);
    networkStatus.set(NETWORK_STATUS_OK);
  };

  const retrieveInstallationState = async () => {
    try {
      setInstallationState(await post(null, "/admin/installation-state", {}));
    } catch (e) {
      console.error("An error occurred retrieving installation state. " + e);
      setInstallationState(null);
    }
  }
  const clearInstallationState = () => { setInstallationState(null); }

  /** One fetch at a time; concurrent callers share it. A failure leaves the last good list in place. */
  const fetchChatBackends = async (): Promise<void> => {
    if (inProgressChatBackendsRequest != null) { return inProgressChatBackendsRequest; }
    setChatBackendsRefreshing(true);
    inProgressChatBackendsRequest = (async () => {
      try {
        const backends = await server.chatBackends();
        setChatBackends(backends);
        setChatBackendsError(null);
      } catch (e) {
        console.error("An error occurred retrieving chat backends. " + e);
        setChatBackendsError("Could not load the list of chat models.");
      } finally {
        inProgressChatBackendsRequest = null;
        setChatBackendsRefreshing(false);
      }
    })();
    return inProgressChatBackendsRequest;
  }

  /**
   * The chat backends and models this server offers, fetched once and then kept, because the server
   * caches the underlying model list anyway.
   */
  const retrieveChatBackends = async () => {
    if (chatBackends() != null) { return; }
    return fetchChatBackends();
  }

  /**
   * Fetches again even when a list is already held, which re-probes the tool servers: the server
   * side caches an unreachable one for only a few seconds, so one that has since come up shows up.
   */
  const refreshChatBackends = async () => fetchChatBackends();

  const prefer2fa = () => {
    return readLocalStorageData().prefer2fa ?? false;
  }
  const setPrefer2fa = (prefer2fa: boolean) => {
    writeLocalStorageData({ ...readLocalStorageData(), prefer2fa });
  }
  const searchResultsArrangeAlgorithm = () => {
    return normalizeSearchResultsArrangeAlgorithm(readLocalStorageData().searchResultsArrangeAlgorithm);
  };
  const setSearchResultsArrangeAlgorithm = (arrangeAlgorithm: string) => {
    const normalizedArrangeAlgorithm = normalizeSearchResultsArrangeAlgorithm(arrangeAlgorithm);
    if (searchResultsArrangeAlgorithm() == normalizedArrangeAlgorithm) {
      return;
    }
    writeLocalStorageData({
      ...readLocalStorageData(),
      searchResultsArrangeAlgorithm: normalizedArrangeAlgorithm,
    });
  };
  const setQueryInputMode = (mode: QueryInputMode) => {
    setQueryInputModeSignal(normalizeQueryInputMode(mode));
  };

  return {
    installationState, retrieveInstallationState, clearInstallationState,
    chatBackends, chatBackendsError, chatBackendsRefreshing, retrieveChatBackends, refreshChatBackends,
    defaultQueryProfile, setDefaultQueryProfile, queryProfiles,
    prefer2fa, setPrefer2fa,
    searchResultsArrangeAlgorithm, setSearchResultsArrangeAlgorithm,
    queryInputMode, setQueryInputMode,
    networkStatus,
    inProgressNetworkRequests, setInProgressNetworkRequests,
    recentNetworkRequests, addRecentNetworkRequest,
    queuedNetworkRequests, setQueuedNetworkRequests,
    networkProblems, recordNetworkProblem, resolveNetworkProblems, dismissNetworkProblem, dismissAllNetworkProblems,
    serverReachable, setServerReachable,
    clearNetworkHistory,
    lastSyncOkMs, consecutiveSyncFailures, recordSyncResult, syncPausedReason, setSyncPausedReason,
  };
}
