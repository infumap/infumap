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

import { Component, For, JSX, Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useStore } from "../../store/StoreProvider";
import type { NetworkProblem, NetworkRequestInfo } from "../../store/StoreProvider_General";
import { itemState } from "../../store/ItemState";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { navigateToContainingPageOfItemAndFocus } from "../../layout/navigation";
import { NetworkStatusLevel, failReasonText, formatAgo, networkStatusSummary, plural, textSaveRetryText } from "./networkStatusSummary";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../constants";
import { commitActiveTextEdit } from "../../input/edit";
import { recheckExpiredSession } from "../../server";
import { logout } from "../Main";


// Quiet while all is well, in the colour of the other toolbar icons. Colour appears only when something is wrong,
// and the shape alone tells the levels apart, for colour-blind users.
const LEVEL_COLOR: { [level in NetworkStatusLevel]: string } = {
  ok: "#1f2937",
  busy: "#1f2937",
  warn: "#d97706",
  danger: "#b91c1c",
};

/**
 * A cloud, the usual sign for saved and synced: plain when ok, with dots cut out when busy, and amber with a slash
 * when the server can't be reached or a request is failing. Danger, when work is at risk, is the one loud state: a
 * filled badge. Cut-outs use a mask, so they show whatever is behind the icon.
 */
const NetworkStatusIcon = (props: { level: NetworkStatusLevel, sizePx: number }): JSX.Element => {
  const maskId = createUniqueId();
  const color = () => LEVEL_COLOR[props.level];
  return (
    <svg width={props.sizePx} height={props.sizePx} viewBox="0 0 24 24" aria-hidden="true">
      <Show when={props.level == "danger"} fallback={
        <>
          <mask id={maskId}>
            <rect width="24" height="24" fill="white" />
            <Show when={props.level == "busy"}>
              <circle cx="9.5" cy="14.6" r="1.35" fill="black" />
              <circle cx="13.25" cy="14.6" r="1.35" fill="black" />
              <circle cx="17" cy="14.6" r="1.35" fill="black" />
            </Show>
            <Show when={props.level == "warn"}>
              <line x1="4" y1="3" x2="21" y2="20" stroke="black" stroke-width="4.5" stroke-linecap="round" />
            </Show>
          </mask>
          <g fill={color()} mask={`url(#${maskId})`}>
            <circle cx="8.5" cy="13.5" r="4.5" />
            <circle cx="13" cy="10.5" r="6" />
            <circle cx="18" cy="14.5" r="3.5" />
            <rect x="8.5" y="12" width="9.5" height="6" />
          </g>
          <Show when={props.level == "warn"}>
            <line x1="4" y1="3" x2="21" y2="20" stroke={color()} stroke-width="2" stroke-linecap="round" />
          </Show>
        </>
      }>
        <circle cx="12" cy="12" r="9" fill={color()} />
        <path d="M12 7 V13" stroke="white" stroke-width="2.4" stroke-linecap="round" />
        <circle cx="12" cy="16.6" r="1.4" fill="white" />
      </Show>
    </svg>
  );
};

/** The toolbar indicator, whose own click toggles the dialog, so mouse_down leaves it alone. */
export const NETWORK_STATUS_INDICATOR_ID = "networkStatusIndicator";

export const Toolbar_NetworkStatus: Component = () => {
  const store = useStore();

  // Relative times in the tooltip are refreshed when the pointer arrives, rather than by a timer.
  const [hoverNowMs, setHoverNowMs] = createSignal(Date.now());
  const summary = () => networkStatusSummary(store, hoverNowMs());

  const handleClick = () => {
    store.overlay.networkOverlayVisible.set(!store.overlay.networkOverlayVisible.get());
  };

  return (
    // Sized and styled like InfuIconButton, the other toolbar icons. Not a <button>: a click would focus it, and a
    // later Space would toggle the dialog.
    <div role="button" id={NETWORK_STATUS_INDICATOR_ID}
      class="hover:border rounded w-[21px] h-[21px] inline-flex items-center justify-center align-middle cursor-pointer ml-[3px] hover:bg-slate-300 relative"
      title={summary().sentence}
      aria-label={`Network status: ${summary().sentence}`}
      onMouseEnter={() => setHoverNowMs(Date.now())}
      onClick={handleClick}>
      <NetworkStatusIcon level={summary().level} sizePx={20} />
    </div>
  );
}


const MAX_TITLE_CHARS = 48;
const LINK_CLASS = "text-xs text-blue-600 hover:text-blue-800 cursor-pointer";

// Kept for the session, so the activity list stays open while debugging. The dialog closes on a mouse down outside
// it, like the other toolbar popups (see mouse_down.ts).
let activityExpandedInitially = false;

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const Toolbar_NetworkStatus_Overlay: Component = () => {
  const store = useStore();

  const [nowMs, setNowMs] = createSignal(Date.now());
  const nowTimer = window.setInterval(() => setNowMs(Date.now()), 1000);
  onCleanup(() => window.clearInterval(nowTimer));
  const ago = (ms: number) => formatAgo(ms, nowMs());

  // An error message from before the dialog opened would cover its top, and says what the dialog shows anyway.
  // showFailedMutationMessage shows none while it is open.
  onMount(() => {
    if (store.overlay.toolbarTransientMessage.get()?.type == TransientMessageType.Error) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  });

  const summary = () => networkStatusSummary(store, nowMs());
  const pendingSaves = () => store.textEdit.pendingSaves();
  const writeProblems = () => store.general.networkProblems().filter(p => p.kind == "write");
  const otherProblems = () => store.general.networkProblems().filter(p => p.kind != "write");
  const inProgressRequests = () => store.general.inProgressNetworkRequests();
  const queuedRequests = () => store.general.queuedNetworkRequests();
  const recentRequests = () => store.general.recentNetworkRequests();

  const [activityExpanded, setActivityExpanded] = createSignal(activityExpandedInitially);
  const toggleActivity = () => {
    activityExpandedInitially = !activityExpanded();
    setActivityExpanded(activityExpandedInitially);
  };

  /** The item's title, if it is loaded and has one. */
  const itemTitle = (itemId: string | undefined): string | null => {
    const item = itemId == null ? null : itemState.get(itemId);
    if (item == null || !isTitledItem(item)) { return null; }
    const title = asTitledItem(item).title.trim().replace(/\s+/g, " ");
    if (title == "") { return "(untitled)"; }
    return title.length > MAX_TITLE_CHARS ? title.substring(0, MAX_TITLE_CHARS - 1) + "…" : title;
  };

  const hostName = (host: string): string => {
    try {
      return new URL(host).host;
    } catch (_error) {
      return host;
    }
  };

  const hostSuffix = (host: string | null | undefined): string => host ? ` @ ${hostName(host)}` : "";

  const requestLabel = (req: { description: string, itemId?: string, host?: string | null }) => {
    const title = itemTitle(req.itemId);
    return `${req.description}${title == null ? "" : ` · ${title}`}${hostSuffix(req.host)}`;
  };

  const goToItem = (itemId: string) => {
    void navigateToContainingPageOfItemAndFocus(store, itemId);
  };

  const ItemTitle = (props: { itemId?: string, fallback: string }): JSX.Element => {
    const title = () => itemTitle(props.itemId);
    return (
      <Show when={title() != null && props.itemId != null} fallback={<span class="font-medium">{props.fallback}</span>}>
        <button onClick={() => goToItem(props.itemId!)} title="Show this item"
          class="font-medium text-left hover:underline cursor-pointer">{title()}</button>
      </Show>
    );
  };

  const syncStatus = () => {
    if (store.general.syncPausedReason() == "text-edit") { return "paused while editing text"; }
    const failures = store.general.consecutiveSyncFailures();
    if (failures > 0) { return failures == 1 ? "failed" : `failed ${failures} times in a row`; }
    const lastOkMs = store.general.lastSyncOkMs();
    if (lastOkMs != null) { return `OK, ${ago(lastOkMs)}`; }
    return "not yet run";
  };

  const activityCounts = () => {
    const parts = [];
    if (inProgressRequests().length > 0) { parts.push(`${inProgressRequests().length} running`); }
    if (queuedRequests().length > 0) { parts.push(`${queuedRequests().length} queued`); }
    if (recentRequests().length > 0) { parts.push(`${recentRequests().length} recent`); }
    return parts.join(" · ");
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
    if (!window.confirm(`Discard unsaved text in ${plural(count, "item")} and log out?`)) { return; }
    // End the edit first, so the logout doesn't capture the editor's text again.
    commitActiveTextEdit(store);
    store.textEdit.clear();
    void logout!();
  };

  const handleClose = () => {
    store.overlay.networkOverlayVisible.set(false);
  };

  const SectionHeading = (props: { children: JSX.Element }): JSX.Element =>
    <div class="text-xs text-slate-600 mb-1 flex justify-between items-center">{props.children}</div>;

  const WriteProblemRow = (props: { problem: NetworkProblem }): JSX.Element => (
    <div class="text-sm px-2 py-1 bg-red-50 rounded mb-1">
      <div class="flex justify-between items-start gap-2">
        <ItemTitle itemId={props.problem.itemId} fallback={`${props.problem.description}${hostSuffix(props.problem.host)}`} />
        <span class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-slate-500">{ago(props.problem.lastMs)}</span>
          <button onClick={() => store.general.dismissNetworkProblem(props.problem.key)} title="Dismiss"
            class="text-slate-500 hover:text-slate-700 leading-none cursor-pointer">&times;</button>
        </span>
      </div>
      <div class="text-xs text-red-700" title={props.problem.message}>
        {itemTitle(props.problem.itemId) == null ? "Failed" : `${props.problem.description} failed`} because{" "}
        {props.problem.host == null
          ? `${failReasonText(props.problem.reason)}. Reverted to the server version.`
          : `${failReasonText(props.problem.reason, hostName(props.problem.host))}, so it is not saved there. ` +
            "Reload to see what it has."}
      </div>
    </div>
  );

  const ProblemRow = (props: { problem: NetworkProblem }): JSX.Element => (
    <div class="text-sm px-2 py-1 bg-amber-50 rounded mb-1">
      <div class="flex justify-between items-start gap-2">
        <span class="font-medium">{requestLabel(props.problem)}</span>
        <span class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-slate-500">
            {props.problem.count > 1 ? `×${props.problem.count} · ` : ""}{ago(props.problem.lastMs)}
          </span>
          <button onClick={() => store.general.dismissNetworkProblem(props.problem.key)} title="Dismiss"
            class="text-slate-500 hover:text-slate-700 leading-none cursor-pointer">&times;</button>
        </span>
      </div>
      <div class="text-xs text-amber-800" title={props.problem.message}>
        Failed because {failReasonText(props.problem.reason, props.problem.host ? hostName(props.problem.host) : undefined)}.
      </div>
    </div>
  );

  const ActivityRow = (props: { request: NetworkRequestInfo, detail: string, muted?: boolean }): JSX.Element => (
    <div class={`text-xs flex justify-between gap-3 ${props.muted ? "text-slate-400" : "text-slate-700"}`}
      title={props.request.itemId ?? ""}>
      <span class="truncate">{requestLabel(props.request)}</span>
      <span class="shrink-0">{props.detail}</span>
    </div>
  );

  return (
    <div class={TOOLBAR_POPUP_CLASS} role="dialog" aria-label="Network status"
      style={`top: ${toolbarPopupTopPx(store)}px; right: 5px; width: 360px; max-width: calc(100vw - 10px); ` +
        `padding: 10px 12px 9px 12px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
      onMouseDown={(e: MouseEvent) => { e.stopPropagation(); }}
      onMouseMove={(e: MouseEvent) => { e.stopPropagation(); }}>

      <div class="flex items-start gap-2 mb-3">
        <div class="shrink-0 -mt-[1px]"><NetworkStatusIcon level={summary().level} sizePx={20} /></div>
        <div class="flex-1 text-sm font-medium">{summary().sentence}</div>
        <button onClick={handleClose} title="Close (Esc)"
          class="text-slate-500 hover:text-slate-700 text-lg leading-none cursor-pointer -mt-1">&times;</button>
      </div>

      <Show when={pendingSaves().length > 0 || writeProblems().length > 0}>
        <div class="mb-3">
          <SectionHeading><span>Not saved ({pendingSaves().length + writeProblems().length})</span></SectionHeading>
          <For each={pendingSaves()}>
            {(save) => (
              <div class={`text-sm px-2 py-1 rounded mb-1 ${save.failed ? "bg-red-50" : "bg-slate-50"}`}>
                <ItemTitle itemId={save.itemId} fallback="Text" />
                <div class={`text-xs ${save.failed ? "text-red-700" : "text-slate-500"}`}>
                  {save.failed ? `Text not saved yet: ${failReasonText(save.reason)}.` : "Text not saved yet: saving…"}
                </div>
              </div>
            )}
          </For>
          <For each={writeProblems()}>
            {(problem) => <WriteProblemRow problem={problem} />}
          </For>
          <Show when={store.general.sessionExpired()} fallback={
            <Show when={store.textEdit.failedSaveCount() > 0}>
              <div class="flex items-baseline gap-2 mt-1">
                <span class="text-xs text-slate-600">{textSaveRetryText(store, nowMs())}</span>
                <button onClick={() => { void store.textEdit.flush(); }} class={LINK_CLASS}>Retry now</button>
              </div>
            </Show>
          }>
            <div class="text-xs text-red-700 mt-1">
              Your session has ended, so text can't be saved. Log in again in another tab, then come back to this
              one to save it.
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1">
              <button onClick={() => { window.open("/login", "_blank"); }} class={LINK_CLASS}>Open login in new tab</button>
              <button onClick={() => { void recheckExpiredSession(store); }} class={LINK_CLASS}>Retry now</button>
              <button onClick={handleCopyUnsavedText} class={LINK_CLASS}>{copied() ? "Copied" : "Copy unsaved text"}</button>
              <button onClick={handleDiscardAndLogout}
                class="text-xs text-red-700 hover:text-red-900 cursor-pointer">Discard and log out</button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={otherProblems().length > 0}>
        <div class="mb-3">
          <SectionHeading>
            <span>Problems ({otherProblems().length})</span>
            <button onClick={() => { for (const p of otherProblems()) { store.general.dismissNetworkProblem(p.key); } }}
              class={LINK_CLASS}>Dismiss all</button>
          </SectionHeading>
          <For each={otherProblems()}>
            {(problem) => <ProblemRow problem={problem} />}
          </For>
        </div>
      </Show>

      <div>
        <button onClick={toggleActivity} aria-expanded={activityExpanded()}
          class="w-full flex justify-between items-center text-xs text-slate-600 hover:text-slate-800 cursor-pointer">
          <span>{activityExpanded() ? "▾" : "▸"} Activity</span>
          <span class="text-slate-400">{activityCounts()}</span>
        </button>
        <div class="text-xs text-slate-500 mt-0.5 pl-[11px]">Background sync: {syncStatus()}</div>
        <Show when={activityExpanded()}>
          <div class="mt-1 pl-[11px] max-h-[180px] overflow-y-auto flex flex-col gap-0.5">
            <For each={inProgressRequests()}>
              {(request) => <ActivityRow request={request}
                detail={request.startedMs == null ? "" : formatDuration(nowMs() - request.startedMs)} />}
            </For>
            <For each={queuedRequests()}>
              {(request) => <ActivityRow request={request} detail="queued" />}
            </For>
            <For each={recentRequests()}>
              {(request) => <ActivityRow request={request} muted={true}
                detail={request.outcome == "cancelled" ? "cancelled"
                  : request.startedMs != null && request.endedMs != null ? formatDuration(request.endedMs - request.startedMs) : ""} />}
            </For>
            <Show when={inProgressRequests().length + queuedRequests().length + recentRequests().length == 0}>
              <div class="text-xs text-slate-400">No requests in the last few seconds.</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
