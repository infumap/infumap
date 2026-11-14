/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Show, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { NoteFlags } from "../../items/base/flags-item";
import { isVirtualTextDocumentPage, persistVirtualTextDocumentPageOptions } from "../../items/text-document";
import { PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, NATURAL_BLOCK_SIZE_PX } from "../../constants";
import { requestArrange } from "../../layout/arrange";
import { getTextStyleForNote, measureWidthBl } from "../../layout/text";
import { serverOrRemote } from "../../server";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  ToolbarDialogPageShapeSection, ToolbarDialogStepper, closeToolbarDialog, toolbarDialogContentRef,
} from "./toolbarDialog";
import { DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";


const MIN_WIDTH_BL = 10;
const MAX_WIDTH_BL = 200;
// Used to find the average width of a character of body text, for the characters per line.
const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog, and then it does so again for good measure.";

/**
 * Sets the width of a document page's text column, and, for a page that can be shown inside something else, its shape
 * there. Also used for the document pages that text files are shown as, whose settings are saved to the file's item.
 */
export const Toolbar_PageDocumentLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const isVirtual = isVirtualTextDocumentPage(pageItem().id);
  const [widthBl, setWidthBl] = createSignal(pageItem().docWidthBl);

  const blPerChar = measureWidthBl(SAMPLE_TEXT, getTextStyleForNote(NoteFlags.None)) / SAMPLE_TEXT.length;
  const windowPx = store.desktopMainAreaBoundsPx();

  const changed = (reason: string) => {
    store.touchToolbar();
    requestArrange(store, reason);
    if (isVirtual) { persistVirtualTextDocumentPageOptions(store, pageItem()); }
    else { serverOrRemote.updateItem(pageItem()); }
  };

  const applyWidth = (requested: number) => {
    const value = Math.max(MIN_WIDTH_BL, Math.min(MAX_WIDTH_BL, Math.round(requested)));
    setWidthBl(value);
    if (pageItem().docWidthBl == value) { return; }
    pageItem().docWidthBl = value;
    changed("toolbar-document-width");
  };

  const close = () => closeToolbarDialog(store);

  const charsPerLine = () => Math.round(widthBl() / blPerChar / 5) * 5;
  // A document narrower than the window is drawn at its natural size; a wider one is scaled down to fit.
  const scaledDown = () => (widthBl() + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL) * NATURAL_BLOCK_SIZE_PX.w > windowPx.w;

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Document layout"
        description="Text runs down the page in a column. Its width sets how long the lines are." />

      <div class="px-3 py-3">
        <ToolbarDialogStepper label="Width" value={widthBl} apply={applyWidth} min={MIN_WIDTH_BL} max={MAX_WIDTH_BL}
          decreaseLabel="Narrower" increaseLabel="Wider" unit="blocks" />
        <div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>
          About {charsPerLine()} characters per line.
          <Show when={scaledDown()}> The window is narrower than this, so the document is scaled down to fit.</Show>
        </div>
      </div>

      <Show when={!isVirtual}>
        <ToolbarDialogPageShapeSection page={pageItem} />
      </Show>
    </div>
  );
}
