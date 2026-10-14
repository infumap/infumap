/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { getQueryRuntime, QUERY_PROFILE_ROW_HEIGHT_PX, type QueryItem } from "../../items/query-item";
import { cloneQueryConfiguration, queryConfigurationsEqual, snapshotQueryProfile, type QueryProfile } from "../../items/query-configuration";
import { applyQueryProfile, isQueryConfigurationModified, queryConfigurationChangeBlockedReason, resetQueryConfiguration } from "../../items/query-configuration-state";
import { queryScopeName, queryScopeSummary, queryScopes, queryScopesLoading, refreshQueryScopes } from "../../items/query-scope";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover, stopQueryPickerEvent } from "./QueryPickerPopover";
import { QueryProfileManager, type QueryProfileManagementAction, type QueryProfileSaveContext } from "./QueryProfileManager";
import { queryConfigurationIssues, refreshQueryConfigurationAvailability } from "../../items/query-configuration-availability";

interface QueryProfileBarProps {
  queryItem: () => QueryItem,
  searchMode: () => boolean,
  disabled?: () => boolean,
  blockedReason?: () => string | null,
  beforeChange?: () => void,
  onChange?: (scopeChanged: boolean) => void,
  barRef?: (el: HTMLDivElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

export function QueryProfileBar(props: QueryProfileBarProps) {
  const store = useStore();
  let bar: HTMLDivElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  const [management, setManagement] = createSignal<QueryProfileManagementAction | null>(null);
  onMount(() => {
    void store.general.queryProfiles.retrieve();
    void store.general.retrieveChatBackends();
    if (queryScopes() == null) { void refreshQueryScopes(store); }
  });
  const collection = createMemo(() => store.general.queryProfiles.collection());
  const profiles = () => collection()?.profiles ?? [];
  const pinned = createMemo(() => (collection()?.preferences.pinnedProfileIds ?? [])
    .map(id => profiles().find(profile => profile.id == id))
    .filter((profile): profile is QueryProfile => profile != null));
  const others = createMemo(() => profiles().filter(profile => !pinned().some(pin => pin.id == profile.id)));
  const runtime = () => getQueryRuntime(store, props.queryItem());
  const issues = (profile: QueryProfile) => queryConfigurationIssues(store, profile.configuration, props.searchMode() ? "search" : "chat");
  const currentIssues = () => runtime().configurationInitialized
    ? queryConfigurationIssues(store, runtime().configuration, props.searchMode() ? "search" : "chat") : [];
  const activeIssues = () => currentIssues().filter(issue => issue.active);
  const unavailable = () => activeIssues().some(issue => issue.status == "unavailable");
  const applied = () => runtime().appliedProfile;
  const savedApplied = () => profiles().find(profile => profile.id == applied()?.id);
  const savedProfileChanged = () => applied() != null && savedApplied() != null &&
    (applied()!.name != savedApplied()!.name || !queryConfigurationsEqual(applied()!.configuration, savedApplied()!.configuration));
  const modified = () => isQueryConfigurationModified(store, props.queryItem());
  const selected = (profile: QueryProfile) => applied()?.id == profile.id &&
    queryConfigurationsEqual(runtime().configuration, profile.configuration);
  const unpinnedApplied = () => applied() != null && !pinned().some(profile => profile.id == applied()!.id);
  const moreLabel = () => collection() == null ? "Profiles" : unpinnedApplied() ? `More · ${applied()!.name}` : "More";
  const scopeLabel = (profile: QueryProfile) => profile.configuration.scopeId != null &&
    queryScopeSummary(profile.configuration.scopeId) === undefined
    ? profile.configuration.scopeId : queryScopeName(profile.configuration.scopeId);
  const modelLabel = (profile: QueryProfile) => {
    const model = profile.configuration.model;
    if (model == null) { return "Not selected"; }
    const provider = store.general.chatBackends()?.backends.find(backend => backend.id == model.backend);
    const name = provider?.models.find(info => info.id == model.model)?.name ?? model.model ?? "Server-selected";
    return `${name} / ${provider?.label ?? model.backend}${model.reasoningEffort == null ? "" : ` · ${model.reasoningEffort}`}`;
  };
  const toolsLabel = (profile: QueryProfile) => profile.configuration.capabilities.length == 0 ? "None"
    : profile.configuration.capabilities.map(id => id == "infumap_data" ? "Infumap"
      : store.general.chatBackends()?.toolServers?.find(server => server.id == id)?.label ?? id).join(" + ");
  const reason = (): string | null => {
    const blockedReason = props.blockedReason?.() ?? queryConfigurationChangeBlockedReason(store, props.queryItem());
    if (blockedReason != null) { return blockedReason; }
    if (props.disabled?.()) { return "Wait for the current response to finish."; }
    return null;
  };
  const currentBlockedReason = () => reason() ?? (!runtime().configurationInitialized ? "Wait for this query's setup to load." : null);
  const captureCurrent = (): QueryProfileSaveContext => {
    props.beforeChange?.();
    const current = runtime();
    return { queryId: props.queryItem().id, accountId: store.user.getUserMaybe()?.userId ?? null,
      configuration: cloneQueryConfiguration(current.configuration),
      appliedProfile: current.appliedProfile == null ? null : snapshotQueryProfile(current.appliedProfile) };
  };
  const acceptSavedProfile = (profile: QueryProfile, context: QueryProfileSaveContext): boolean => {
    const current = runtime();
    if (props.queryItem().id != context.queryId || (store.user.getUserMaybe()?.userId ?? null) != context.accountId ||
      reason() != null || !queryConfigurationsEqual(current.configuration, context.configuration)) { return false; }
    const baseline = current.appliedProfile;
    if (baseline == null || context.appliedProfile == null) {
      if (baseline !== context.appliedProfile) { return false; }
    } else if (baseline.id != context.appliedProfile.id || baseline.name != context.appliedProfile.name ||
      !queryConfigurationsEqual(baseline.configuration, context.appliedProfile.configuration)) { return false; }
    applyQueryProfile(store, props.queryItem(), profile);
    return true;
  };
  const reset = () => {
    const baseline = applied();
    if (baseline == null || reason() != null) { return; }
    const previousScope = runtime().configuration.scopeId;
    props.beforeChange?.();
    if (resetQueryConfiguration(store, props.queryItem())) { props.onChange?.(previousScope != runtime().configuration.scopeId); }
    queueMicrotask(() => closeButton?.focus());
  };
  const summary = (profile: QueryProfile) => <>
    <div class="break-words text-[11px] text-slate-500">Scope: {scopeLabel(profile)}</div>
    <div class="break-words text-[11px] text-slate-500">Model: {modelLabel(profile)}</div>
    <div class="break-words text-[11px] text-slate-500">Tools: {toolsLabel(profile)}</div>
    <For each={issues(profile)}>{issue => <div class="break-words text-[11px]" classList={{ "text-amber-700": issue.active, "text-slate-400": !issue.active }}>
      {issue.message}{issue.active ? "" : ` (${props.searchMode() && issue.resource != "scope" ? "Not used for Search" : "Scope is not used while Infumap tools are off"})`}
    </div>}</For>
  </>;
  const profileTitle = (profile: QueryProfile) => [profile.name, `Scope: ${scopeLabel(profile)}`,
    `Model: ${modelLabel(profile)}`, `Tools: ${toolsLabel(profile)}`,
    ...issues(profile).map(issue => `${issue.message}${issue.active ? "" : " (not used)"}`),
    props.searchMode() ? "Search uses only scope." : "Changes apply from the next message. Earlier answers and context stay in this chat.", reason()].filter(Boolean).join("\n");
  const select = (profile: QueryProfile, close?: () => void) => {
    if (reason() != null) { return; }
    const previousScope = runtime().configuration.scopeId;
    props.beforeChange?.();
    applyQueryProfile(store, props.queryItem(), profile);
    close?.();
    props.onChange?.(previousScope != profile.configuration.scopeId);
  };
  const barKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key == "Tab") { props.onTabKey?.(ev); return; }
    if (ev.key != "ArrowLeft" && ev.key != "ArrowRight") { return; }
    const buttons = Array.from(bar?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const index = buttons.indexOf(ev.currentTarget as HTMLButtonElement);
    if (index < 0) { return; }
    ev.preventDefault();
    buttons[(index + (ev.key == "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };
  const rows = (choices: () => QueryProfile[], close: () => void, isPinned: boolean) => <For each={choices()}>{profile =>
    <button type="button" role="radio" aria-checked={selected(profile)}
      data-picker-autofocus={selected(profile) && !isPinned ? true : undefined} disabled={reason() != null}
      class="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-slate-100 disabled:cursor-default disabled:opacity-50"
      onClick={() => select(profile, close)}>
      <div class="min-w-0 grow">
        <div class="break-words text-[13px] font-medium">{profile.name}</div>
        {summary(profile)}
      </div>
      <Show when={selected(profile)}><i class="bi-check-lg shrink-0 text-slate-700" /></Show>
    </button>
  }</For>;

  return <div ref={el => { bar = el; props.barRef?.(el); }}
    class="flex min-w-0 items-center gap-2 text-[12px] text-[#555]" style={`height: ${QUERY_PROFILE_ROW_HEIGHT_PX}px;`} role="group" aria-label="Query profiles"
    onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent} onClick={stopQueryPickerEvent}>
    <span class="shrink-0" title={applied() == null ? "Choose a saved setup" : `Applied profile: ${applied()!.name}`}>Profile:</span>
    <Show when={modified()}><span class="shrink-0 text-[11px] text-amber-700" title="This query has changes to its applied profile.">Modified</span></Show>
    <Show when={activeIssues().length > 0}><span role="status" class="shrink-0 text-[11px]" classList={{ "text-red-700": unavailable(), "text-amber-700": !unavailable() }}
      title={activeIssues().map(issue => issue.message).join("\n")}>{unavailable() ? "Unavailable" : activeIssues().some(issue => issue.status == "unverified") ? "Unverified" : activeIssues().some(issue => issue.status == "warning") ? "Scope warning" : "Checking…"}</span></Show>
    <div class="flex min-w-0 items-center gap-1 overflow-x-auto" style="scrollbar-width: none;">
      <For each={pinned()}>{profile => <button type="button" aria-pressed={selected(profile)}
        disabled={reason() != null} title={profileTitle(profile)}
        class="h-[24px] max-w-[180px] shrink-0 cursor-pointer truncate rounded-md border px-2 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-50"
        classList={{ "border-slate-500 bg-slate-100 text-slate-900": selected(profile), "border-[#d6d6d6] bg-white hover:bg-slate-50": !selected(profile) }}
        onClick={() => select(profile)} onKeyDown={barKeyDown}>{profile.name}
        <Show when={issues(profile).some(issue => issue.active && issue.status == "unavailable")}><i class="bi-exclamation-triangle ml-1 text-[10px] text-amber-600" /></Show>
      </button>}</For>
    </div>
    <QueryPickerPopover buttonClass="max-w-[35%] shrink-0 cursor-pointer" width={440}
      ariaLabel="Choose a query profile" title={unpinnedApplied() ? `Applied profile: ${applied()!.name}. Choose from saved profiles.` : "More query profiles"}
      label={<><span class="min-w-0 truncate">{moreLabel()}</span>
        <Show when={store.general.queryProfiles.error()}><i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" /></Show></>} onTabKey={props.onTabKey}
      onOpen={() => { setManagement(null); void store.general.queryProfiles.refresh(); void refreshQueryScopes(store); void store.general.retrieveChatBackends(); }}>
      {close => <>
        <div class="max-h-[220px] overflow-y-auto border-b border-slate-200 px-3 py-2">
          <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">Query profiles
            <button ref={closeButton} type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close profile picker" onClick={close}><i class="bi-x-lg" /></button>
          </div>
          <div class="text-[11px] text-slate-500">{props.searchMode()
            ? "Search uses only scope. Model and tools are saved for Chat."
            : "Apply scope, model and tools from the next message. Chat mode stays unchanged."}</div>
          <Show when={!props.searchMode()}><div class="text-[11px] text-slate-500">Earlier answers and retrieved context stay in this chat.</div></Show>
          <Show when={reason()}><div class="mt-1 text-[11px] text-slate-500">{reason()}</div></Show>
          <For each={currentIssues()}>{issue => <div class="mt-1 break-words text-[11px]" classList={{ "text-amber-700": issue.active, "text-slate-400": !issue.active }}>
            {issue.message}{issue.active ? "" : " (not used for this operation)"}
          </div>}</For>
          <Show when={currentIssues().length > 0}><button type="button" class="mt-1 text-[11px] text-blue-700 hover:underline" disabled={store.general.chatBackendsRefreshing() || queryScopesLoading()}
            onClick={() => { void refreshQueryConfigurationAvailability(store); }}>Refresh availability</button></Show>
          <Show when={applied() != null}>
            <div class="mt-1 break-words text-[11px] text-slate-500">Current setup: {applied()!.name}{modified() ? " · Modified" : ""}</div>
          </Show>
          <Show when={collection() != null && applied() != null && savedApplied() == null}>
            <div class="mt-1 text-[11px] text-amber-700">This profile was deleted. Its applied settings are still in use.</div>
          </Show>
          <Show when={savedProfileChanged()}>
            <div class="mt-1 text-[11px] text-amber-700">The saved profile has changed. Select it to apply the latest settings.</div>
          </Show>
        </div>
        <Show when={management()} keyed fallback={<>
          <Show when={modified()}>
            <div class="shrink-0 border-b border-slate-200 px-3 py-2">
              <div class="mb-1 text-[11px] text-slate-500">Changes apply only to this query until you save them.</div>
              <div class="flex items-center gap-2 text-[12px]">
                <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                  disabled={applied() == null || reason() != null} title={applied() == null ? "No applied profile" : reason() ?? "Restore the profile as originally applied"}
                  onClick={reset}>Reset</button>
                <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                  disabled={savedApplied() == null || currentBlockedReason() != null}
                  title={savedApplied() == null ? "The saved profile was deleted. Save as a new profile instead." : currentBlockedReason() ?? "Update the saved profile with this query's settings"}
                  onClick={() => setManagement("saveChanges")}>Save changes…</button>
              </div>
            </div>
          </Show>
          <div class="min-h-0 grow overflow-y-auto py-1">
            <Show when={store.general.queryProfiles.error()}>
              <div class="px-3 py-2 text-[12px] text-red-700">{store.general.queryProfiles.error()}
                <button type="button" class="ml-2 underline" disabled={store.general.queryProfiles.loading()} onClick={() => { void store.general.queryProfiles.refresh(); }}>Retry</button>
              </div>
            </Show>
            <Show when={collection() == null && store.general.queryProfiles.error() == null}>
              <div class="px-3 py-2 text-[12px] text-slate-500">{store.general.queryProfiles.loading() ? "Loading profiles…" : "Sign in to use saved profiles."}</div>
            </Show>
            <div role="radiogroup" aria-label="Saved profiles">
              {rows(others, close, false)}
              <Show when={pinned().length > 0}>
                <div class="border-t border-slate-200 px-3 pt-2 text-[11px] text-slate-500">Pinned profiles</div>
                {rows(pinned, close, true)}
              </Show>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2 text-[12px]">
            <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
              disabled={collection() == null || currentBlockedReason() != null} title={currentBlockedReason() ?? "Save this query's scope, model and tools"}
              onClick={() => setManagement("saveAs")}>Save as profile…</button>
            <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
              disabled={collection() == null} onClick={() => setManagement("manage")}>Manage profiles</button>
          </div>
        </>}>
          {action => <QueryProfileManager initialAction={action} captureCurrent={captureCurrent} currentBlockedReason={currentBlockedReason}
            onSaved={acceptSavedProfile} summary={summary}
            onBack={() => { setManagement(null); queueMicrotask(() => closeButton?.focus()); }} />}
        </Show>
      </>}
    </QueryPickerPopover>
  </div>;
}
