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
import { ChatBackends, ChatModelSelection, post, server } from "../server";
import { NumberSignal, createNumberSignal } from "../util/signals";


const LOCALSTORAGE_KEY_NAME = "infudata";

export const NETWORK_STATUS_OK = 0;
export const NETWORK_STATUS_IN_PROGRESS = 1;
export const NETWORK_STATUS_ERROR = 2;
const RECENT_NETWORK_REQUEST_TTL_MS = 9000;

interface InstallationState {
  hasRootUser: boolean,
  enableExperimental: boolean,
}

interface LocalStorageData {
  prefer2fa?: boolean,
  searchResultsArrangeAlgorithm?: string,
  chatModelSelection?: ChatModelSelection,
}

export type QueryInputMode = "search" | "chat";

export interface NetworkRequestInfo {
  requestId: number,
  command: string,
  description: string,
  itemId?: string,
  host?: string | null,
  errorMessage?: string,
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

  chatModelSelection: () => ChatModelSelection | null,
  setChatModelSelection: (selection: ChatModelSelection | null) => void,

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
  queuedNetworkRequests: Accessor<NetworkRequestInfo[]>,
  setQueuedNetworkRequests: (requests: NetworkRequestInfo[]) => void,
  erroredNetworkRequests: Accessor<NetworkRequestInfo[]>,
  hasUnacknowledgedNetworkErrors: Accessor<boolean>,
  addErroredNetworkRequest: (request: NetworkRequestInfo) => void,
  acknowledgeNetworkErrors: () => void,
  clearNetworkHistory: () => void,
}


export function makeGeneralStore(): GeneralStoreContextModel {
  const [localStorageDataString, setLocalStorageDataString] = createSignal<string | null>(window.localStorage.getItem(LOCALSTORAGE_KEY_NAME), { equals: false });

  const [installationState, setInstallationState] = createSignal<InstallationState | null>(null, { equals: false });

  const [chatBackends, setChatBackends] = createSignal<ChatBackends | null>(null, { equals: false });
  const [chatBackendsError, setChatBackendsError] = createSignal<string | null>(null);
  const [chatBackendsRefreshing, setChatBackendsRefreshing] = createSignal<boolean>(false);
  let inProgressChatBackendsRequest: Promise<void> | null = null;

  const networkStatus = createNumberSignal(NETWORK_STATUS_OK);

  const [inProgressNetworkRequests, setInProgressNetworkRequestsSignal] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [recentNetworkRequests, setRecentNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [queuedNetworkRequests, setQueuedNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [erroredNetworkRequests, setErroredNetworkRequests] = createSignal<NetworkRequestInfo[]>([], { equals: false });
  const [hasUnacknowledgedNetworkErrors, setHasUnacknowledgedNetworkErrors] = createSignal<boolean>(false, { equals: false });
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

  const clearRecentNetworkRequestTimeout = (requestId: number): void => {
    const timeoutId = recentNetworkRequestTimeouts.get(requestId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      recentNetworkRequestTimeouts.delete(requestId);
    }
  };

  const removeRecentNetworkRequest = (requestId: number): void => {
    clearRecentNetworkRequestTimeout(requestId);
    setRecentNetworkRequests((current) => current.filter((request) => request.requestId !== requestId));
  };

  const scheduleRecentNetworkRequestExpiry = (request: NetworkRequestInfo): void => {
    clearRecentNetworkRequestTimeout(request.requestId);
    const timeoutId = window.setTimeout(() => {
      recentNetworkRequestTimeouts.delete(request.requestId);
      setRecentNetworkRequests((current) => current.filter((existing) => existing.requestId !== request.requestId));
    }, RECENT_NETWORK_REQUEST_TTL_MS);
    recentNetworkRequestTimeouts.set(request.requestId, timeoutId);
  };

  const setInProgressNetworkRequests = (requests: NetworkRequestInfo[]) => {
    const previousRequests = inProgressNetworkRequests();
    const nextRequestIds = new Set(requests.map((request) => request.requestId));
    const erroredRequestIds = new Set(erroredNetworkRequests().map((request) => request.requestId));
    const completedRequests = previousRequests.filter((request) =>
      !nextRequestIds.has(request.requestId) && !erroredRequestIds.has(request.requestId)
    );

    requests.forEach((request) => removeRecentNetworkRequest(request.requestId));
    completedRequests.forEach((request) => {
      setRecentNetworkRequests((current) => {
        const deduped = current.filter((existing) => existing.requestId !== request.requestId);
        return [request, ...deduped];
      });
      scheduleRecentNetworkRequestExpiry(request);
    });

    setInProgressNetworkRequestsSignal(requests);
  };

  const addErroredNetworkRequest = (request: NetworkRequestInfo) => {
    setHasUnacknowledgedNetworkErrors(true);
    removeRecentNetworkRequest(request.requestId);
    setErroredNetworkRequests((current) => {
      const deduped = current.filter(existing =>
        existing.host !== request.host ||
        existing.command !== request.command ||
        existing.itemId !== request.itemId ||
        existing.description !== request.description
      );
      return [...deduped, request];
    });
  };

  const acknowledgeNetworkErrors = () => {
    setHasUnacknowledgedNetworkErrors(false);
    setErroredNetworkRequests([]);
  };

  const clearNetworkHistory = () => {
    recentNetworkRequestTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    recentNetworkRequestTimeouts.clear();
    setInProgressNetworkRequestsSignal([]);
    setRecentNetworkRequests([]);
    setQueuedNetworkRequests([]);
    setErroredNetworkRequests([]);
    setHasUnacknowledgedNetworkErrors(false);
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
        setChatBackends(await server.chatBackends());
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

  /**
   * The model last chosen in the chat composer, used as the default for new chats. Read defensively:
   * local storage is editable by hand, and a stale model id is possible.
   */
  const chatModelSelection = (): ChatModelSelection | null => {
    const stored = readLocalStorageData().chatModelSelection;
    if (stored == null || typeof stored != "object") { return null; }
    const asString = (value: unknown) => typeof value == "string" && value != "" ? value : undefined;
    const backend = stored.backend == "llama" || stored.backend == "openrouter" ? stored.backend : undefined;
    if (backend == null) { return null; }
    return { backend, model: asString(stored.model), reasoningEffort: asString(stored.reasoningEffort) };
  };
  const setChatModelSelection = (selection: ChatModelSelection | null) => {
    const data = readLocalStorageData();
    if (selection == null) {
      delete data.chatModelSelection;
      writeLocalStorageData(data);
      return;
    }
    writeLocalStorageData({ ...data, chatModelSelection: selection });
  };

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
    chatModelSelection, setChatModelSelection,
    prefer2fa, setPrefer2fa,
    searchResultsArrangeAlgorithm, setSearchResultsArrangeAlgorithm,
    queryInputMode, setQueryInputMode,
    networkStatus,
    inProgressNetworkRequests, setInProgressNetworkRequests,
    recentNetworkRequests,
    queuedNetworkRequests, setQueuedNetworkRequests,
    erroredNetworkRequests, hasUnacknowledgedNetworkErrors, addErroredNetworkRequest, acknowledgeNetworkErrors, clearNetworkHistory,
  };
}
