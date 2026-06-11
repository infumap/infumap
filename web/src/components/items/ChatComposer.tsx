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

import { Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { arrangeNow } from "../../layout/arrange";
import { VeFns } from "../../layout/visual-element";
import { LINE_HEIGHT_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL } from "../../constants";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { chatProgressForPage, isChatPage, materializeChatPage, submitChatMessage } from "../../items/chat";
import { asPageItem } from "../../items/page-item";
import {
  isTempQueryChatPageUid,
  SEARCH_WORKSPACE_CONTROLS_GAP_PX,
  SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX,
} from "../../items/search-item";
import { useStore } from "../../store/StoreProvider";
import { PageVisualElementProps } from "./Page";

const MIN_COMPOSER_HEIGHT_PX = SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX;
const MAX_COMPOSER_HEIGHT_PX = 164;
const COMPOSER_BOTTOM_PX = 18;
const SEND_BUTTON_WIDTH_PX = SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX;
const MATERIALIZE_BUTTON_WIDTH_PX = 118;
const CHAT_PROGRESS_HEIGHT_PX = 24;

export const ChatComposer: Component<PageVisualElementProps> = (props) => {
  const store = useStore();
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [materializing, setMaterializing] = createSignal(false);
  const [composerHeightPx, setComposerHeightPx] = createSignal(MIN_COMPOSER_HEIGHT_PX);
  let textarea: HTMLTextAreaElement | undefined;

  const pageFns = () => props.pageFns;
  const page = () => asPageItem(pageFns().pageItem());
  const enabled = () => isChatPage(page()) && itemCanEdit(page());
  const hasContent = () => page().computed_children.length > 0;
  const isDraft = () => page().clientOnly === true;
  const canMaterialize = () => isDraft() && !isTempQueryChatPageUid(page().id);
  const progress = () => chatProgressForPage(page().id);

  const documentScale = () => pageFns().documentScale ? pageFns().documentScale() : 1.0;
  const leftPx = () =>
    pageFns().documentContentLeftPx() + PAGE_DOCUMENT_LEFT_MARGIN_BL * LINE_HEIGHT_PX * documentScale();
  const widthPx = () =>
    Math.max(240, page().docWidthBl * LINE_HEIGHT_PX * documentScale());
  const wrapperHeightPx = () => composerHeightPx() + (progress() == null ? 0 : CHAT_PROGRESS_HEIGHT_PX);

  const wrapperStyle = () => {
    const heightPx = wrapperHeightPx();
    const common = `left: ${leftPx()}px; width: ${widthPx()}px; height: ${heightPx}px; z-index: 80;`;
    if (!hasContent()) {
      return `position: absolute; top: ${Math.max(24, pageFns().viewportBoundsPx().h * 0.45 - heightPx / 2)}px; ${common}`;
    }
    const topPx = Math.max(0, pageFns().viewportBoundsPx().h - heightPx - COMPOSER_BOTTOM_PX);
    return `position: sticky; top: ${topPx}px; ${common}`;
  };

  const resizeTextarea = (elMaybe?: HTMLTextAreaElement) => {
    const el = elMaybe ?? textarea;
    if (!el) {
      return;
    }
    el.style.height = "0px";
    const nextHeight = Math.min(MAX_COMPOSER_HEIGHT_PX, Math.max(MIN_COMPOSER_HEIGHT_PX, el.scrollHeight));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
    setComposerHeightPx(nextHeight);
  };

  const resizeTextareaSoon = () => {
    window.setTimeout(() => resizeTextarea(), 0);
  };

  const focusTextareaSoon = () => {
    window.setTimeout(() => textarea?.focus(), 0);
  };

  onMount(() => {
    resizeTextareaSoon();
  });

  createEffect(() => {
    if (!enabled() || !store.overlay.autoFocusChatInput.get()) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      textarea?.focus();
      store.overlay.autoFocusChatInput.set(false);
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const stop = (ev: Event) => {
    ev.stopPropagation();
  };

  const send = async () => {
    const value = text();
    if (sending() || value.trim() == "") {
      focusTextareaSoon();
      return;
    }
    setText("");
    resizeTextareaSoon();
    setSending(true);
    try {
      await submitChatMessage(store, page(), value);
    } finally {
      setSending(false);
      focusTextareaSoon();
    }
  };

  const keyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key == "Escape") {
      ev.preventDefault();
      textarea?.blur();
      store.history.setFocus(VeFns.veToPath(props.visualElement));
      arrangeNow(store, "chat-exit-edit");
      return;
    }
    if (ev.key == "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  };

  const materialize = async () => {
    if (materializing() || !canMaterialize()) {
      return;
    }
    setMaterializing(true);
    try {
      const ok = await materializeChatPage(store, page());
      if (!ok) {
        focusTextareaSoon();
      }
    } finally {
      setMaterializing(false);
    }
  };

  return (
    <Show when={enabled()}>
      <div
        class="pointer-events-auto"
        style={wrapperStyle()}
        onMouseDown={stop}
        onMouseUp={stop}
        onClick={stop}
        onKeyDown={stop}
        onKeyUp={stop}>
        <Show when={progress() != null}>
          <div
            class="truncate px-1 pb-1 text-[#555]"
            style={`height: ${CHAT_PROGRESS_HEIGHT_PX}px; font-size: 12px; line-height: 20px;`}>
            {progress()!.text}
          </div>
        </Show>
        <div class="flex items-end" style={`height: ${composerHeightPx()}px; gap: ${SEARCH_WORKSPACE_CONTROLS_GAP_PX}px;`}>
          <div
            class="min-w-0 grow overflow-hidden rounded-xs border border-[#999] bg-white"
            style={`height: ${composerHeightPx()}px;`}>
            <textarea
              ref={textarea}
              class="block w-full resize-none border-0 bg-transparent px-2.5 py-[9px] text-black outline-hidden"
              style={`height: ${composerHeightPx()}px; font-size: 16px; line-height: 24px; user-select: text;`}
              value={text()}
              rows={1}
              spellcheck={true}
              placeholder="Ask"
              disabled={sending()}
              onInput={(ev) => {
                const el = ev.currentTarget as HTMLTextAreaElement;
                setText(el.value);
                resizeTextarea(el);
              }}
              onKeyDown={keyDown}
              onMouseDown={stop}
              onMouseUp={stop}
              onClick={stop} />
          </div>
          <button
            class="flex shrink-0 cursor-pointer items-center justify-center rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
            style={`width: ${SEND_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
            type="button"
            title="Send"
            aria-label="Send"
            disabled={sending() || text().trim() == ""}
            onClick={() => void send()}>
            <i class="fa fa-arrow-up" />
          </button>
          <Show when={canMaterialize()}>
            <button
              class="shrink-0 cursor-pointer rounded-xs border border-[#999] bg-white text-black disabled:cursor-default disabled:opacity-40"
              style={`width: ${MATERIALIZE_BUTTON_WIDTH_PX}px; height: ${SEARCH_WORKSPACE_CONTROLS_HEIGHT_PX}px;`}
              type="button"
              disabled={sending() || materializing() || !hasContent()}
              onClick={() => void materialize()}>
              Materialize
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};
