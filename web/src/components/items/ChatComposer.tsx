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

import { Component, Show, createSignal, onMount } from "solid-js";

import { LINE_HEIGHT_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL } from "../../constants";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { isChatPage, materializeChatPage, submitChatMessage } from "../../items/chat";
import { asPageItem } from "../../items/page-item";
import { useStore } from "../../store/StoreProvider";
import { PageVisualElementProps } from "./Page";

const COMPOSER_HEIGHT_PX = 58;
const COMPOSER_BOTTOM_PX = 18;

export const ChatComposer: Component<PageVisualElementProps> = (props) => {
  const store = useStore();
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [materializing, setMaterializing] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;

  const pageFns = () => props.pageFns;
  const page = () => asPageItem(pageFns().pageItem());
  const enabled = () => isChatPage(page()) && itemCanEdit(page());
  const hasContent = () => page().computed_children.length > 0;
  const isDraft = () => page().clientOnly === true;

  const documentScale = () => pageFns().documentScale ? pageFns().documentScale() : 1.0;
  const leftPx = () =>
    pageFns().documentContentLeftPx() + PAGE_DOCUMENT_LEFT_MARGIN_BL * LINE_HEIGHT_PX * documentScale();
  const widthPx = () =>
    Math.max(240, page().docWidthBl * LINE_HEIGHT_PX * documentScale());

  const wrapperStyle = () => {
    const common = `left: ${leftPx()}px; width: ${widthPx()}px; height: ${COMPOSER_HEIGHT_PX}px; z-index: 80;`;
    if (!hasContent()) {
      return `position: absolute; top: ${Math.max(24, pageFns().viewportBoundsPx().h * 0.45 - COMPOSER_HEIGHT_PX / 2)}px; ${common}`;
    }
    const topPx = Math.max(0, pageFns().viewportBoundsPx().h - COMPOSER_HEIGHT_PX - COMPOSER_BOTTOM_PX);
    return `position: sticky; top: ${topPx}px; ${common}`;
  };

  const focusTextareaSoon = () => {
    window.setTimeout(() => textarea?.focus(), 0);
  };

  onMount(() => {
    if (isDraft()) {
      focusTextareaSoon();
    }
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
    if (ev.key == "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  };

  const materialize = async () => {
    if (materializing() || !isDraft()) {
      return;
    }
    setMaterializing(true);
    try {
      await materializeChatPage(store, page());
    } finally {
      setMaterializing(false);
      focusTextareaSoon();
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
        <div class="flex h-full items-stretch gap-[6px] rounded-md border border-slate-300 bg-white/95 p-[6px] shadow-[0_3px_14px_rgba(15,23,42,0.13)]">
          <textarea
            ref={textarea}
            class="min-w-0 grow resize-none rounded-sm border border-slate-200 px-[8px] py-[5px] text-[15px] leading-[20px] outline-none focus:border-slate-400"
            value={text()}
            rows={1}
            spellcheck={true}
            placeholder="Ask"
            disabled={sending()}
            onInput={(ev) => setText((ev.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={keyDown}
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop} />
          <button
            class="flex h-full w-[38px] shrink-0 items-center justify-center rounded-sm border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:text-slate-300"
            title="Send"
            disabled={sending() || text().trim() == ""}
            onClick={() => void send()}>
            <i class="fa fa-paper-plane" />
          </button>
          <Show when={isDraft()}>
            <button
              class="h-full shrink-0 rounded-sm border border-slate-300 px-[10px] text-[13px] text-slate-700 hover:bg-slate-100 disabled:text-slate-300"
              disabled={sending() || materializing()}
              onClick={() => void materialize()}>
              materialize
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};
