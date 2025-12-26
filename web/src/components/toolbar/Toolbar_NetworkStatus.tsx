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

import { Component, For, Show } from "solid-js"
import { useStore } from "../../store/StoreProvider";
import { NETWORK_STATUS_ERROR, NETWORK_STATUS_IN_PROGRESS } from "../../store/StoreProvider_General";
import { Z_INDEX_TOOLBAR_OVERLAY } from "../../constants";


export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();

  const col = () => {
    const status = store.general.networkStatus.get();
    if (status == NETWORK_STATUS_ERROR) { return "#bb7373"; }
    if (status == NETWORK_STATUS_IN_PROGRESS) { return "#babb73"; }
    return "#7bbb73";
  };

  const handleClick = () => {
    store.overlay.networkOverlayVisible.set(!store.overlay.networkOverlayVisible.get());
  };

  return (
    <div class="w-[21px] h-[21px] inline-block ml-[7px] mr-[-2px] relative">
      <div class={`w-[19px] h-[19px] mt-[7px] rounded border-slate-500 border cursor-pointer`}
        style={`background-color: ${col()};`}
        onClick={handleClick}
      />
    </div>
  );
}


export const Toolbar_NetworkStatus_Overlay: Component = () => {
  const store = useStore();

  const currentRequest = () => store.general.currentNetworkRequest();
  const queuedRequests = () => store.general.queuedNetworkRequests();
  const erroredRequests = () => store.general.erroredNetworkRequests();

  const handleClearErrors = () => {
    store.general.clearErroredNetworkRequests();
  };

  const handleClose = () => {
    store.overlay.networkOverlayVisible.set(false);
  };

  return (
    <Show when={store.overlay.networkOverlayVisible.get()}>
      <div class={`absolute rounded border-slate-500 border bg-white shadow-lg`}
        style={`top: 45px; right: 5px; min-width: 300px; max-width: 400px; ` +
          `padding: 12px; z-index: ${Z_INDEX_TOOLBAR_OVERLAY}`}>
        <div class="flex justify-between items-center mb-2">
          <div class="font-bold text-sm">Network Status</div>
          <button onClick={handleClose} class="text-slate-500 hover:text-slate-700 text-lg leading-none">&times;</button>
        </div>

        <Show when={currentRequest()}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">Current:</div>
            <div class="text-sm px-2 py-1 bg-slate-100 rounded">{currentRequest()!.description}</div>
          </div>
        </Show>

        <Show when={queuedRequests().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">Queue ({queuedRequests().length}):</div>
            <For each={queuedRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-yellow-100 rounded mb-1">{request.description}</div>
              )}
            </For>
          </div>
        </Show>

        <Show when={erroredRequests().length > 0}>
          <div class="mb-2">
            <div class="text-xs text-slate-600 mb-1 flex justify-between items-center">
              <span>Errors ({erroredRequests().length}):</span>
              <button onClick={handleClearErrors} class="text-xs text-blue-600 hover:text-blue-800">Clear</button>
            </div>
            <For each={erroredRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-red-100 rounded mb-1">
                  <div class="font-medium">{request.description}</div>
                  <Show when={request.errorMessage}>
                    <div class="text-xs text-red-700 mt-1">{request.errorMessage}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!currentRequest() && queuedRequests().length === 0 && erroredRequests().length === 0}>
          <div class="text-sm text-slate-500 text-center py-2">All Operations Complete</div>
        </Show>
      </div>
    </Show>
  );
}
