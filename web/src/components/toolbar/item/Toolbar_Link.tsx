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

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { useStore } from "../../../store/StoreProvider";
import { asLinkItem, isLink } from "../../../items/link-item";
import { requestArrange } from "../../../layout/arrange";
import { LinkTargetCandidate, server, serverOrRemote } from "../../../server";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { getToolbarFocusItem } from "../toolbarFocus";
import { itemState } from "../../../store/ItemState";
import { TOOLBAR_INFO_DIVIDER_RIGHT_PX } from "../toolbarDividers";
import { isUid } from "../../../util/uid";
import { Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../../constants";
import { TOOLBAR_POPUP_CLASS, toolbarPopupTopPx } from "../toolbarPopupStyle";

const LINK_TARGET_CANDIDATES_LIMIT = 10;
const LINK_TARGET_CANDIDATES_DEBOUNCE_MS = 150;

export const Toolbar_Link: Component = () => {
  const store = useStore();

  let linkResourceInput: HTMLInputElement | undefined;

  const linkItem = () => asLinkItem(getToolbarFocusItem(store));
  const linkItemOnMount = linkItem();
  const canEditOnMount = itemCanEdit(linkItemOnMount);
  const canEdit = () => itemCanEdit(linkItem());
  // candidates are the user's own items. These are what a bare id resolves to, even in a link served by a remote host.
  const canFindTargetsOnMount = canEditOnMount;

  const [candidates, setCandidates] = createSignal<Array<LinkTargetCandidate>>([]);
  const [selectedCandidateIdx, setSelectedCandidateIdx] = createSignal(0);
  // true once a response for the input arrives, so that no matches can be shown as such.
  const [candidatesShown, setCandidatesShown] = createSignal(false);
  const [candidatesBoundsPx, setCandidatesBoundsPx] = createSignal({ x: 0, w: 0 });
  // incremented on each input, so responses to earlier input are dropped.
  let candidatesRequestNumber = 0;
  let candidatesDebounceTimeout: number | null = null;

  onMount(() => {
    if (!canEditOnMount || !linkResourceInput) {
      return;
    }
    linkResourceInput!.value = linkItem().linkTo;
    linkResourceInput!.focus();
  });

  onCleanup(() => {
    cancelCandidatesRequest();
    commitLinkTo();
  });

  const cancelCandidatesRequest = () => {
    candidatesRequestNumber += 1;
    if (candidatesDebounceTimeout != null) {
      clearTimeout(candidatesDebounceTimeout);
      candidatesDebounceTimeout = null;
    }
  }

  const clearCandidates = () => {
    setCandidatesShown(false);
    setCandidates([]);
    setSelectedCandidateIdx(0);
  }

  const pickCandidate = (candidate: LinkTargetCandidate) => {
    cancelCandidatesRequest();
    clearCandidates();
    linkResourceInput!.value = candidate.id;
    commitLinkTo();
  }

  const blurHandler = () => {
    cancelCandidatesRequest();
    clearCandidates();
  }

  // the current candidates stay shown until the response for the new input arrives, so they don't flicker while typing.
  const inputHandler = () => {
    if (!canFindTargetsOnMount || !linkResourceInput) {
      return;
    }
    cancelCandidatesRequest();
    const text = linkResourceInput.value.trim();
    // the server returns nothing for fewer than 2 characters.
    if (text.length < 2 || isUid(text) || text.toLowerCase().startsWith("http")) {
      clearCandidates();
      return;
    }
    const requestNumber = candidatesRequestNumber;
    candidatesDebounceTimeout = window.setTimeout(() => {
      candidatesDebounceTimeout = null;
      server.linkTargetCandidates(text, LINK_TARGET_CANDIDATES_LIMIT)
        .then((response) => {
          if (requestNumber != candidatesRequestNumber || !linkResourceInput) { return; }
          const inputBounds = linkResourceInput.getBoundingClientRect();
          setCandidatesBoundsPx({ x: inputBounds.x, w: inputBounds.width });
          setCandidates(response.candidates);
          setSelectedCandidateIdx(0);
          setCandidatesShown(true);
        })
        .catch(() => {
          // the failure is shown in the network status.
          if (requestNumber != candidatesRequestNumber) { return; }
          clearCandidates();
        });
    }, LINK_TARGET_CANDIDATES_DEBOUNCE_MS);
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
    // Enter confirms an IME composition.
    if (!candidatesShown() || ev.isComposing) {
      return;
    }
    const count = candidates().length;
    if (ev.code == "ArrowDown" && count > 0) {
      ev.preventDefault();
      setSelectedCandidateIdx(Math.min(selectedCandidateIdx() + 1, count - 1));
    } else if (ev.code == "ArrowUp" && count > 0) {
      ev.preventDefault();
      setSelectedCandidateIdx(Math.max(selectedCandidateIdx() - 1, 0));
    } else if ((ev.code == "Enter" || ev.code == "NumpadEnter") && count > 0) {
      ev.preventDefault();
      pickCandidate(candidates()[selectedCandidateIdx()]);
    } else if (ev.code == "Escape") {
      ev.preventDefault();
      cancelCandidatesRequest();
      clearCandidates();
    }
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
                   onBlur={blurHandler}
                   onKeyDown={keyDownHandler}
                   onKeyUp={keyEventHandler}
                   onKeyPress={keyEventHandler} />
          </div>
        </Show>

        <Show when={candidatesShown()}>
          {/* in the body, so it is drawn over the page's items. Mouse events are stopped so the desktop does not handle them. */}
          <Portal mount={document.body}>
            <div class={`${TOOLBAR_POPUP_CLASS} py-[3px] overflow-hidden`}
                 style={`position: fixed; left: ${candidatesBoundsPx().x}px; top: ${toolbarPopupTopPx(store)}px; ` +
                   `width: ${candidatesBoundsPx().w}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY};`}
                 onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); }}
                 onMouseUp={ev => ev.stopPropagation()}
                 onClick={ev => ev.stopPropagation()}>
              <Show when={candidates().length > 0}
                    fallback={<div class="px-[7px] py-[3px] text-sm text-slate-500">no matching items</div>}>
                <For each={candidates()}>{(candidate, idx) =>
                  <div class={`px-[7px] py-[3px] cursor-pointer ${idx() == selectedCandidateIdx() ? "bg-slate-300" : ""}`}
                       onMouseEnter={() => setSelectedCandidateIdx(idx())}
                       onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); pickCandidate(candidate); }}>
                    <div class="flex flex-row items-baseline text-sm text-slate-800">
                      <span class="truncate">{candidate.title}</span>
                      <span class="ml-auto pl-[8px] shrink-0 text-xs text-slate-500">{candidate.itemType}</span>
                    </div>
                    <div class="truncate text-xs text-slate-500">
                      {candidate.path.map(element => element.title ?? "").join(" › ")}
                    </div>
                  </div>
                }</For>
              </Show>
            </div>
          </Portal>
        </Show>

        <Toolbar_ItemOrdering />

        {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
        <div class="fixed border-r border-slate-300" style={`height: 25px; right: ${TOOLBAR_INFO_DIVIDER_RIGHT_PX}px; top: 7px;`}></div>

        <Toolbar_InfoAndId />
      </div>
    </div>
  );
}
