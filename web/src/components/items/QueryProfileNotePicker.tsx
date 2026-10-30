/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Show, createSignal, onCleanup } from "solid-js";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { ItemType } from "../../items/base/item";
import { readQueryProfileNote } from "../../items/query-profile-note";
import { parseQueryScopeItemInput, queryScopeItemTitle } from "../../items/query-scope";
import type { Uid } from "../../util/uid";
import { ItemCandidatesPopup, createItemCandidateSearch } from "../library/ItemCandidates";

/** Selects a note reference; its text remains in the ordinary note item. */
export function QueryProfileNotePicker(props: {
  value: () => Uid | null,
  onChange: (id: Uid | null) => void,
  disabled: () => boolean,
  onBusyChange: (busy: boolean) => void,
}) {
  let input: HTMLInputElement | undefined;
  let disposed = false;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  onCleanup(() => { disposed = true; props.onBusyChange(false); });

  const choose = async (id: Uid) => {
    if (props.disabled() || busy()) { return; }
    setBusy(true); props.onBusyChange(true); setError(null);
    try {
      await readQueryProfileNote(id);
      if (disposed) { return; }
      props.onChange(id);
      if (input) { input.value = ""; }
    } catch {
      if (!disposed) { setError("Choose an accessible note item. The note could not be read."); }
    } finally {
      if (!disposed) { setBusy(false); props.onBusyChange(false); }
    }
  };
  const candidates = createItemCandidateSearch({
    anchor: () => input,
    itemType: ItemType.Note,
    onPick: candidate => { void choose(candidate.id); },
  });
  const commit = () => {
    const parsed = parseQueryScopeItemInput(input?.value ?? "");
    if ("error" in parsed) { setError("Choose a note from the list, or paste its item link or ID."); return; }
    candidates.close();
    void choose(parsed.itemId);
  };
  const popupStyle = () => {
    const rect = candidates.anchorBoundsPx();
    const above = rect?.top ?? 0;
    const below = window.innerHeight - (rect?.bottom ?? 0);
    const width = Math.min(Math.max(300, rect?.width ?? 0), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - width - 8));
    const vertical = above > below ? `bottom: ${window.innerHeight - above + 2}px;` : `top: ${(rect?.bottom ?? 0) + 2}px;`;
    return `position: fixed; left: ${left}px; ${vertical} width: ${width}px; ` +
      `max-height: ${Math.max(0, Math.min(400, Math.max(above, below) - 10))}px; overflow-y: auto; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 4};`;
  };

  return <div class="space-y-1 text-[12px]">
    <div class="text-slate-700">Boilerplate note (optional)</div>
    <Show when={props.value()}>{id =>
      <div class="flex min-w-0 items-center gap-2 rounded-xs border border-slate-300 bg-slate-50 pl-2">
        <i class="bi-card-text shrink-0 text-slate-500" />
        <span class="min-w-0 grow truncate" title={id()}>{queryScopeItemTitle(id())}</span>
        <button type="button" class="h-6 w-6 shrink-0 text-slate-500 hover:text-black disabled:opacity-40"
          aria-label="Remove boilerplate note" title="Remove boilerplate note" disabled={props.disabled() || busy()}
          onClick={() => { props.onChange(null); setError(null); }}><i class="bi-x" /></button>
      </div>
    }</Show>
    <div class="flex gap-2">
      <input ref={input} type="text" aria-label="Boilerplate note" spellcheck={false}
        class="min-w-0 grow rounded-xs border border-slate-400 px-2 py-1 text-[13px] outline-hidden focus:border-slate-600"
        placeholder="Search notes, or paste a note link"
        disabled={props.disabled() || busy()}
        onInput={ev => { setError(null); candidates.search(ev.currentTarget.value); }}
        onBlur={() => candidates.close()}
        onKeyDown={ev => {
          ev.stopPropagation();
          if (candidates.keyDown(ev) || ev.isComposing) { return; }
          if (ev.key == "Enter") { ev.preventDefault(); commit(); }
        }} />
      <button type="button" class="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
        disabled={props.disabled() || busy()} onClick={commit}>{busy() ? "Loading…" : "Choose"}</button>
    </div>
    <div class="text-[11px] text-slate-500">The note's current text fills an empty composer when this profile is selected.</div>
    <Show when={error()}>{message => <div role="alert" class="text-red-700">{message()}</div>}</Show>
    <ItemCandidatesPopup search={candidates} class="overflow-hidden rounded-xs border border-slate-400 bg-white py-1 shadow-sm"
      style={popupStyle()} />
  </div>;
}
