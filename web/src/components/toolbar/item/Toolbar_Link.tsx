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
import { TOOLBAR_INFO_DIVIDER_RIGHT_PX } from "../toolbarDividers";
import { ItemCandidatesPopup, createItemCandidateSearch } from "../../library/ItemCandidates";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../../constants";
import { TOOLBAR_POPUP_CLASS, toolbarPopupTopPx } from "../toolbarPopupStyle";

export const Toolbar_Link: Component = () => {
  const store = useStore();

  let linkResourceInput: HTMLInputElement | undefined;

  const linkItem = () => asLinkItem(getToolbarFocusItem(store));
  const linkItemOnMount = linkItem();
  const canEditOnMount = itemCanEdit(linkItemOnMount);
  const canEdit = () => itemCanEdit(linkItem());
  // candidates are the user's own items. These are what a bare id resolves to, even in a link served by a remote host.
  const canFindTargetsOnMount = canEditOnMount;

  const candidateSearch = createItemCandidateSearch({
    anchor: () => linkResourceInput,
    onPick: candidate => {
      linkResourceInput!.value = candidate.id;
      commitLinkTo();
    },
  });

  onMount(() => {
    if (!canEditOnMount || !linkResourceInput) {
      return;
    }
    linkResourceInput!.value = linkItem().linkTo;
    linkResourceInput!.focus();
  });

  onCleanup(() => {
    commitLinkTo();
  });

  const inputHandler = () => {
    if (!canFindTargetsOnMount || !linkResourceInput) {
      return;
    }
    candidateSearch.search(linkResourceInput.value);
  }

  // commits the target in the input. Does nothing if it is unchanged, so it can run before the toolbar closes.
  const commitLinkTo = () => {
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
      return;
    }

    setLinkTo(newLinkTo);
    requestArrange(store, "toolbar-link-target-change");
    // the server rejects a target that is a link, which can't be checked here if the target is not loaded.
    serverOrRemote.updateItem(linkItemOnMount).catch(() => {
      if (linkItemOnMount.linkTo != newLinkTo) { return; }
      setLinkTo(previousLinkTo);
      // the toolbar may still be open if the target was committed before it closed.
      if (linkResourceInput!.value == newLinkTo) { linkResourceInput!.value = previousLinkTo; }
      requestArrange(store, "toolbar-link-target-revert");
      showTransientMessage("could not change link target", TransientMessageType.Error);
    });
  }

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

  const keyDownHandler = (ev: KeyboardEvent) => {
    candidateSearch.keyDown(ev);
  }

  return (
    <div id="toolbarItemOptionsDiv"
         class="grow-0" style="flex-order: 0">
      <div class="inline-block">
        <Show when={canEdit()}>
          <div class="inline-block ml-[8px]">
            <span class="mr-[6px]">link to item:</span>
            <input ref={linkResourceInput}
                   class="pl-[7px] pt-[4px] pb-[4px] w-[420px] text-slate-800 font-mono text-sm placeholder:text-slate-400"
                   type="text"
                   spellcheck={false}
                   placeholder="search titles, or id / http(s)://<host>/<id>"
                   title="Type to search your items by title, or enter the id of the item to link to, or http(s)://<host>/<id> for an item on another Infumap instance"
                   onInput={inputHandler}
                   onBlur={candidateSearch.close}
                   onKeyDown={keyDownHandler}
                   onKeyUp={keyEventHandler}
                   onKeyPress={keyEventHandler} />
          </div>
        </Show>

        <ItemCandidatesPopup search={candidateSearch}
                             class={`${TOOLBAR_POPUP_CLASS} py-[3px] overflow-hidden`}
                             style={`position: fixed; left: ${candidateSearch.anchorBoundsPx()?.x ?? 0}px; top: ${toolbarPopupTopPx(store)}px; ` +
                               `width: ${candidateSearch.anchorBoundsPx()?.width ?? 0}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY};`} />

        <Toolbar_ItemOrdering />

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style={`height: 25px; right: ${TOOLBAR_INFO_DIVIDER_RIGHT_PX}px; top: 7px;`}></div>

        <Toolbar_InfoAndId />
      </div>
    </div>
  );
}
