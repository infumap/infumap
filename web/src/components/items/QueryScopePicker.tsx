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

import { For, Show, createSignal, onMount } from "solid-js";
import { getQueryRuntime } from "../../items/query-item";
import { queryConfigurationChangeBlockedReason } from "../../items/query-configuration-state";
import { EVERYTHING_SCOPE, scopeRefsEqual, type ScopeRef } from "../../items/query-configuration";
import {
  clearQueryScopeItems, describeQueryScopeItems, queryCollectionDescription, queryCollectionTitle, queryCollections,
  queryCollectionsError, queryHereCollections, queryScope, queryScopeEmptyText, queryScopeItemIds,
  queryScopeItemResolved, queryScopeItemTitle, queryScopeItemsLabel, queryScopeName, queryScopeUnavailable,
  queryScopeUnavailableText, refreshQueryCollections, removeQueryScopeItem, setQueryScope,
} from "../../items/query-scope";
import { COLLECTION_ICON_CLASS } from "../library/CollectionGlyph";
import type { CollectionSummary } from "../../server";
import { useStore } from "../../store/StoreProvider";
import type { Uid } from "../../util/uid";
import { QueryPickerPopover, type QueryPickerProps } from "./QueryPickerPopover";
import { DIALOG_INPUT_CLASS, DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";

/** Below this many collections, the list is short enough to scan without a filter. */
const COLLECTION_FILTER_MIN_COUNT = 7;

interface QueryScopePickerProps extends QueryPickerProps {
  /** Search always uses scope; chat uses it when Infumap tools are enabled. */
  inUse?: () => boolean,
  note?: () => string | null,
  onChange?: () => void,
  /** Search uses the scope remembered for search, which no query or profile owns, in place of this query's. */
  searchScope?: () => boolean,
  /** Chat: items chosen as the scope replace the selected one while there are any. Search ignores them. */
  usesScopeItems?: () => boolean,
}

export function QueryScopePicker(props: QueryScopePickerProps) {
  const store = useStore();
  onMount(() => {
    void store.general.queryProfiles.retrieve();
    if (queryCollections() == null) { void refreshQueryCollections(store); }
  });
  const [filter, setFilter] = createSignal("");
  const searchScope = () => props.searchScope?.() == true;
  const selected = (): ScopeRef => searchScope() ? store.general.searchScope() : queryScope(store, props.queryItem());
  const blockedReason = () => searchScope() ? null : queryConfigurationChangeBlockedReason(store, props.queryItem());
  const unavailable = () => queryScopeUnavailable(selected());
  const unverified = () => selected().kind != "everything" && selected().kind != "unavailable" && queryCollectionsError() != null;
  const inUse = () => props.inUse?.() != false;
  const scopeItems = () => props.usesScopeItems?.() == true ? queryScopeItemIds(store, props.queryItem()) : [];
  const itemsActive = () => scopeItems().length > 0;
  const missingItemCount = () => scopeItems().filter(id => !queryScopeItemResolved(id)).length;
  const missingItemsText = () => missingItemCount() == 0 ? null
    : `${missingItemCount()} of the items no longer ${missingItemCount() == 1 ? "exists" : "exist"} and will be left out.`;
  const ready = () => searchScope() || getQueryRuntime(store, props.queryItem()).configurationInitialized || store.general.defaultQueryProfile() != null;
  const disabled = () => props.disabled?.() == true || blockedReason() != null || !ready() || !inUse();
  const label = () => !inUse() ? "Not used" : itemsActive() ? queryScopeItemsLabel(scopeItems().length) : queryScopeName(selected());
  const warning = () => inUse() && (itemsActive()
    ? missingItemCount() > 0
    : unavailable() || unverified() || queryScopeEmptyText(selected()) != null);
  const title = () => {
    if (blockedReason() != null) { return blockedReason()!; }
    if (!inUse()) { return `Scope is not used because Infumap tools are off. Saved scope: ${queryScopeName(selected())}.`; }
    if (!ready()) { return store.general.queryProfiles.error() ?? "Loading the default query profile…"; }
    if (itemsActive()) {
      return [`Scope: ${queryScopeItemsLabel(scopeItems().length)} and everything inside them`,
        ...scopeItems().map(id => `· ${queryScopeItemTitle(id)}`), missingItemsText()].filter(Boolean).join("\n");
    }
    if (unverified()) { return `${queryCollectionsError()} Could not verify the saved collection.`; }
    return [`Scope: ${queryScopeName(selected())}`, queryScopeUnavailableText(selected()), queryScopeEmptyText(selected())]
      .filter(Boolean).join("\n");
  };
  const select = (scope: ScopeRef, close: () => void) => {
    if (disabled()) { return; }
    close();
    if (scopeRefsEqual(scope, selected())) { return; }
    props.beforeChange?.();
    if (searchScope()) { store.general.setSearchScope(scope); }
    else { setQueryScope(store, props.queryItem(), scope); }
    props.onChange?.();
  };
  // A change is blocked when the picker is disabled, so there is nothing to report here.
  const removeItem = (itemId: Uid) => {
    if (disabled()) { return; }
    props.beforeChange?.();
    removeQueryScopeItem(store, props.queryItem(), itemId);
  };
  const clearItems = () => {
    if (disabled()) { return; }
    props.beforeChange?.();
    clearQueryScopeItems(store, props.queryItem());
  };
  const isSelected = (scope: ScopeRef) => scopeRefsEqual(scope, selected());
  const rowDisabled = () => disabled() || itemsActive();
  const radioIcon = (checked: boolean) =>
    <i class={`mt-1 shrink-0 text-[12px] ${checked ? "bi-record-circle text-neutral-700" : "bi-circle text-neutral-400"}`} />;

  const everythingRow = (close: () => void) => (
    <button type="button" role="radio" aria-checked={isSelected(EVERYTHING_SCOPE)} disabled={rowDisabled()}
      data-picker-autofocus={isSelected(EVERYTHING_SCOPE) ? true : undefined}
      class="flex w-full items-start gap-2 cursor-pointer rounded px-3 py-1.5 text-left hover:bg-control-hover disabled:cursor-default disabled:opacity-50"
      onClick={() => select(EVERYTHING_SCOPE, close)}>
      {radioIcon(isSelected(EVERYTHING_SCOPE))}
      <div class="min-w-0 grow">
        <div class="truncate text-[13px]">Everything</div>
        <div class="text-[11px] text-neutral-500">Everything under your home page, and earlier chats</div>
      </div>
    </button>
  );

  // The row selects the collection; Except selects everything except it. Both are radios of the same group, so the
  // choice is always one reference and the label states it in full.
  const collectionRow = (collection: CollectionSummary, close: () => void) => {
    const include: ScopeRef = { kind: "collection", id: collection.id };
    const except: ScopeRef = { kind: "everythingExcept", id: collection.id };
    return (
      <div class="flex items-start gap-1 rounded pr-2 hover:bg-control-hover">
        <button type="button" role="radio" aria-checked={isSelected(include)} disabled={rowDisabled()}
          data-picker-autofocus={isSelected(include) && filter() == "" ? true : undefined}
          class="flex min-w-0 grow items-start gap-2 cursor-pointer px-3 py-1.5 text-left disabled:cursor-default disabled:opacity-50"
          onClick={() => select(include, close)}>
          {radioIcon(isSelected(include))}
          <div class="min-w-0 grow">
            <div class="flex items-center gap-1 text-[13px]">
              <i class={`${COLLECTION_ICON_CLASS} shrink-0 text-[11px] text-neutral-500`} aria-hidden="true" />
              <span class="truncate">{queryCollectionTitle(collection)}</span>
            </div>
            <div class="truncate text-[11px] text-neutral-500">{queryCollectionDescription(collection)}</div>
          </div>
        </button>
        <button type="button" role="radio" aria-checked={isSelected(except)} disabled={rowDisabled()}
          data-picker-autofocus={isSelected(except) && filter() == "" ? true : undefined}
          aria-label={`Everything except ${queryCollectionTitle(collection)}`}
          title={`Search everything except ${queryCollectionTitle(collection)} and what is inside its members`}
          class={`mt-1.5 shrink-0 cursor-pointer rounded-control border px-1.5 text-[11px] leading-[18px] disabled:cursor-default disabled:opacity-50 ` +
            (isSelected(except) ? "border-neutral-700 bg-control-selected text-black" : "border-control-border bg-white text-neutral-600 hover:text-black")}
          onClick={() => select(except, close)}>Except</button>
      </div>
    );
  };

  const matchesFilter = (collection: CollectionSummary) => {
    const words = filter().trim().toLowerCase().split(/\s+/).filter(word => word != "");
    const text = `${collection.title} ${collection.path.join(" ")}`.toLowerCase();
    return words.every(word => text.includes(word));
  };
  const showFilter = () => (queryCollections()?.length ?? 0) >= COLLECTION_FILTER_MIN_COUNT;
  const sectionHeading = (text: string) => <div class="px-3 pb-0.5 pt-2 text-[11px] font-medium text-neutral-500">{text}</div>;

  return <QueryPickerPopover width={340} disabled={disabled()} buttonRef={props.buttonRef} onTabKey={props.onTabKey}
    buttonClass="max-w-[220px] shrink-[3] cursor-pointer" ariaLabel={`Scope: ${label()}`} title={title()}
    label={<><i class={warning() ? "bi-exclamation-triangle shrink-0 text-[11px] text-amber-600" : "bi-funnel shrink-0 text-[11px]"} />
      <span class="min-w-0 truncate">{label()}</span></>}
    onOpen={() => {
      setFilter("");
      void store.general.queryProfiles.refresh();
      void refreshQueryCollections(store);
      void describeQueryScopeItems(scopeItems(), true);
    }}>
    {close => <>
      <DialogHeader title="Scope"
        description="Limits what Infumap search can find. Web tools and attachments are not affected.">
        <Show when={props.note?.()}><div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>{props.note!()}</div></Show>
        <Show when={!itemsActive() && (queryScopeUnavailableText(selected()) ?? queryScopeEmptyText(selected()))}>{text =>
          <div role="status" class="mt-1 text-[11px] text-amber-700">{text()}</div>
        }</Show>
        <Show when={showFilter()}>
          <input data-picker-autofocus type="search" aria-label="Find a collection" placeholder="Find a collection by name or path…"
            class={`mt-1.5 w-full ${DIALOG_INPUT_CLASS}`}
            value={filter()} onInput={ev => setFilter(ev.currentTarget.value)}
            onKeyDown={ev => {
              if (ev.key == "ArrowDown") {
                ev.preventDefault();
                ev.currentTarget.closest("[role='dialog']")?.querySelector<HTMLButtonElement>("button[role='radio']:not([disabled])")?.focus();
              }
            }} />
        </Show>
      </DialogHeader>
      <div class="min-h-0 grow overflow-y-auto">
        <Show when={itemsActive()}>
          <div class="border-b border-chrome-line py-1">
            <div class="flex items-center px-3 py-1 text-[12px] font-medium text-neutral-600">Chosen items
              <button type="button" class="ml-auto text-[12px] font-normal text-blue-700 hover:underline disabled:cursor-default disabled:opacity-50"
                disabled={disabled()} title="Remove all chosen items, so the scope below is used again" onClick={clearItems}>Clear</button>
            </div>
            <div class="px-3 pb-1 text-[11px] text-neutral-500">Search is limited to these and everything inside them, in place of the scope below.</div>
            <Show when={missingItemsText()}><div class="px-3 pb-1 text-[11px] text-amber-700">{missingItemsText()}</div></Show>
            <For each={scopeItems()}>{itemId =>
              <div class="flex items-center gap-2 px-3 py-1" title={itemId}>
                <i class={`shrink-0 text-[12px] ${queryScopeItemResolved(itemId) ? "bi-funnel text-neutral-500" : "bi-exclamation-triangle text-amber-600"}`} />
                <div class="min-w-0 grow truncate text-[13px]" classList={{ "text-amber-700": !queryScopeItemResolved(itemId) }}>
                  {queryScopeItemTitle(itemId)}
                </div>
                <button type="button" class="h-5 w-5 shrink-0 rounded text-neutral-500 hover:bg-control-hover hover:text-black disabled:cursor-default disabled:opacity-50"
                  disabled={disabled()} aria-label={`Remove ${queryScopeItemTitle(itemId)} from the scope`} title="Remove"
                  onClick={() => removeItem(itemId)}><i class="bi-x-lg text-[11px]" /></button>
              </div>
            }</For>
          </div>
        </Show>
        <div class="py-1" classList={{ "opacity-60": itemsActive() }} role="radiogroup" aria-label="Infumap search scope">
          <Show when={itemsActive()}><div class="px-3 py-1 text-[11px] text-neutral-500">Used again when the chosen items are cleared.</div></Show>
          <Show when={filter() == ""}>{everythingRow(close)}</Show>
          {/* The saved choice that can no longer be used stays visible, selected, until another is chosen. */}
          <Show when={filter() == "" && unavailable()}>
            <div role="radio" aria-checked="true" aria-disabled="true" data-picker-autofocus
              class="flex w-full items-start gap-2 px-3 py-1.5 text-left opacity-70">
              {radioIcon(true)}
              <div class="min-w-0 grow">
                <div class="truncate text-[13px] text-amber-700">{queryScopeName(selected())}</div>
                <div class="text-[11px] text-neutral-500">Covers nothing until you choose another scope</div>
              </div>
            </div>
          </Show>
          <Show when={queryCollections() == null && queryCollectionsError() == null}><div class="px-3 py-2 text-[12px] text-neutral-500">Loading collections…</div></Show>
          <Show when={queryCollectionsError()}><div class="px-3 py-2 text-[12px] text-red-700">{queryCollectionsError()} Reopen to try again.</div></Show>
          <Show when={queryCollections()?.length == 0}>
            <div class={`px-3 py-2 ${DIALOG_NOTE_CLASS}`}>
              No collections yet. To make one, choose <b>Make collection</b> in a page's <i class="bi-three-dots" aria-label="More actions" /> menu.
              The items it links to are its members.
            </div>
          </Show>
          <Show when={filter() == "" && queryHereCollections().length > 0}>
            {sectionHeading("Here")}
            <For each={queryHereCollections()}>{collection => collectionRow(collection, close)}</For>
          </Show>
          <Show when={(queryCollections()?.length ?? 0) > 0}>
            {sectionHeading("All collections")}
            <For each={(queryCollections() ?? []).filter(matchesFilter)}
              fallback={<div class={`px-3 py-1.5 ${DIALOG_NOTE_CLASS}`}>No collection matches.</div>}>
              {collection => collectionRow(collection, close)}
            </For>
          </Show>
        </div>
      </div>
    </>}
  </QueryPickerPopover>;
}
