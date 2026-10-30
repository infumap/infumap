/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import type { QueryProfile } from "../../items/query-configuration";
import { queryConfigurationSummary } from "../../items/query-configuration-labels";
import { describeQueryScopeItems, queryScopeItemTitle } from "../../items/query-scope";
import { useStore } from "../../store/StoreProvider";
import type { Uid } from "../../util/uid";
import { stopQueryPickerEvent } from "./QueryPickerPopover";
import { QueryProfileNotePicker } from "./QueryProfileNotePicker";

const nameEncoder = new TextEncoder();

/** The server's rules for a profile name, so a form can explain a problem before submitting. */
export function profileNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed == "") { return "Enter a profile name."; }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) { return "Remove control characters from the name."; }
  if (nameEncoder.encode(trimmed).length > 120) { return "The name is too long."; }
  return null;
}

const iconButtonClass = "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
const moveButtonClass = "flex h-[14px] w-6 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent";
const textButtonClass = "rounded border border-slate-300 px-2 py-1 text-[12px] hover:bg-slate-100 disabled:cursor-default disabled:opacity-40";

/** Account profile management, including optional query templates. Queries keep their setups. */
export function QueryProfileManager(props: { onClose: () => void }) {
  const store = useStore();
  const ownerId = store.user.getUserMaybe()?.userId ?? null;
  let panel: HTMLDivElement | undefined;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<Uid | null>(null);
  const [name, setName] = createSignal("");
  const [editingQuery, setEditingQuery] = createSignal<Uid | null>(null);
  const [queryNoteId, setQueryNoteId] = createSignal<Uid | null>(null);
  const [noteLoading, setNoteLoading] = createSignal(false);
  const [deleting, setDeleting] = createSignal<Uid | null>(null);
  const collection = () => store.general.queryProfiles.collection();
  const profiles = () => collection()?.profiles ?? [];
  const isDefault = (id: Uid) => collection()?.preferences.defaultProfileId == id;
  const isPinned = (id: Uid) => collection()?.preferences.pinnedProfileIds.includes(id) == true;
  createEffect(() => {
    void describeQueryScopeItems(profiles().flatMap(profile => profile.queryNoteId == null ? [] : [profile.queryNoteId]));
  });

  createEffect(() => {
    if ((store.user.getUserMaybe()?.userId ?? null) != ownerId) { props.onClose(); }
  });
  onMount(() => {
    void store.general.queryProfiles.refresh();
    queueMicrotask(() => panel?.focus());
    const keydown = (ev: KeyboardEvent) => {
      if (ev.key != "Escape") { return; }
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (renaming() != null) { setRenaming(null); }
      else if (editingQuery() != null) { setEditingQuery(null); }
      else if (deleting() != null) { setDeleting(null); }
      else { props.onClose(); }
    };
    window.addEventListener("keydown", keydown, true);
    onCleanup(() => window.removeEventListener("keydown", keydown, true));
  });

  const run = async (action: () => Promise<unknown>) => {
    if (busy()) { return; }
    setBusy(true); setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const startRename = (profile: QueryProfile) => {
    setDeleting(null); setEditingQuery(null); setError(null);
    setName(profile.name);
    setRenaming(profile.id);
  };
  const submitRename = (ev: SubmitEvent, profile: QueryProfile) => {
    ev.preventDefault();
    const problem = profileNameProblem(name());
    if (problem != null) { setError(problem); return; }
    if (name().trim() == profile.name) { setRenaming(null); return; }
    void run(async () => { await store.general.queryProfiles.rename(profile.id, name().trim()); setRenaming(null); });
  };
  const startQueryEdit = (profile: QueryProfile) => {
    setRenaming(null); setDeleting(null); setError(null);
    setQueryNoteId(profile.queryNoteId ?? null);
    setEditingQuery(profile.id);
  };
  const submitQuery = (ev: SubmitEvent, profile: QueryProfile) => {
    ev.preventDefault();
    if (noteLoading()) { return; }
    void run(async () => {
      await store.general.queryProfiles.setQueryNote(profile.id, queryNoteId());
      setEditingQuery(null);
    });
  };
  /** Deleting the default makes the first remaining profile the default. */
  const nextDefault = (deleted: QueryProfile) =>
    isDefault(deleted.id) ? profiles().find(profile => profile.id != deleted.id) ?? null : null;

  const panelKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key != "Tab" || panel == null) { return; }
    const elements = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
    if (elements.length == 0) { return; }
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (!elements.includes(document.activeElement as HTMLElement)) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
    else if (ev.shiftKey && document.activeElement == first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement == last) { ev.preventDefault(); first.focus(); }
  };

  const row = (profile: QueryProfile, index: () => number) => <div class="border-b border-slate-100 px-4 py-2 last:border-b-0">
    <Show when={deleting() == profile.id} fallback={
      <div class="flex items-center gap-1">
        <div class="flex shrink-0 flex-col">
          <button type="button" class={moveButtonClass} aria-label={`Move ${profile.name} up`} title="Move up"
            disabled={busy() || index() == 0} onClick={() => void run(() => store.general.queryProfiles.move(profile.id, index() - 1))}>
            <i class="bi-chevron-up text-[11px]" /></button>
          <button type="button" class={moveButtonClass} aria-label={`Move ${profile.name} down`} title="Move down"
            disabled={busy() || index() == profiles().length - 1} onClick={() => void run(() => store.general.queryProfiles.move(profile.id, index() + 1))}>
            <i class="bi-chevron-down text-[11px]" /></button>
        </div>
        <div class="min-w-0 grow pl-1">
          <Show when={renaming() == profile.id} fallback={
            <button type="button" class="block max-w-full cursor-text truncate rounded px-1 text-left text-[13px] font-medium hover:bg-slate-100"
              title="Rename" disabled={busy()} onClick={() => startRename(profile)}>{profile.name}</button>
          }>
            <form class="flex items-center gap-1" onSubmit={ev => submitRename(ev, profile)}>
              <input ref={el => queueMicrotask(() => { el.focus(); el.select(); })} aria-label="Profile name" value={name()}
                class="min-w-0 grow rounded border border-slate-400 px-1 py-0.5 text-[13px] outline-hidden focus:border-slate-600"
                disabled={busy()} onInput={ev => setName(ev.currentTarget.value)} />
              <button type="submit" class={textButtonClass} disabled={busy()}>Save</button>
              <button type="button" class={textButtonClass} disabled={busy()} onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          </Show>
          <div class="truncate px-1 text-[11px] text-slate-500">{queryConfigurationSummary(store, profile.configuration)}</div>
          <div class="mt-2 px-1">
            <button type="button"
              class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-xs border border-[#999] bg-white px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-40"
              title={`Choose a query template for ${profile.name}`} aria-expanded={editingQuery() == profile.id}
              aria-controls={`profile-template-${profile.id}`} disabled={busy()} onClick={() => startQueryEdit(profile)}>
              <i class="bi-card-text shrink-0" aria-hidden="true" />
              <span class="truncate">{profile.queryNoteId ? "Change template note…" : "Choose template note…"}</span>
            </button>
            <Show when={profile.queryNoteId}>{id =>
              <div class="mt-1 truncate text-[11px] text-slate-500" title={id()}>Template: {queryScopeItemTitle(id())}</div>
            }</Show>
          </div>
        </div>
        <button type="button" class={iconButtonClass} aria-pressed={isPinned(profile.id)}
          aria-label={`${isPinned(profile.id) ? "Unpin" : "Pin"} ${profile.name}`}
          title={isPinned(profile.id) ? "Pinned: shown as a shortcut above the input" : "Pin as a shortcut above the input"}
          disabled={busy()} onClick={() => void run(() => store.general.queryProfiles.setPinned(profile.id, !isPinned(profile.id)))}>
          <i class={isPinned(profile.id) ? "bi-pin-angle-fill text-slate-800" : "bi-pin-angle"} /></button>
        <Show when={isDefault(profile.id)} fallback={
          <button type="button" class={iconButtonClass} aria-label={`Make ${profile.name} the default`}
            title="Make the default for new queries" disabled={busy()}
            onClick={() => void run(() => store.general.queryProfiles.setDefault(profile.id))}>
            <i class="bi-house" /></button>
        }>
          <span class="flex h-7 w-7 shrink-0 items-center justify-center text-slate-800" role="img"
            aria-label={`${profile.name} is the default`} title="Default for new queries"><i class="bi-house-fill" /></span>
        </Show>
        <button type="button" class={iconButtonClass} aria-label={`Duplicate ${profile.name}`} title="Duplicate"
          disabled={busy()} onClick={() => void run(() => store.general.queryProfiles.duplicate(profile.id))}>
          <i class="bi-copy" /></button>
        <button type="button" class={iconButtonClass} aria-label={`Delete ${profile.name}`}
          title={profiles().length <= 1 ? "The last profile cannot be deleted" : "Delete"}
          disabled={busy() || profiles().length <= 1} onClick={() => { setRenaming(null); setEditingQuery(null); setError(null); setDeleting(profile.id); }}>
          <i class="bi-trash" /></button>
      </div>
    }>
      <div class="flex flex-wrap items-center gap-2 py-1 text-[12px]">
        <span class="min-w-0 grow">
          Delete “{profile.name}”?
          <Show when={nextDefault(profile)}>{next => <span class="text-slate-500"> “{next().name}” will become the default.</span>}</Show>
        </span>
        <button type="button" class={`${textButtonClass} text-red-700`} disabled={busy()}
          ref={el => queueMicrotask(() => el.focus())}
          onClick={() => void run(async () => { await store.general.queryProfiles.delete(profile.id); setDeleting(null); })}>Delete</button>
        <button type="button" class={textButtonClass} disabled={busy()} onClick={() => setDeleting(null)}>Cancel</button>
      </div>
    </Show>
    <Show when={editingQuery() == profile.id}>
      <form id={`profile-template-${profile.id}`} class="mt-2 space-y-2" onSubmit={ev => submitQuery(ev, profile)}>
        <QueryProfileNotePicker value={queryNoteId} onChange={setQueryNoteId} disabled={busy} onBusyChange={setNoteLoading} />
        <div class="flex gap-2">
          <button type="submit" class={textButtonClass} disabled={busy() || noteLoading()}>Save template</button>
          <button type="button" class={textButtonClass} disabled={busy()} onClick={() => setEditingQuery(null)}>Cancel</button>
        </div>
      </form>
    </Show>
  </div>;

  return <Portal mount={document.body}>
    <div class="fixed inset-0 bg-black/20" style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 2};`}
      onMouseDown={ev => { ev.stopPropagation(); props.onClose(); }} onClick={stopQueryPickerEvent} />
    <div ref={panel} tabindex={-1} role="dialog" aria-modal="true" aria-label="Manage query profiles"
      class="fixed left-1/2 top-[10vh] flex max-h-[80vh] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-xl outline-hidden"
      style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 3};`}
      onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent} onClick={stopQueryPickerEvent}
      onKeyDown={panelKeyDown} onKeyUp={stopQueryPickerEvent}>
      <div class="flex shrink-0 items-start gap-2 border-b border-slate-200 px-4 py-3">
        <div class="min-w-0 grow">
          <div class="text-[14px] font-medium">Query profiles</div>
          <div class="text-[12px] text-slate-500">Pinned profiles are shortcuts above the input. New queries start with the default.</div>
        </div>
        <button type="button" class={iconButtonClass} aria-label="Close" onClick={props.onClose}><i class="bi-x-lg" /></button>
      </div>
      <Show when={error() ?? store.general.queryProfiles.error()}>{message =>
        <div role="alert" class="shrink-0 border-b border-slate-200 bg-red-50 px-4 py-2 text-[12px] text-red-700">{message()}</div>
      }</Show>
      <div class="min-h-0 grow overflow-y-auto">
        <Show when={collection() != null} fallback={<div class="px-4 py-3 text-[12px] text-slate-500">Loading profiles…</div>}>
          <For each={profiles()}>{(profile, index) => row(profile, index)}</For>
        </Show>
      </div>
    </div>
  </Portal>;
}
