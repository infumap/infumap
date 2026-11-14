/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { For } from "solid-js";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { switchToPage } from "../../layout/navigation";
import { itemState } from "../../store/ItemState";
import { useStore } from "../../store/StoreProvider";
import type { Uid } from "../../util/uid";

/**
 * Icons for the search status pages, which are not listed in the queries page. The server sends them as virtual
 * children of the queries page, with the count in the title ("Search processing (7, checking)"), and container sync
 * keeps them current. Clicking one navigates to its page, so right click comes back.
 */
export function QuerySearchStatusLinks(props: { style: string }) {
  const store = useStore();

  const pages = (): Array<{ id: Uid, icon: string, attention: boolean }> => {
    const user = store.user.getUserMaybe();
    if (user == null) { return []; }
    return [
      { id: user.searchAttentionPageId, icon: "bi-exclamation-triangle", attention: true },
      { id: user.searchProcessingPageId, icon: "bi-hourglass-split", attention: false },
    ];
  };

  // Container sync touches the toolbar after applying changes, which is how a title change reaches here.
  const title = (id: Uid): string | null => {
    store.touchToolbarDependency();
    const item = itemState.get(id);
    return item != null && isTitledItem(item) ? asTitledItem(item).title : null;
  };

  const count = (title: string): number => {
    const match = /\((\d+)/.exec(title);
    return match ? parseInt(match[1]) : 0;
  };

  return (
    <div class="absolute flex items-center gap-3 text-[12px] text-neutral-400" style={props.style}>
      <For each={pages()}>{page => {
        const pageTitle = () => title(page.id);
        return (
          <button type="button" class="flex cursor-pointer items-center gap-1 hover:text-neutral-700"
            classList={{ "hidden": pageTitle() == null, "text-amber-600": page.attention && count(pageTitle() ?? "") > 0 }}
            title={pageTitle() ?? ""} aria-label={pageTitle() ?? ""}
            onMouseDown={ev => {
              ev.preventDefault();
              ev.stopPropagation();
              switchToPage(store, { itemId: page.id, linkIdMaybe: null }, true, false, false);
            }}
            onMouseUp={ev => {
              ev.preventDefault();
              ev.stopPropagation();
            }}>
            <i class={page.icon} />
            <span>{count(pageTitle() ?? "")}</span>
          </button>
        );
      }}</For>
    </div>
  );
}
