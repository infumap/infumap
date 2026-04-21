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
import { NETWORK_STATUS_IN_PROGRESS } from "../../store/StoreProvider_General";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../constants";


export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();
  const hasUnacknowledgedErrors = () => store.general.hasUnacknowledgedNetworkErrors();

  const col = () => {
    if (hasUnacknowledgedErrors()) { return "#bb7373"; }
    const status = store.general.networkStatus.get();
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

  const inProgressRequests = () => store.general.inProgressNetworkRequests();
  const recentRequests = () => store.general.recentNetworkRequests();
  const queuedRequests = () => store.general.queuedNetworkRequests();
  const erroredRequests = () => store.general.erroredNetworkRequests();
  const hasUnacknowledgedErrors = () => store.general.hasUnacknowledgedNetworkErrors();
  const hasActivityRequests = () => inProgressRequests().length > 0 || recentRequests().length > 0;
  const activityHeading = () => {
    if (inProgressRequests().length > 0 && recentRequests().length > 0) {
      return `In Progress (${inProgressRequests().length} active, ${recentRequests().length} recent):`;
    }
    if (inProgressRequests().length > 0) {
      return `In Progress (${inProgressRequests().length}):`;
    }
    return `Recent Activity (${recentRequests().length}):`;
  };

  const formatRequest = (req: { description: string, itemId?: string, host?: string | null }) => {
    let suffix = "";
    if (req.itemId) {
      suffix = ` (${req.itemId.substring(0, 8)}...)`;
    }
    if (req.host) {
      try {
        suffix += ` @ ${new URL(req.host).host}`;
      } catch (_error) {
        suffix += ` @ ${req.host}`;
      }
    }
    return `${req.description}${suffix}`;
  };

  const handleAcknowledgeErrors = () => {
    store.general.acknowledgeNetworkErrors();
  };

  const handleClose = () => {
    store.overlay.networkOverlayVisible.set(false);
  };

  return (
    <Show when={store.overlay.networkOverlayVisible.get()}>
      <div class={`absolute rounded border-slate-500 border bg-white shadow-lg`}
        style={`top: 45px; right: 5px; min-width: 300px; max-width: 400px; ` +
          `padding: 12px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
        onMouseDown={(e: MouseEvent) => { e.stopPropagation(); }}
        onMouseMove={(e: MouseEvent) => { e.stopPropagation(); }}>
        <div class="flex justify-between items-start mb-2">
          <div class="font-bold text-sm">Network Status</div>
          <button onClick={handleClose} class="text-slate-500 hover:text-slate-700 text-lg leading-none cursor-pointer -mt-1">&times;</button>
        </div>

        <Show when={hasUnacknowledgedErrors() && erroredRequests().length > 0}>
          <div class="mb-3 text-xs text-red-700 bg-red-50 rounded px-2 py-2">
            Errors stay red until you acknowledge them here.
          </div>
        </Show>

        <Show when={erroredRequests().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1 flex justify-between items-center">
              <span>Errors ({erroredRequests().length}):</span>
              <button onClick={handleAcknowledgeErrors} class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">Acknowledge</button>
            </div>
            <For each={erroredRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-red-100 rounded mb-1">
                  <div class="font-medium">{formatRequest(request)}</div>
                  <Show when={request.errorMessage}>
                    <div class="text-xs text-red-700 mt-1">{request.errorMessage}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={hasActivityRequests()}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">{activityHeading()}</div>
            <For each={inProgressRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-slate-100 rounded mb-1 border border-slate-200">
                  {formatRequest(request)}
                </div>
              )}
            </For>
            <For each={recentRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-slate-50 text-slate-500 rounded mb-1 border border-slate-200">
                  <div class="flex justify-between items-center gap-3">
                    <span>{formatRequest(request)}</span>
                    <span class="text-[10px] uppercase tracking-[0.08em] text-slate-400 shrink-0">Recent</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={queuedRequests().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">Queue ({queuedRequests().length}):</div>
            <For each={queuedRequests()}>
              {(request) => (
                <div class="text-sm px-2 py-1 bg-yellow-100 rounded mb-1">{formatRequest(request)}</div>
              )}
            </For>
          </div>
        </Show>

        <Show when={inProgressRequests().length === 0 && recentRequests().length === 0 && queuedRequests().length === 0 && erroredRequests().length === 0}>
          <div class="text-sm text-slate-500 text-center py-2">All Operations Complete</div>
        </Show>
      </div>
    </Show>
  );
}
