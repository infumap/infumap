/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Show, createSignal, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { applyEditorFormatCommand } from "../../input/editor_history";
import { refocusActiveTextEdit } from "../../input/edit";
import { requestArrange } from "../../layout/arrange";
import { getToolbarFocusItem, getToolbarFocusPathMaybe } from "./toolbarFocus";
import { toolbarDialogContentRef } from "./toolbarDialog";
import { DIALOG_INPUT_CLASS, DIALOG_LABEL_CLASS, dialogButtonClass } from "../library/dialogStyle";


export const NOTE_URL_POPUP_WIDTH_PX = 330;
export const NOTE_URL_POPUP_HEIGHT_PX = 50;

/**
 * Edits the link of a note, or of the selected text in it. The link applies when Enter is pressed or the input is
 * left, and Enter or Escape go back to editing the note.
 */
export const Toolbar_NoteUrlPopup: Component = () => {
  const store = useStore();
  let input: HTMLInputElement | undefined;

  const note = asNoteItem(getToolbarFocusItem(store));
  // Read once: the link is for the text selected when the popup was opened.
  const selection = (() => {
    const s = store.overlay.noteTextSelectionInfo.get();
    return s == null || s.itemPath != getToolbarFocusPathMaybe(store) ? null : s;
  })();
  const currentUrl = () => NoteFns.urlForToolbarEdit(note, selection);
  const [hasUrl, setHasUrl] = createSignal(currentUrl() != "");

  const apply = (url: string) => {
    if (url == currentUrl()) { return; }
    applyEditorFormatCommand(store, [note], url == "" ? "Remove link" : "Edit link", () => {
      NoteFns.setUrlForToolbarEdit(note, selection, url);
    });
    setHasUrl(url != "");
    requestArrange(store, "toolbar-popup-note-url");
  };

  const close = () => {
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    refocusActiveTextEdit(store);
  };

  const handleKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key == "Enter" || ev.key == "Escape") {
      // Otherwise the key would go on to act in the editor, which has the focus again.
      ev.preventDefault();
      if (ev.key == "Enter") { apply(input!.value); }
      setTimeout(close, 0);
    }
  };

  onMount(() => { input?.focus(); });

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex items-center gap-2 p-3">
      <label class={`flex min-w-0 grow items-center gap-[6px] ${DIALOG_LABEL_CLASS}`}>Link
        <input ref={input} class={`min-w-0 grow ${DIALOG_INPUT_CLASS}`} type="text" autocomplete="on" placeholder="https://"
          value={currentUrl()} onChange={ev => apply(ev.currentTarget.value)} onKeyDown={handleKeyDown}
          onKeyUp={ev => ev.stopPropagation()} onKeyPress={ev => ev.stopPropagation()} />
      </label>
      <Show when={hasUrl()}>
        <button type="button" class={dialogButtonClass()} onClick={() => { apply(""); close(); }}>Remove</button>
      </Show>
    </div>
  );
}
