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

import { Component, Show, onCleanup, onMount } from "solid-js";
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { useStore } from "../../../store/StoreProvider";
import { asLinkItem, isLink } from "../../../items/link-item";
import { requestArrange } from "../../../layout/arrange";
import { serverOrRemote } from "../../../server";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { getToolbarFocusItem } from "../toolbarFocus";
import { itemState } from "../../../store/ItemState";


export const Toolbar_Link: Component = () => {
  const store = useStore();

  let linkResourceInput: HTMLInputElement | undefined;

  const linkItem = () => asLinkItem(getToolbarFocusItem(store));
  const linkItemOnMount = linkItem();
  const canEditOnMount = itemCanEdit(linkItemOnMount);
  const canEdit = () => itemCanEdit(linkItem());

  onMount(() => {
    if (!canEditOnMount || !linkResourceInput) {
      return;
    }
    linkResourceInput!.value = linkItem().linkTo;
    linkResourceInput!.focus();
  });

  onCleanup(() => {
    if (!canEditOnMount || !linkResourceInput) {
      return;
    }
    const previousLinkTo = linkItemOnMount.linkTo;
    let newLinkTo = linkResourceInput!.value;
    // links do not chain: a link to a link becomes a link to that link's target.
    const newTargetMaybe = itemState.get(newLinkTo);
    if (newTargetMaybe != null && isLink(newTargetMaybe)) {
      newLinkTo = asLinkItem(newTargetMaybe).linkTo;
      if (newLinkTo != previousLinkTo) {
        showTransientMessage("linked to target of link", TransientMessageType.Info);
      }
    }
    if (previousLinkTo == newLinkTo) {
      requestArrange(store, "toolbar-link-target-change");
      serverOrRemote.updateItem(linkItemOnMount, store.general.networkStatus);
      return;
    }

    setLinkTo(newLinkTo);
    requestArrange(store, "toolbar-link-target-change");
    // the server rejects a target that is a link, which can't be checked here if the target is not loaded.
    serverOrRemote.updateItem(linkItemOnMount, store.general.networkStatus).catch(() => {
      if (linkItemOnMount.linkTo != newLinkTo) { return; }
      setLinkTo(previousLinkTo);
      requestArrange(store, "toolbar-link-target-revert");
      showTransientMessage("could not change link target", TransientMessageType.Error);
    });
  });

  const setLinkTo = (linkTo: string) => {
    linkItemOnMount.linkTo = linkTo;
    // a resolved id refers to the previous target.
    linkItemOnMount.linkToResolvedId = null;
    // if the new target is not yet loaded, the link sorts last until the load completes and re-sorts.
    itemState.sortParentChildrenIfTitleOrdered(linkItemOnMount);
  }

  const showTransientMessage = (text: string, type: TransientMessageType) => {
    store.overlay.toolbarTransientMessage.set({ text, type });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1500);
  }

  const keyEventHandler = (_ev: KeyboardEvent) => { }

  return (
    <div id="toolbarItemOptionsDiv"
         class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <div class="inline-block ml-[8px]">
            <span class="mr-[6px]">link to:</span>
            <input ref={linkResourceInput}
                   class="pl-[7px] pt-[4px] pb-[4px] w-[420px] text-slate-800 font-mono text-sm"
                   type="text"
                   spellcheck={false}
                   onKeyDown={keyEventHandler}
                   onKeyUp={keyEventHandler}
                   onKeyPress={keyEventHandler} />
          </div>
        </Show>

        <Toolbar_ItemOrdering />

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

        <Toolbar_InfoAndId />
      </div>
    </div>
  );
}
