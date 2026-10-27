/*
  Copyright (C) The Infumap Authors
  SPDX-License-Identifier: AGPL-3.0-or-later
*/

import { Accessor, For, JSX, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { LinkTargetCandidate, server } from "../../server";
import { isUid } from "../../util/uid";

const ITEM_CANDIDATES_LIMIT = 10;
const ITEM_CANDIDATES_DEBOUNCE_MS = 150;

/** Search of the user's items by title, for an input that also accepts an id or URL. */
export interface ItemCandidateSearch {
  candidates: Accessor<Array<LinkTargetCandidate>>,
  selectedIdx: Accessor<number>,
  setSelectedIdx: (idx: number) => void,
  /** True once a response for the input arrives, so that no matches can be shown as such. */
  shown: Accessor<boolean>,
  /** The anchor's bounds when the shown candidates arrived, for placing them. */
  anchorBoundsPx: Accessor<DOMRect | null>,
  /** Searches for the text after a pause. Ids and URLs are not searched. */
  search: (text: string) => void,
  /** Cancels a pending search and hides the candidates. */
  close: () => void,
  pick: (candidate: LinkTargetCandidate) => void,
  /** Arrow keys, Enter and Escape while candidates are shown. Returns whether the key was handled. */
  keyDown: (ev: KeyboardEvent) => boolean,
}

/** Pending searches are cancelled when the owning component is cleaned up. */
export function createItemCandidateSearch(options: {
  anchor: () => HTMLElement | undefined,
  onPick: (candidate: LinkTargetCandidate) => void,
}): ItemCandidateSearch {
  const [candidates, setCandidates] = createSignal<Array<LinkTargetCandidate>>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  const [shown, setShown] = createSignal(false);
  const [anchorBoundsPx, setAnchorBoundsPx] = createSignal<DOMRect | null>(null);
  // incremented on each input, so responses to earlier input are dropped.
  let requestNumber = 0;
  let debounceTimeout: number | null = null;

  const cancel = () => {
    requestNumber += 1;
    if (debounceTimeout != null) {
      clearTimeout(debounceTimeout);
      debounceTimeout = null;
    }
  }

  const clear = () => {
    setShown(false);
    setCandidates([]);
    setSelectedIdx(0);
  }

  const close = () => {
    cancel();
    clear();
  }

  onCleanup(cancel);

  // the current candidates stay shown until the response for the new input arrives, so they don't flicker while typing.
  const search = (rawText: string) => {
    cancel();
    const text = rawText.trim();
    // the server returns nothing for fewer than 2 characters.
    if (text.length < 2 || isUid(text) || text.toLowerCase().startsWith("http")) {
      clear();
      return;
    }
    const number = requestNumber;
    debounceTimeout = window.setTimeout(() => {
      debounceTimeout = null;
      server.linkTargetCandidates(text, ITEM_CANDIDATES_LIMIT)
        .then((response) => {
          const anchor = options.anchor();
          if (number != requestNumber || !anchor) { return; }
          setAnchorBoundsPx(anchor.getBoundingClientRect());
          setCandidates(response.candidates);
          setSelectedIdx(0);
          setShown(true);
        })
        .catch(() => {
          // the failure is shown in the network status.
          if (number != requestNumber) { return; }
          clear();
        });
    }, ITEM_CANDIDATES_DEBOUNCE_MS);
  }

  const pick = (candidate: LinkTargetCandidate) => {
    close();
    options.onPick(candidate);
  }

  const keyDown = (ev: KeyboardEvent): boolean => {
    // Enter confirms an IME composition.
    if (!shown() || ev.isComposing) {
      return false;
    }
    const count = candidates().length;
    if (ev.code == "ArrowDown" && count > 0) {
      setSelectedIdx(Math.min(selectedIdx() + 1, count - 1));
    } else if (ev.code == "ArrowUp" && count > 0) {
      setSelectedIdx(Math.max(selectedIdx() - 1, 0));
    } else if ((ev.code == "Enter" || ev.code == "NumpadEnter") && count > 0) {
      pick(candidates()[selectedIdx()]);
    } else if (ev.code == "Escape") {
      close();
    } else {
      return false;
    }
    ev.preventDefault();
    return true;
  }

  return { candidates, selectedIdx, setSelectedIdx, shown, anchorBoundsPx, search, close, pick, keyDown };
}

/**
 * The candidates, in the body so they are drawn over the page's items. Mouse events are stopped so the desktop does
 * not handle them, and mouse down does not take focus from the input.
 */
export function ItemCandidatesPopup(props: { search: ItemCandidateSearch, class: string, style: string }): JSX.Element {
  return (
    <Show when={props.search.shown()}>
      <Portal mount={document.body}>
        <div class={props.class}
             style={props.style}
             onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); }}
             onMouseUp={ev => ev.stopPropagation()}
             onClick={ev => ev.stopPropagation()}>
          <Show when={props.search.candidates().length > 0}
                fallback={<div class="px-[7px] py-[3px] text-sm text-slate-500">no matching items</div>}>
            <For each={props.search.candidates()}>{(candidate, idx) =>
              <div class={`px-[7px] py-[3px] cursor-pointer ${idx() == props.search.selectedIdx() ? "bg-slate-300" : ""}`}
                   onMouseEnter={() => props.search.setSelectedIdx(idx())}
                   onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); props.search.pick(candidate); }}>
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
  );
}
