/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, For } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asNoteItem } from "../../items/note-item";
import { getNoteIndentLevel, noteHasListStyle, setNoteIndentLevel } from "../../items/base/flags-item";
import { applyEditorFormatCommand } from "../../input/editor_history";
import { noteFormatTargets } from "../../input/edit";
import { requestArrange } from "../../layout/arrange";
import { getToolbarFocusItem } from "./toolbarFocus";
import { toolbarDialogContentRef } from "./toolbarDialog";
import { DIALOG_LABEL_CLASS, dialogIconButtonClass } from "../library/dialogStyle";


export const NOTE_INDENT_POPUP_WIDTH_PX = 220;
export const NOTE_INDENT_POPUP_HEIGHT_PX = 50;

const LEVELS = [1, 2, 3, 4];

/**
 * Sets the indent of the list notes being edited. There are only four levels, so they are buttons, which choose and
 * close like the text style menu. The popup is expected not to take the focus from the editor (its container prevents
 * the default action of a press), so the indent applies to the text selection.
 */
export const Toolbar_NoteIndentPopup: Component = () => {
  const store = useStore();
  const note = asNoteItem(getToolbarFocusItem(store));
  // Indent only means something on a list note.
  const targets = noteFormatTargets(store, note).filter(n => noteHasListStyle(n.flags));
  const current = getNoteIndentLevel(note) + 1;

  const choose = (level: number) => {
    applyEditorFormatCommand(store, targets, "Change indent", () => {
      for (const n of targets) { setNoteIndentLevel(n, level - 1); }
    }, "indent");
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-note-indent");
  };

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex items-center gap-2 p-3">
      <div class={`w-[72px] shrink-0 ${DIALOG_LABEL_CLASS}`}>Indent</div>
      <div class="flex gap-[6px]" role="radiogroup" aria-label="Indent">
        <For each={LEVELS}>{level =>
          <button type="button" role="radio" aria-checked={level == current} class={dialogIconButtonClass(level == current)}
            onClick={() => choose(level)}>{level}</button>
        }</For>
      </div>
    </div>
  );
}
