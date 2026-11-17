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

import { Show, createEffect, on } from "solid-js";
import { refreshCollectionMarks } from "../../items/collection-marks";
import { collectionModeCollectionListed, collectionModeSummary, exitCollectionMode } from "../../items/collection-mode";
import { queryCollectionTitle } from "../../items/query-scope";
import { initiateLoadItemMaybe } from "../../layout/load";
import { switchToPage } from "../../layout/navigation";
import { itemState } from "../../store/ItemState";
import { useStore } from "../../store/StoreProvider";
import { LIGHT_BORDER_COLOR } from "../../style";
import { COLLECTION_ICON_CLASS } from "../library/CollectionGlyph";
import { dialogButtonClass } from "../library/dialogStyle";

/** The colour of membership marks, so the bar reads as the key to them. */
export const COLLECTION_MODE_COLOR = "#16a34a";

/**
 * Says which collection is being curated, as the user moves about Infumap. Only shown with the toolbar; the desktop
 * starts below it (see `topToolbarHeightPx`). Like the toolbar, it has no z-index and is drawn after the desktop.
 */
export function CollectionModeBar() {
  const store = useStore();
  // Marks already known are checked again on navigation, which picks up changes this tab was not syncing, such as
  // members added in another tab to a collection page not loaded here.
  createEffect(on(() => store.history.currentPageVeid()?.itemId, () => refreshCollectionMarks(0), { defer: true }));
  const summary = () => collectionModeSummary();
  // The collection page is often somewhere the client has not loaded, so load it before navigating there.
  const openCollection = async () => {
    const collection = summary();
    if (collection == null) { return; }
    if (itemState.get(collection.id) == null) {
      store.history.beginNavigationRequest();
      await initiateLoadItemMaybe(store, collection.id);
      if (itemState.get(collection.id) == null) { return; }
    }
    switchToPage(store, { itemId: collection.id, linkIdMaybe: null }, true, false, false);
  };
  const members = () => {
    const count = summary()?.memberCount ?? 0;
    return `${count} member${count == 1 ? "" : "s"}`;
  };

  return (
    <Show when={store.collectionBarHeightPx() > 0 && summary() != null}>
      <div role="region" aria-label="Collection mode"
        class="fixed left-0 right-0 flex items-center gap-2 border-b px-3 text-[13px] text-neutral-800 print:hidden"
        style={`top: ${store.toolbarHeightPx()}px; height: ${store.collectionBarHeightPx()}px; ` +
          `background-color: #f0fdf4; border-bottom-color: ${LIGHT_BORDER_COLOR};`}
        onMouseDown={ev => ev.stopPropagation()} onMouseUp={ev => ev.stopPropagation()}
        onMouseMove={ev => ev.stopPropagation()}>
        <i class={`${COLLECTION_ICON_CLASS} shrink-0 text-[13px]`} style={`color: ${COLLECTION_MODE_COLOR};`} aria-hidden="true" />
        <span class="shrink-0 text-neutral-500">Curating</span>
        <button type="button" class="min-w-0 max-w-[40%] shrink truncate cursor-pointer font-semibold hover:underline"
          title="Open the collection page" onClick={() => { void openCollection(); }}>
          {queryCollectionTitle(summary()!)}
        </button>
        <Show when={summary()!.path.length > 0}>
          <span class="min-w-0 shrink-[2] truncate text-neutral-500">{summary()!.path.join(" / ")}</span>
        </Show>
        <span class="shrink-0 text-neutral-500">· {members()}</span>
        <Show when={!collectionModeCollectionListed()}>
          <span class="shrink-0 text-amber-700" title="It was deleted, moved to the trash or made an ordinary page.">
            No longer a collection
          </span>
        </Show>
        <div class="grow" />
        <button type="button" class={`shrink-0 ${dialogButtonClass()}`} title="Leave collection mode (Esc)"
          onClick={() => exitCollectionMode(store)}>Done</button>
      </div>
    </Show>
  );
}
