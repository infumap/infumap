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

import { For, Show, createSignal } from "solid-js";
import { collectionModeActive, collectionModeCollectionId, enterCollectionMode } from "../../items/collection-mode";
import {
  queryCollectionDescription, queryCollectionTitle, queryCollections, queryCollectionsError, queryHereCollections,
  refreshQueryCollections,
} from "../../items/query-scope";
import type { CollectionSummary } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { COLLECTION_ICON_CLASS } from "../library/CollectionGlyph";
import { DIALOG_INPUT_CLASS, DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";
import { QueryPickerPopover } from "../items/QueryPickerPopover";

/** Below this many collections, the list is short enough to scan without a filter. As in the scope picker. */
const COLLECTION_FILTER_MIN_COUNT = 7;

/**
 * The toolbar's Collections button. Choosing a collection enters collection mode for it, or switches to it, and
 * leaves the user where they are: curating happens from the current location. Shown whatever has focus, since
 * collections relate to where the user is, not to the focused item.
 */
export function Toolbar_Collections() {
  const store = useStore();
  const [filter, setFilter] = createSignal("");

  const matchesFilter = (collection: CollectionSummary) => {
    const words = filter().trim().toLowerCase().split(/\s+/).filter(word => word != "");
    const text = `${collection.title} ${collection.path.join(" ")}`.toLowerCase();
    return words.every(word => text.includes(word));
  };
  const showFilter = () => (queryCollections()?.length ?? 0) >= COLLECTION_FILTER_MIN_COUNT;
  const sectionHeading = (text: string) => <div class="px-3 pb-0.5 pt-2 text-[11px] font-medium text-neutral-500">{text}</div>;

  const row = (collection: CollectionSummary, close: () => void) => {
    const current = () => collection.id == collectionModeCollectionId();
    return (
      <button type="button" role="radio" aria-checked={current()}
        data-picker-autofocus={current() && filter() == "" ? true : undefined}
        class={`flex w-full items-start gap-2 cursor-pointer rounded px-3 py-1.5 text-left ` +
          (current() ? "bg-control-selected" : "hover:bg-control-hover")}
        onClick={() => {
          close();
          // The popover returns focus to the toolbar button, where the app leaves keys alone; Escape must reach the
          // app to leave the mode. Runs after the popover's own refocus.
          queueMicrotask(() => { if (document.activeElement instanceof HTMLElement) { document.activeElement.blur(); } });
          enterCollectionMode(store, collection);
        }}>
        <i class={`${COLLECTION_ICON_CLASS} mt-[3px] shrink-0 text-[12px] text-neutral-500`} aria-hidden="true" />
        <div class="min-w-0 grow">
          <div class="truncate text-[13px]">{queryCollectionTitle(collection)}</div>
          <div class="truncate text-[11px] text-neutral-500">{queryCollectionDescription(collection)}</div>
        </div>
      </button>
    );
  };

  // Styled as the toolbar's other icon buttons (InfuIconButton), highlighted while a collection is being curated.
  const buttonAppearance = () => ({
    class: "rounded-control w-[21px] h-[21px] inline-block text-center cursor-pointer ml-[3px] text-[14px] relative " +
      "text-neutral-800 align-top " + (collectionModeActive() ? "bg-control-selected" : "hover:bg-control-hover"),
    // Top-aligned, the button sits 2px above InfuIconButton's baseline-aligned div; `relative` lets it move down.
    style: "line-height: 21px; top: 2px;",
  });

  return <QueryPickerPopover width={340} buttonAppearance={buttonAppearance()}
    title={collectionModeActive() ? "Collections: curating one now" : "Collections"} ariaLabel="Collections"
    label={<i class={COLLECTION_ICON_CLASS} aria-hidden="true" />}
    onOpen={() => { setFilter(""); void refreshQueryCollections(store); }}>
    {close => <>
      <DialogHeader title="Collections"
        description="Choose one to add items to it or remove them, from wherever you are.">
        <Show when={showFilter()}>
          <input data-picker-autofocus type="search" aria-label="Find a collection" placeholder="Find a collection by name or path…"
            class={`mt-1.5 w-full ${DIALOG_INPUT_CLASS}`}
            value={filter()} onInput={ev => setFilter(ev.currentTarget.value)}
            onKeyDown={ev => {
              if (ev.key == "ArrowDown") {
                ev.preventDefault();
                ev.currentTarget.closest("[role='dialog']")?.querySelector<HTMLButtonElement>("button[role='radio']")?.focus();
              }
            }} />
        </Show>
      </DialogHeader>
      <div class="min-h-0 grow overflow-y-auto py-1" role="radiogroup" aria-label="Collections">
        <Show when={queryCollections() == null && queryCollectionsError() == null}>
          <div class="px-3 py-2 text-[12px] text-neutral-500">Loading collections…</div>
        </Show>
        <Show when={queryCollectionsError()}>
          <div class="px-3 py-2 text-[12px] text-red-700">{queryCollectionsError()} Reopen to try again.</div>
        </Show>
        <Show when={queryCollections()?.length == 0}>
          <div class={`px-3 py-2 ${DIALOG_NOTE_CLASS}`}>
            No collections yet. To make one, choose <b>Make collection</b> in a page's <i class="bi-three-dots" aria-label="More actions" /> menu.
            The items it links to are its members.
          </div>
        </Show>
        <Show when={filter() == "" && queryHereCollections().length > 0}>
          {sectionHeading("Here")}
          <For each={queryHereCollections()}>{collection => row(collection, close)}</For>
        </Show>
        <Show when={(queryCollections()?.length ?? 0) > 0}>
          {sectionHeading("All collections")}
          <For each={(queryCollections() ?? []).filter(matchesFilter)}
            fallback={<div class={`px-3 py-1.5 ${DIALOG_NOTE_CLASS}`}>No collection matches.</div>}>
            {collection => row(collection, close)}
          </For>
        </Show>
      </div>
    </>}
  </QueryPickerPopover>;
}
