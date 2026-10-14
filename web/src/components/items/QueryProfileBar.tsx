/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { getQueryRuntime, QUERY_PROFILE_ROW_HEIGHT_PX, type QueryItem } from "../../items/query-item";
import { cloneQueryConfiguration, queryConfigurationsEqual, snapshotQueryProfile, type QueryProfile } from "../../items/query-configuration";
import { applyQueryProfile, isQueryConfigurationModified, resetQueryConfiguration } from "../../items/query-configuration-state";
import { queryScopeName, queryScopeSummary, queryScopes, refreshQueryScopes } from "../../items/query-scope";
import { useStore } from "../../store/StoreProvider";
import { QueryPickerPopover, stopQueryPickerEvent } from "./QueryPickerPopover";
import { QueryProfileManager, type QueryProfileManagementAction, type QueryProfileSaveContext } from "./QueryProfileManager";

interface QueryProfileBarProps {
  queryItem: () => QueryItem,
  searchMode: () => boolean,
  disabled?: () => boolean,
  blockedReason?: () => string | null,
  /** Until tool changes between turns are supported, only matching tool sets can be applied. */
  toolsLocked?: () => boolean,
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
    if (queryScopes() == null) { void refreshQueryScopes(store); }
  });
  const collection = createMemo(() => store.general.queryProfiles.collection());
  const profiles = () => collection()?.profiles ?? [];
  const pinned = createMemo(() => (collection()?.preferences.pinnedProfileIds ?? [])
    .map(id => profiles().find(profile => profile.id == id))
    .filter((profile): profile is QueryProfile => profile != null));
  const others = createMemo(() => profiles().filter(profile => !pinned().some(pin => pin.id == profile.id)));
  const runtime = () => getQueryRuntime(store, props.queryItem());
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
  const reason = (profile: QueryProfile): string | null => {
    const blockedReason = props.blockedReason?.();
    if (blockedReason != null) { return blockedReason; }
    if (props.disabled?.()) { return "Wait for the current response to finish."; }
    if (props.toolsLocked?.()) {
      const current = new Set(runtime().configuration.capabilities);
      const next = new Set(profile.configuration.capabilities);
      if (current.size != next.size || [...current].some(id => !next.has(id))) {
        return "This profile changes tools. Tool choices are fixed for this chat.";
      }
    }
    return null;
  };
  const currentBlockedReason = () => props.blockedReason?.() ?? (props.disabled?.() ? "Wait for the current response to finish."
    : !runtime().configurationInitialized ? "Wait for this query's setup to load." : null);
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
      reason(profile) != null || !queryConfigurationsEqual(current.configuration, context.configuration)) { return false; }
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
    if (baseline == null || reason(baseline) != null) { return; }
    const previousScope = runtime().configuration.scopeId;
    props.beforeChange?.();
    if (resetQueryConfiguration(store, props.queryItem())) { props.onChange?.(previousScope != runtime().configuration.scopeId); }
    queueMicrotask(() => closeButton?.focus());
  };
  const summary = (profile: QueryProfile) => <>
    <div class="break-words text-[11px] text-slate-500">Scope: {scopeLabel(profile)}</div>
    <div class="break-words text-[11px] text-slate-500">Model: {modelLabel(profile)}</div>
    <div class="break-words text-[11px] text-slate-500">Tools: {toolsLabel(profile)}</div>
  </>;
  const profileTitle = (profile: QueryProfile) => [profile.name, `Scope: ${scopeLabel(profile)}`,
    `Model: ${modelLabel(profile)}`, `Tools: ${toolsLabel(profile)}`,
    props.searchMode() ? "Search uses only scope." : null, reason(profile)].filter(Boolean).join("\n");
  const select = (profile: QueryProfile, close?: () => void) => {
    if (reason(profile) != null) { return; }
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
      data-picker-autofocus={selected(profile) && !isPinned ? true : undefined} disabled={reason(profile) != null}
      class="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-slate-100 disabled:cursor-default disabled:opacity-50"
      onClick={() => select(profile, close)}>
      <div class="min-w-0 grow">
        <div class="break-words text-[13px] font-medium">{profile.name}</div>
        {summary(profile)}
        <Show when={reason(profile)}><div class="mt-1 text-[11px] text-amber-700">{reason(profile)}</div></Show>
      </div>
      <Show when={selected(profile)}><i class="bi-check-lg shrink-0 text-slate-700" /></Show>
    </button>
  }</For>;

  return <div ref={el => { bar = el; props.barRef?.(el); }}
    class="flex min-w-0 items-center gap-2 text-[12px] text-[#555]" style={`height: ${QUERY_PROFILE_ROW_HEIGHT_PX}px;`} role="group" aria-label="Query profiles"
    onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent} onClick={stopQueryPickerEvent}>
    <span class="shrink-0" title={applied() == null ? "Choose a saved setup" : `Applied profile: ${applied()!.name}`}>Profile:</span>
    <Show when={modified()}><span class="shrink-0 text-[11px] text-amber-700" title="This query has changes to its applied profile.">Modified</span></Show>
    <div class="flex min-w-0 items-center gap-1 overflow-x-auto" style="scrollbar-width: none;">
      <For each={pinned()}>{profile => <button type="button" aria-pressed={selected(profile)}
        disabled={reason(profile) != null} title={profileTitle(profile)}
        class="h-[24px] max-w-[180px] shrink-0 cursor-pointer truncate rounded-md border px-2 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-50"
        classList={{ "border-slate-500 bg-slate-100 text-slate-900": selected(profile), "border-[#d6d6d6] bg-white hover:bg-slate-50": !selected(profile) }}
        onClick={() => select(profile)} onKeyDown={barKeyDown}>{profile.name}</button>}</For>
    </div>
    <QueryPickerPopover buttonClass="max-w-[35%] shrink-0 cursor-pointer" width={440}
      ariaLabel="Choose a query profile" title={unpinnedApplied() ? `Applied profile: ${applied()!.name}. Choose from saved profiles.` : "More query profiles"}
      label={<><span class="min-w-0 truncate">{moreLabel()}</span>
        <Show when={store.general.queryProfiles.error()}><i class="bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" /></Show></>} onTabKey={props.onTabKey}
      onOpen={() => { setManagement(null); void store.general.queryProfiles.refresh(); void refreshQueryScopes(store); void store.general.retrieveChatBackends(); }}>
      {close => <>
        <div class="shrink-0 border-b border-slate-200 px-3 py-2">
          <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">Query profiles
            <button ref={closeButton} type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close profile picker" onClick={close}><i class="bi-x-lg" /></button>
          </div>
          <div class="text-[11px] text-slate-500">{props.searchMode()
            ? "Search uses only scope. Model and tools are saved for Chat."
            : "Apply scope, model and tools together. Chat mode stays unchanged."}</div>
          <Show when={props.disabled?.()}><div class="mt-1 text-[11px] text-slate-500">Wait for the current response to finish.</div></Show>
          <Show when={props.blockedReason?.()}><div class="mt-1 text-[11px] text-slate-500">{props.blockedReason?.()}</div></Show>
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
                  disabled={applied() == null || reason(applied()!) != null} title={applied() == null ? "No applied profile" : reason(applied()!) ?? "Restore the profile as originally applied"}
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
