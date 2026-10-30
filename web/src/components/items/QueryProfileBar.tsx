/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { getQueryRuntime, QUERY_PROFILE_ROW_HEIGHT_PX, type QueryItem } from "../../items/query-item";
import { cloneQueryConfiguration, queryConfigurationsEqual, type QueryConfiguration, type QueryProfile } from "../../items/query-configuration";
import {
  appliedSavedProfile, applyQueryProfile, isQueryConfigurationModified, queryConfigurationChangeBlockedReason,
} from "../../items/query-configuration-state";
import { queryConfigurationIssues } from "../../items/query-configuration-availability";
import { queryConfigurationSummary, queryModelRouteLabel, queryToolsLabel } from "../../items/query-configuration-labels";
import { describeQueryScopeItems, queryScopeItemTitle, queryScopeName, queryScopes, refreshQueryScopes } from "../../items/query-scope";
import { readQueryProfileNote } from "../../items/query-profile-note";
import { useStore } from "../../store/StoreProvider";
import { TransientMessageType } from "../../store/StoreProvider_Overlay";
import { QueryPickerPopover, stopQueryPickerEvent } from "./QueryPickerPopover";
import { QueryProfileManager, profileNameProblem } from "./QueryProfileManager";
import { QueryProfileNotePicker } from "./QueryProfileNotePicker";
import type { Uid } from "../../util/uid";

interface QueryProfileBarProps {
  queryItem: () => QueryItem,
  /** Search uses only the scope, so the bar is hidden. */
  searchMode: () => boolean,
  disabled?: () => boolean,
  blockedReason?: () => string | null,
  beforeChange?: () => void,
  composerText: () => string,
  onApplyQuery: (query: string) => void,
  onChange?: (scopeChanged: boolean) => void,
  barRef?: (el: HTMLDivElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

const CHIP_GAP_PX = 4;
const chipClass = "flex h-[24px] max-w-[180px] shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-50";
const actionClass = "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-40";

/**
 * One-click shortcuts with a modified indicator, and a menu of every profile and save actions.
 * Chips that do not fit move into the menu; the applied profile always stays visible.
 */
export function QueryProfileBar(props: QueryProfileBarProps) {
  const store = useStore();
  let measure: HTMLDivElement | undefined;
  // The row only exists outside Search mode, so its size is observed whenever it is created.
  const [row, setRow] = createSignal<HTMLDivElement>();
  const [managing, setManaging] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newQueryNoteId, setNewQueryNoteId] = createSignal<Uid | null>(null);
  const [noteLoading, setNoteLoading] = createSignal(false);
  const [rowWidth, setRowWidth] = createSignal(0);
  const [widths, setWidths] = createSignal<{ chips: Map<string, number>, menu: number }>({ chips: new Map(), menu: 0 });

  onMount(() => {
    void store.general.queryProfiles.retrieve();
    void store.general.retrieveChatBackends();
    if (queryScopes() == null) { void refreshQueryScopes(store); }
  });
  createEffect(() => {
    const element = row();
    if (element == null) { return; }
    const observer = new ResizeObserver(() => setRowWidth(element.clientWidth));
    observer.observe(element);
    onCleanup(() => { observer.disconnect(); setRowWidth(0); });
  });

  const collection = () => store.general.queryProfiles.collection();
  const profiles = () => collection()?.profiles ?? [];
  const pinnedIds = createMemo(() => new Set(collection()?.preferences.pinnedProfileIds ?? []));
  const pinned = () => profiles().filter(profile => pinnedIds().has(profile.id));
  const runtime = () => getQueryRuntime(store, props.queryItem());
  const active = () => appliedSavedProfile(store, props.queryItem());
  const isActive = (profile: QueryProfile) => active()?.id == profile.id;
  const modified = () => isQueryConfigurationModified(store, props.queryItem());
  const mode = () => props.searchMode() ? "search" : "chat";
  const unavailable = (profile: QueryProfile) => queryConfigurationIssues(store, profile.configuration, mode())
    .filter(issue => issue.active && issue.status == "unavailable");
  const reason = (): string | null => props.blockedReason?.() ?? queryConfigurationChangeBlockedReason(store, props.queryItem())
    ?? (props.disabled?.() ? "Wait for the current response to finish." : null);
  const saveBlockedReason = () => reason() ?? (!runtime().configurationInitialized ? "Wait for this query's setup to load." : null);

  const showError = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    store.overlay.toolbarTransientMessage.set({ text, type: TransientMessageType.Error });
    window.setTimeout(() => { if (store.overlay.toolbarTransientMessage.get()?.text == text) { store.overlay.toolbarTransientMessage.set(null); } }, 3000);
  };
  let noteRequest = 0;
  onCleanup(() => noteRequest++);
  const fillQueryTemplate = async (profile: QueryProfile) => {
    const request = ++noteRequest;
    const noteId = profile.queryNoteId;
    if (noteId == null || props.composerText().trim() != "") { return; }
    const owner = store.user.getUserMaybe()?.userId;
    const itemId = props.queryItem().id;
    const stillSelected = () => request == noteRequest && props.queryItem().id == itemId &&
      store.user.getUserMaybe()?.userId == owner && runtime().appliedProfile?.id == profile.id &&
      runtime().appliedProfile?.queryNoteId == noteId && reason() == null;
    try {
      const text = await readQueryProfileNote(noteId);
      // Reading a note is asynchronous. A late response must not replace typing or a newer selection.
      if (stillSelected() && props.composerText().trim() == "") { props.onApplyQuery(text); }
    } catch {
      if (stillSelected() && props.composerText().trim() == "") {
        showError("Could not read the template note. It may have been deleted or be inaccessible.");
      }
    }
  };
  const initializedDrafts = new Set<Uid>();
  createEffect(() => {
    const current = runtime();
    const itemId = props.queryItem().id;
    if (initializedDrafts.has(itemId) || !current.configurationInitialized) { return; }
    initializedDrafts.add(itemId);
    if (current.mode == null && current.appliedProfile != null) {
      untrack(() => { void fillQueryTemplate(current.appliedProfile!); });
    }
  });
  createEffect(() => {
    void describeQueryScopeItems(profiles().flatMap(profile => profile.queryNoteId == null ? [] : [profile.queryNoteId]));
  });
  const run = async (action: () => Promise<void>) => {
    if (busy()) { return; }
    setBusy(true);
    try { await action(); } catch (error) { showError(error); } finally { setBusy(false); }
  };

  const apply = (profile: QueryProfile) => {
    if (reason() != null) { return; }
    const previousScope = runtime().configuration.scopeId;
    props.beforeChange?.();
    applyQueryProfile(store, props.queryItem(), profile);
    void fillQueryTemplate(profile);
    props.onChange?.(previousScope != profile.configuration.scopeId);
  };
  /** A saved setup becomes this query's applied profile, unless the query changed while saving. */
  const adopt = (profile: QueryProfile, configuration: QueryConfiguration) => {
    if (reason() != null || !queryConfigurationsEqual(runtime().configuration, configuration)) { return; }
    applyQueryProfile(store, props.queryItem(), profile);
  };
  const saveToActive = (close: () => void) => {
    const profile = active();
    if (profile == null || !modified() || saveBlockedReason() != null) { return; }
    const configuration = cloneQueryConfiguration(runtime().configuration);
    void run(async () => {
      adopt(await store.general.queryProfiles.setConfiguration(profile.id, configuration), configuration);
      close();
    });
  };
  /** New profiles are pinned, so the setup just saved is one click away. */
  const saveAsNew = (ev: SubmitEvent, close: () => void) => {
    ev.preventDefault();
    const problem = profileNameProblem(newName());
    if (problem != null) { showError(problem); return; }
    if (saveBlockedReason() != null || noteLoading()) { return; }
    const configuration = cloneQueryConfiguration(runtime().configuration);
    const queryNoteId = newQueryNoteId();
    void run(async () => {
      const profile = await store.general.queryProfiles.create(newName().trim(), configuration, queryNoteId);
      await store.general.queryProfiles.setPinned(profile.id, true);
      setNaming(false);
      close();
      adopt(profile, configuration);
    });
  };

  // Chip widths come from an invisible copy of every chip, so the visible row can be computed without feedback.
  const measureWidths = () => {
    if (measure == null) { return; }
    const chips = new Map<string, number>();
    measure.querySelectorAll<HTMLElement>("[data-measure-chip]").forEach(el => chips.set(el.dataset.measureChip!, el.offsetWidth));
    const next = {
      chips,
      menu: measure.querySelector<HTMLElement>("[data-measure-menu]")?.offsetWidth ?? 0,
    };
    const current = widths();
    const same = current.menu == next.menu && current.chips.size == next.chips.size &&
      [...next.chips].every(([id, width]) => current.chips.get(id) == width);
    if (!same) { setWidths(next); }
  };
  // Tracks only strings, so a new measurement cannot retrigger itself.
  createEffect(() => {
    candidates().map(profile => `${profile.id}:${profile.name}:${unavailable(profile).length}`).join("|");
    menuLabel();
    queueMicrotask(measureWidths);
  });
  /** Pinned profiles, then the applied profile if it is not pinned. */
  const candidates = () => {
    const current = active();
    return current != null && !pinnedIds().has(current.id) ? [...pinned(), current] : pinned();
  };
  const shown = createMemo(() => {
    const all = candidates();
    if (rowWidth() == 0) { return all; }
    const { chips, menu } = widths();
    const width = (profile: QueryProfile) => (chips.get(profile.id) ?? 80) + CHIP_GAP_PX;
    const available = rowWidth() - menu - CHIP_GAP_PX;
    const fit: QueryProfile[] = [];
    let used = 0;
    for (const profile of all) {
      if (used + width(profile) > available) { break; }
      fit.push(profile);
      used += width(profile);
    }
    const current = active();
    if (current != null && !fit.some(profile => profile.id == current.id)) {
      while (fit.length > 0 && used + width(current) > available) { used -= width(fit.pop()!); }
      fit.push(current);
    }
    return fit;
  });
  const hiddenCount = () => pinned().filter(profile => !shown().some(visible => visible.id == profile.id)).length;

  const profileTitle = (profile: QueryProfile) => [
    profile.name,
    `Scope: ${queryScopeName(profile.configuration.scopeId)}`,
    ...(props.searchMode() ? [] : [`Model: ${queryModelRouteLabel(store, profile.configuration.model)}`, `Tools: ${queryToolsLabel(profile.configuration.capabilities)}`]),
    profile.queryNoteId ? `Template note: ${queryScopeItemTitle(profile.queryNoteId)}` : null,
    ...unavailable(profile).map(issue => issue.message),
    isActive(profile) && modified() ? "Modified in this query. Click to restore the saved settings." : null,
    reason(),
  ].filter(Boolean).join("\n");

  const keyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key == "Tab") { props.onTabKey?.(ev); return; }
    if (ev.key != "ArrowLeft" && ev.key != "ArrowRight") { return; }
    const buttons = Array.from(row()?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const index = buttons.indexOf(ev.currentTarget as HTMLButtonElement);
    if (index < 0) { return; }
    ev.preventDefault();
    buttons[(index + (ev.key == "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };

  const chip = (profile: QueryProfile) =>
    <button type="button" aria-pressed={isActive(profile)} disabled={reason() != null} title={profileTitle(profile)}
      class={chipClass}
      classList={{
        "border-slate-500 bg-slate-100 text-slate-900": isActive(profile),
        "border-[#d6d6d6] bg-white hover:bg-slate-50": !isActive(profile),
      }}
      onClick={() => apply(profile)} onKeyDown={keyDown}>
      <span class="min-w-0 truncate">{profile.name}</span>
      <Show when={isActive(profile) && modified()}>
        <span class="h-[6px] w-[6px] shrink-0 rounded-full bg-amber-500" aria-label="modified" />
      </Show>
      <Show when={unavailable(profile).length > 0}><i class="bi-exclamation-triangle shrink-0 text-[10px] text-amber-600" /></Show>
    </button>;

  const menuRow = (profile: QueryProfile, close: () => void) => <div class="flex items-center gap-1 px-2">
    <button type="button" role="radio" aria-checked={isActive(profile)} disabled={reason() != null}
      class="flex min-w-0 grow cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100 disabled:cursor-default disabled:opacity-50"
      data-picker-autofocus={isActive(profile) ? true : undefined}
      onClick={() => { apply(profile); close(); }}>
      <i class={`mt-[3px] w-3 shrink-0 text-[12px] ${isActive(profile) ? "bi-check-lg" : ""}`} />
      <div class="min-w-0 grow">
        <div class="truncate text-[13px]">{profile.name}<Show when={isActive(profile) && modified()}><span class="text-slate-500"> · modified</span></Show></div>
        <div class="truncate text-[11px] text-slate-500">{queryConfigurationSummary(store, profile.configuration)}</div>
        <Show when={profile.queryNoteId}>{id => <div class="truncate text-[11px] text-slate-500" title={id()}>Template: {queryScopeItemTitle(id())}</div>}</Show>
        <Show when={unavailable(profile).length > 0}>
          <div class="truncate text-[11px] text-amber-700" title={unavailable(profile).map(issue => issue.message).join("\n")}>
            <i class="bi-exclamation-triangle mr-1" />Unavailable: {unavailable(profile).map(issue => issue.subject).join(", ")}
          </div>
        </Show>
      </div>
    </button>
    <button type="button" class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      aria-pressed={pinnedIds().has(profile.id)} disabled={busy()}
      aria-label={`${pinnedIds().has(profile.id) ? "Unpin" : "Pin"} ${profile.name}`}
      title={pinnedIds().has(profile.id) ? "Unpin" : "Pin as a shortcut"}
      onClick={() => void run(() => store.general.queryProfiles.setPinned(profile.id, !pinnedIds().has(profile.id)))}>
      <i class={pinnedIds().has(profile.id) ? "bi-pin-angle-fill text-slate-700" : "bi-pin-angle"} />
    </button>
  </div>;

  const menuLabel = () => hiddenCount() > 0 ? `+${hiddenCount()} more` : "Profiles";

  return <Show when={!props.searchMode()}>
    <div ref={el => { setRow(el); props.barRef?.(el); }} role="group" aria-label="Query profiles"
      class="relative flex min-w-0 items-center overflow-hidden text-[12px] text-[#555]" style={`height: ${QUERY_PROFILE_ROW_HEIGHT_PX}px; gap: ${CHIP_GAP_PX}px;`}
      onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent} onClick={stopQueryPickerEvent}>
      <div ref={measure} aria-hidden="true" class="invisible absolute left-0 top-0 flex w-max" style={`gap: ${CHIP_GAP_PX}px;`}>
        <For each={candidates()}>{profile => <span data-measure-chip={profile.id} class={`${chipClass} border-[#d6d6d6]`}>
          <span class="min-w-0 truncate">{profile.name}</span>
          <span class="h-[6px] w-[6px] shrink-0" />
          <Show when={unavailable(profile).length > 0}><i class="bi-exclamation-triangle shrink-0 text-[10px]" /></Show>
        </span>}</For>
        <span data-measure-menu class="flex h-[22px] items-center gap-1 rounded-md border px-2" style="font-size: 12px;">{menuLabel()}<i class="bi-chevron-expand text-[10px]" /></span>
      </div>
      <For each={shown()}>{profile => chip(profile)}</For>
      <QueryPickerPopover buttonClass="shrink-0 cursor-pointer" width={360} ariaLabel="All query profiles"
        title={hiddenCount() > 0 ? `${hiddenCount()} more pinned profiles, and all saved profiles` : "All saved profiles"}
        label={<span class="whitespace-nowrap">{menuLabel()}</span>} onTabKey={props.onTabKey}
        onOpen={() => { setNaming(false); void store.general.queryProfiles.refresh(); void refreshQueryScopes(store); void store.general.retrieveChatBackends(); }}>
        {close => <>
          <div class="min-h-0 grow overflow-y-auto py-1" role="radiogroup" aria-label="Saved profiles">
            <Show when={store.general.queryProfiles.error()}>{error =>
              <div class="px-3 py-2 text-[12px] text-red-700">{error()}
                <button type="button" class="ml-2 underline" onClick={() => { void store.general.queryProfiles.refresh(); }}>Retry</button>
              </div>
            }</Show>
            <Show when={collection() == null && store.general.queryProfiles.error() == null}>
              <div class="px-3 py-2 text-[12px] text-slate-500">Loading profiles…</div>
            </Show>
            <Show when={reason()}><div class="px-3 py-1 text-[11px] text-slate-500">{reason()}</div></Show>
            <For each={profiles()}>{profile => menuRow(profile, close)}</For>
          </div>
          <Show when={naming()} fallback={
            <div class="shrink-0 border-t border-slate-200 px-2 py-1">
              <Show when={modified() ? active() : null}>{profile =>
                <button type="button" class={actionClass}
                  disabled={saveBlockedReason() != null || busy()}
                  title={saveBlockedReason() ?? `Save this query's scope, model and tools to “${profile().name}”`}
                  onClick={() => saveToActive(close)}>
                  <i class="bi-save w-3 shrink-0 text-slate-500" aria-hidden="true" />
                  <span class="min-w-0 truncate">Save changes to “{profile().name}”</span>
                </button>
              }</Show>
              <button type="button" class={actionClass}
                disabled={collection() == null || saveBlockedReason() != null || busy()} title={saveBlockedReason() ?? "Save this query's scope, model and tools as a new profile"}
                onClick={() => { props.beforeChange?.(); setNewName(""); setNewQueryNoteId(active()?.queryNoteId ?? null); setNaming(true); }}>
                <i class="bi-plus-lg w-3 shrink-0 text-slate-500" aria-hidden="true" />
                <span>Save as new…</span>
              </button>
              <button type="button" class={actionClass}
                disabled={collection() == null || busy()} onClick={() => { close(); setManaging(true); }}>
                <i class="bi-sliders w-3 shrink-0 text-slate-500" aria-hidden="true" />
                <span>Manage…</span>
              </button>
            </div>
          }>
            <form class="shrink-0 space-y-2 border-t border-slate-200 px-3 py-2 text-[12px]" onSubmit={ev => saveAsNew(ev, close)}>
              <div class="flex items-center gap-2">
                <input ref={el => queueMicrotask(() => el.focus())} aria-label="New profile name" placeholder="Profile name"
                  class="min-w-0 grow rounded border border-slate-400 px-2 py-1 text-[13px] outline-hidden focus:border-slate-600"
                  value={newName()} disabled={busy()} onInput={ev => setNewName(ev.currentTarget.value)}
                  onKeyDown={ev => { if (ev.key == "Escape") { ev.preventDefault(); ev.stopPropagation(); setNaming(false); } }} />
                <button type="submit" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                  disabled={busy() || noteLoading() || profileNameProblem(newName()) != null}>Save</button>
                <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => setNaming(false)}>Cancel</button>
              </div>
              <QueryProfileNotePicker value={newQueryNoteId} onChange={setNewQueryNoteId} disabled={busy} onBusyChange={setNoteLoading} />
            </form>
          </Show>
        </>}
      </QueryPickerPopover>
      <Show when={managing()}><QueryProfileManager onClose={() => setManaging(false)} /></Show>
    </div>
  </Show>;
}
