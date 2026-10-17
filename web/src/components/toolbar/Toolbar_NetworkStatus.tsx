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

import { TOOLBAR_POPUP_CLASS, toolbarPopupTopPx } from "./toolbarPopupStyle";

import { Component, For, JSX, Match, Show, Switch, createSignal, onCleanup } from "solid-js"
import { useStore } from "../../store/StoreProvider";
import { NetworkStatusLevel, failReasonText, formatAgo, networkStatusSummary, textSaveRetryText } from "./networkStatusSummary";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../constants";
import { commitActiveTextEdit } from "../../input/edit";
import { recheckExpiredSession } from "../../server";
import { logout } from "../Main";


// The glyph carries the level as well as the colour. ok and danger also differ clearly in luminance.
const LEVEL_STYLE: { [level in NetworkStatusLevel]: { background: string, glyph: string } } = {
  ok: { background: "#7bbb73", glyph: "#1e293b" },
  busy: { background: "#babb73", glyph: "#1e293b" },
  warn: { background: "#e0a040", glyph: "#1e293b" },
  danger: { background: "#a12b2b", glyph: "#ffffff" },
};

const LevelGlyph = (props: { level: NetworkStatusLevel, color: string }): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke={props.color} stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <Switch>
      <Match when={props.level == "ok"}><path d="M2.5 6.5 L5 9 L9.5 3.5" /></Match>
      <Match when={props.level == "busy"}>
        <circle cx="2.5" cy="6" r="1.1" fill={props.color} stroke="none" />
        <circle cx="6" cy="6" r="1.1" fill={props.color} stroke="none" />
        <circle cx="9.5" cy="6" r="1.1" fill={props.color} stroke="none" />
      </Match>
      <Match when={props.level == "warn"}>
        <path d="M6 2 V7" />
        <circle cx="6" cy="9.8" r="1" fill={props.color} stroke="none" />
      </Match>
      <Match when={props.level == "danger"}><path d="M3 3 L9 9 M9 3 L3 9" /></Match>
    </Switch>
  </svg>
);

export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();

  // Relative times in the tooltip are refreshed when the pointer arrives, rather than by a timer.
  const [hoverNowMs, setHoverNowMs] = createSignal(Date.now());
  const summary = () => networkStatusSummary(store, hoverNowMs());
  const style = () => LEVEL_STYLE[summary().level];

  const handleClick = () => {
    store.overlay.networkOverlayVisible.set(!store.overlay.networkOverlayVisible.get());
  };

  return (
    <div class="w-[21px] h-[21px] inline-block ml-[7px] mr-[-2px] relative">
      {/* Not a <button>: a click would focus it, and a later Space would toggle the dialog. */}
      <div role="button"
        class="w-[19px] h-[19px] mt-[7px] rounded border-slate-500 border cursor-pointer flex items-center justify-center"
        style={`background-color: ${style().background};`}
        title={summary().sentence}
        aria-label={`Network status: ${summary().sentence}`}
        onMouseEnter={() => setHoverNowMs(Date.now())}
        onClick={handleClick}>
        <LevelGlyph level={summary().level} color={style().glyph} />
      </div>
    </div>
  );
}


export const Toolbar_NetworkStatus_Overlay: Component = () => {
  const store = useStore();

  const inProgressRequests = () => store.general.inProgressNetworkRequests();
  const recentRequests = () => store.general.recentNetworkRequests();
  const queuedRequests = () => store.general.queuedNetworkRequests();
  const problems = () => store.general.networkProblems();

  const [nowMs, setNowMs] = createSignal(Date.now());
  const nowTimer = window.setInterval(() => setNowMs(Date.now()), 1000);
  onCleanup(() => window.clearInterval(nowTimer));

  const ago = (ms: number) => formatAgo(ms, nowMs());

  const syncStatus = () => {
    if (store.general.syncPausedReason() == "text-edit") { return "paused while editing text"; }
    const failures = store.general.consecutiveSyncFailures();
    if (failures > 0) { return failures == 1 ? "failed" : `failed ${failures} times in a row`; }
    const lastOkMs = store.general.lastSyncOkMs();
    if (lastOkMs != null) { return `OK, ${ago(lastOkMs)}`; }
    return "not yet run";
  };

  const failedSaveText = () => {
    const failed = store.textEdit.failedSaves();
    if (failed.length == 0) { return ""; }
    const what = failed.length == 1 ? "1 item could not be saved" : `${failed.length} items could not be saved`;
    return `${what}: ${failReasonText(failed[0].reason)}. ${textSaveRetryText(store, nowMs())}`;
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

  const [copied, setCopied] = createSignal(false);
  const handleCopyUnsavedText = async () => {
    try {
      await navigator.clipboard.writeText(store.textEdit.unsavedText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Could not copy unsaved text:", e);
    }
  };

  const handleDiscardAndLogout = () => {
    const count = store.textEdit.unsavedCount();
    if (!window.confirm(`Discard unsaved text in ${count == 1 ? "1 item" : `${count} items`} and log out?`)) { return; }
    // End the edit first, so the logout doesn't capture the editor's text again.
    commitActiveTextEdit(store);
    store.textEdit.clear();
    void logout!();
  };

  const handleClose = () => {
    store.overlay.networkOverlayVisible.set(false);
  };

  return (
    <Show when={store.overlay.networkOverlayVisible.get()}>
      <div class={TOOLBAR_POPUP_CLASS}
        style={`top: ${toolbarPopupTopPx(store)}px; right: 5px; min-width: 300px; max-width: 400px; ` +
          `padding: 12px 12px 9px 12px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
        onMouseDown={(e: MouseEvent) => { e.stopPropagation(); }}
        onMouseMove={(e: MouseEvent) => { e.stopPropagation(); }}>
        <div class="flex justify-between items-start mb-2">
          <div class="font-bold text-sm">Network Status</div>
          <button onClick={handleClose} class="text-slate-500 hover:text-slate-700 text-lg leading-none cursor-pointer -mt-1">&times;</button>
        </div>

        <Show when={store.textEdit.unsavedCount() > 0}>
          <div class="mb-3 text-sm px-2 py-2 bg-yellow-50 rounded">
            <div>{store.textEdit.unsavedCount()} item(s) with unsaved text changes</div>
            <Show when={store.general.sessionExpired()} fallback={
              <Show when={store.textEdit.failedSaveCount() > 0}>
                <div class="text-xs text-red-700 mt-1">{failedSaveText()}</div>
                <button onClick={() => { void store.textEdit.flush(); }}
                  class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer mt-1">Retry now</button>
              </Show>
            }>
              <div class="text-xs text-red-700 mt-1">
                Your session has ended, so this can't be saved. Log in again in another tab, then come back to this
                one to save it.
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                <button onClick={() => { window.open("/login", "_blank"); }}
                  class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">Open login in new tab</button>
                <button onClick={() => { void recheckExpiredSession(store); }}
                  class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">Retry now</button>
                <button onClick={handleCopyUnsavedText}
                  class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">{copied() ? "Copied" : "Copy unsaved text"}</button>
                <button onClick={handleDiscardAndLogout}
                  class="text-xs text-red-700 hover:text-red-900 cursor-pointer">Discard and log out</button>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!store.general.serverReachable()}>
          <div class="mb-3 text-sm text-red-700 bg-red-50 rounded px-2 py-2">Can't reach the server.</div>
        </Show>

        <Show when={problems().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1 flex justify-between items-center">
              <span>Problems ({problems().length}):</span>
              <button onClick={() => store.general.dismissAllNetworkProblems()}
                class="text-xs text-blue-600 hover:text-blue-800 cursor-pointer">Dismiss all</button>
            </div>
            <For each={problems()}>
              {(problem) => (
                <div class="text-sm px-2 py-1 bg-red-100 rounded mb-1">
                  <div class="flex justify-between items-start gap-2">
                    <span class="font-medium">{formatRequest(problem)}</span>
                    <span class="flex items-center gap-2 shrink-0">
                      <Show when={problem.kind == "write"}>
                        <span class="text-[10px] uppercase tracking-[0.08em] text-red-700">Not saved</span>
                      </Show>
                      <span class="text-xs text-slate-500">
                        {problem.count > 1 ? `×${problem.count} · ` : ""}{ago(problem.lastMs)}
                      </span>
                      <button onClick={() => store.general.dismissNetworkProblem(problem.key)}
                        class="text-slate-500 hover:text-slate-700 leading-none cursor-pointer">&times;</button>
                    </span>
                  </div>
                  <div class="text-xs text-red-700 mt-1">{problem.message}</div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={inProgressRequests().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">In progress ({inProgressRequests().length}):</div>
            <div class="max-h-[132px] overflow-y-auto pr-1 flex flex-col gap-1">
              <For each={inProgressRequests()}>
                {(request) => (
                  <div class="text-sm px-2 py-1 bg-slate-100 rounded border border-slate-200">
                    {formatRequest(request)}
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={recentRequests().length > 0}>
          <div class="mb-3">
            <div class="text-xs text-slate-600 mb-1">Recent ({recentRequests().length}):</div>
            <div class="max-h-[132px] overflow-y-auto pr-1 flex flex-col gap-1">
              <For each={recentRequests()}>
                {(request) => (
                  <div class="text-sm px-2 py-1 bg-slate-50 text-slate-500 rounded border border-slate-200">
                    <div class="flex justify-between items-center gap-3">
                      <span>{formatRequest(request)}</span>
                      <Show when={request.outcome == "cancelled"}>
                        <span class="text-[10px] uppercase tracking-[0.08em] text-slate-400 shrink-0">Cancelled</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
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

        <Show when={store.textEdit.unsavedCount() === 0 && inProgressRequests().length === 0 && recentRequests().length === 0 && queuedRequests().length === 0 && problems().length === 0}>
          <div class="text-sm text-slate-500 text-center py-2">All Operations Complete</div>
        </Show>

        <div class="text-xs text-slate-500">Background sync: {syncStatus()}</div>
      </div>
    </Show>
  );
}
