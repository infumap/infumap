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

import { For, Show, onMount } from "solid-js";
import { getQueryRuntime } from "../../items/query-item";
import { queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import {
  queryScopeDescription, queryScopeId, queryScopeName, queryScopeProblemText,
  queryScopeSummary, queryScopes, queryScopesError, queryScopesLoading, refreshQueryScopes, setQueryScopeId,
} from "../../items/query-scope";
import { switchToPage } from "../../layout/navigation";
import { useStore } from "../../store/StoreProvider";
import type { Uid } from "../../util/uid";
import { QueryPickerPopover, type QueryPickerProps } from "./QueryPickerPopover";

interface QueryScopePickerProps extends QueryPickerProps {
  /** Search always uses scope; chat uses it when Infumap tools are enabled. */
  inUse?: () => boolean,
  note?: () => string | null,
  onChange?: () => void,
}

export function QueryScopePicker(props: QueryScopePickerProps) {
  const store = useStore();
  onMount(() => {
    void store.general.queryProfiles.retrieve();
    if (queryScopes() == null) { void refreshQueryScopes(store); }
  });
  const selectedId = () => queryScopeId(store, props.queryItem());
  const selectedSummary = () => queryScopeSummary(selectedId());
  const missing = () => selectedId() != null && selectedSummary() === null && queryScopesError() == null;
  const inUse = () => props.inUse?.() != false;
  const ready = () => getQueryRuntime(store, props.queryItem()).configurationInitialized || store.general.defaultQueryProfile() != null;
  const disabled = () => props.disabled?.() == true || queryConfigurationChangeBlockedReason(store, props.queryItem()) != null || !ready() || !inUse();
  const label = () => !inUse() ? "Not used" : selectedSummary() === undefined
    ? queryScopesError() == null ? "Loading…" : "Unverified" : selectedSummary() == null && selectedId() != null && queryScopesError() != null ? "Unverified" : queryScopeName(selectedId());
  const warning = () => {
    const summary = selectedSummary();
    return inUse() && selectedId() != null && (missing() || queryScopesError() != null || (summary != null && queryScopeProblemText(summary.problems) != null));
  };
  const title = () => {
    const blockedReason = queryConfigurationChangeBlockedReason(store, props.queryItem());
    if (blockedReason != null) { return blockedReason; }
    if (!inUse()) { return `Scope is not used because Infumap tools are off. Saved scope: ${queryScopeName(selectedId())}.`; }
    if (!ready()) { return store.general.queryProfiles.error() ?? "Loading the default query profile…"; }
    if (missing()) { return `Scope ${selectedId()} no longer exists or is not accessible. Choose another.`; }
    if (selectedId() != null && queryScopesError() != null) { return `${queryScopesError()} Could not verify saved scope: ${selectedId()}.`; }
    const summary = selectedSummary();
    return [`Search within Infumap: ${queryScopeName(selectedId())}`,
      summary == null ? null : queryScopeDescription(summary),
      summary == null ? null : queryScopeProblemText(summary.problems)].filter(Boolean).join("\n");
  };
  const select = (id: Uid | null, close: () => void) => {
    if (disabled()) { return; }
    close();
    if (id == selectedId()) { return; }
    props.beforeChange?.();
    setQueryScopeId(store, props.queryItem(), id);
    props.onChange?.();
  };
  const row = (id: Uid | null, name: string, description: string, problem: string | null, close: () => void, unavailable: boolean = false) => (
    <button type="button" role="radio" aria-checked={selectedId() == id} disabled={disabled() || unavailable}
      data-picker-autofocus={selectedId() == id ? true : undefined}
      class="flex w-full items-start gap-2 cursor-pointer rounded px-3 py-1.5 text-left hover:bg-slate-100 disabled:cursor-default disabled:opacity-50"
      onClick={() => select(id, close)}>
      <i class={`mt-1 shrink-0 text-[12px] ${selectedId() == id ? "bi-record-circle text-slate-700" : "bi-circle text-slate-400"}`} />
      <div class="min-w-0 grow">
        <div class="truncate text-[13px]">{name}</div>
        <div class="text-[11px] text-slate-500">{description}</div>
        <Show when={problem != null}><div class="text-[11px] text-amber-700">{problem}</div></Show>
      </div>
    </button>
  );

  return <QueryPickerPopover width={320} disabled={disabled()} buttonRef={props.buttonRef} onTabKey={props.onTabKey}
    buttonClass="max-w-[180px] flex-[1_1_auto] cursor-pointer" ariaLabel={`Scope: ${label()}`} title={title()}
    label={<><i class={warning() ? "bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" : "bi-funnel shrink-0 text-[11px]"} />
      <span class="shrink-0">Scope:</span><span class="min-w-0 truncate">{label()}</span></>}
    onOpen={() => { void store.general.queryProfiles.refresh(); void refreshQueryScopes(store); }}>
    {close => <>
      <div class="shrink-0 border-b border-slate-200 px-3 py-2">
        <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">Search within Infumap
          <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label="Close scope picker" onClick={close}><i class="bi-x-lg" /></button>
        </div>
        <div class="mt-1 text-[11px] text-slate-500">Limits what Infumap tools can find. Web tools, attachments and existing chat context are unaffected.</div>
        <Show when={props.note?.()}><div class="mt-1 text-[11px] text-slate-500">{props.note!()}</div></Show>
      </div>
      <div class="min-h-0 grow overflow-y-auto py-1" role="radiogroup" aria-label="Infumap search scope">
        {row(null, "Everything", "Everything under your home page", null, close)}
        <Show when={missing()}>{row(selectedId(), "Missing scope", `Saved scope: ${selectedId()}`, "This scope no longer exists or is not accessible. Choose another.", close, true)}</Show>
        <Show when={selectedId() != null && selectedSummary() == null && !missing()}>{row(selectedId(), "Saved scope (unverified)", `Saved scope: ${selectedId()}`, "Refresh scopes to check availability.", close, true)}</Show>
        <Show when={queryScopes() == null && queryScopesError() == null}><div class="px-3 py-2 text-[12px] text-slate-500">Loading scopes…</div></Show>
        <Show when={queryScopesError()}><div class="px-3 py-2 text-[12px] text-red-700">{queryScopesError()}</div></Show>
        <For each={queryScopes()?.scopes ?? []}>{scope => row(scope.id, queryScopeName(scope.id), queryScopeDescription(scope), queryScopeProblemText(scope.problems), close)}</For>
      </div>
      <div class="shrink-0 border-t border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        <button type="button" class="mb-1 block text-[12px] text-blue-700 hover:underline" disabled={queryScopesLoading()}
          onClick={() => { void refreshQueryScopes(store); }}>{queryScopesLoading() ? "Checking scopes…" : "Refresh scopes"}</button>
        Links in each scope page include items; links in its Exclude page exclude them.
        <Show when={queryScopes() != null}>
          <button type="button" class="mt-1 block text-[12px] text-blue-700 hover:underline" onClick={() => {
            const pageId = queryScopes()?.scopesPageId;
            close();
            if (pageId != null) { switchToPage(store, { itemId: pageId, linkIdMaybe: null }, true, false, false); }
          }}>Edit scopes</button>
        </Show>
      </div>
    </>}
  </QueryPickerPopover>;
}
