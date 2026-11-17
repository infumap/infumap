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

import { Show, createEffect, on, onCleanup } from "solid-js";
import { collectionMark, refreshCollectionMarks, retainCollectionMark } from "../../items/collection-marks";
import {
  collectionModeCollectionListed, collectionModeFailure, collectionModeNotice, collectionModeSaving,
  collectionModeSummary, collectionModeUndo, exitCollectionMode, toggleCollectionMember,
} from "../../items/collection-mode";
import { isPage } from "../../items/page-item";
import { IS_MAC } from "../../util/platform";
import { Uid } from "../../util/uid";
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

  // Membership changes through the selection gestures (see applyCollectionClick), so plain clicking, editing and
  // navigating behave as outside the mode.
  const unavailable = () => !collectionModeCollectionListed();

  // The page the user is on, or the page open in a popup: neither can be clicked or swept.
  const thisPageId = (): Uid | null => {
    const popupId = store.history.currentPopupSpecVeid()?.itemId;
    const popupItem = popupId == null ? null : itemState.get(popupId);
    if (popupItem != null && isPage(popupItem)) { return popupItem.id; }
    return store.history.currentPageVeid()?.itemId ?? null;
  };
  createEffect(() => {
    const id = thisPageId();
    if (id == null || summary() == null) { return; }
    onCleanup(retainCollectionMark(id));
  });
  const thisPageIsMember = () => { const id = thisPageId(); return id != null && collectionMark(id)?.kind == "direct"; };
  const thisPageIsCollection = () => thisPageId() == summary()?.id;

  const status = () => {
    if (collectionModeSaving()) { return "Saving…"; }
    if (collectionModeNotice() != null) { return collectionModeNotice()!; }
    return `${IS_MAC ? "\u2318" : "Ctrl+"}click an item to add or remove it, or drag across items to add them all`;
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
          <span class="min-w-0 shrink-[8] truncate text-neutral-500">{summary()!.path.join(" / ")}</span>
        </Show>
        <span class="shrink-0 text-neutral-500">· {members()}</span>
        <Show when={!collectionModeCollectionListed()}>
          <span class="shrink-0 text-amber-700" title="It was deleted, moved to the trash or made an ordinary page.">
            No longer a collection
          </span>
        </Show>
        <div class="ml-2 flex shrink-0 items-center gap-1">
          <button type="button" class={dialogButtonClass()}
            disabled={unavailable() || thisPageId() == null || thisPageIsCollection()}
            title={thisPageIsCollection() ? "This is the collection page."
              : thisPageIsMember() ? "Stop the page you are on, or the open popup, being a member."
                : "Make the page you are on, or the open popup, a member."}
            onClick={() => { const id = thisPageId(); if (id != null) { toggleCollectionMember(store, id); } }}>
            {thisPageIsMember() ? "Remove this page" : "Add this page"}
          </button>
        </div>
        <Show when={collectionModeFailure()} fallback={
          <span class="flex min-w-0 grow items-center gap-2 text-[12px] text-neutral-600">
            <span class="min-w-0 truncate" role="status" title={status()}>{status()}</span>
            <Show when={!collectionModeSaving() && collectionModeUndo()}>{undo =>
              <button type="button" class={`shrink-0 ${dialogButtonClass()}`} title="Reverse the last change"
                onClick={() => undo()()}>Undo</button>
            }</Show>
          </span>
        }>{failure =>
          <span class="flex min-w-0 grow items-center gap-2 text-[12px] text-red-700" role="alert">
            <span class="min-w-0 truncate" title={failure().message}>{failure().message}</span>
            <button type="button" class={`shrink-0 ${dialogButtonClass()}`} onClick={() => failure().retry()}>Retry</button>
          </span>
        }</Show>
        <button type="button" class={`shrink-0 ${dialogButtonClass()}`} title="Leave collection mode (Esc)"
          onClick={() => exitCollectionMode(store)}>Done</button>
      </div>
    </Show>
  );
}
