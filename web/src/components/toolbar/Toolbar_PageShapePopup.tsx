/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import { ToolbarDialogPageShapeControls, closeToolbarDialog, toolbarDialogContentRef } from "./toolbarDialog";
import { DialogHeader } from "../library/dialogStyle";


/**
 * Sets the shape of a page where it is shown inside something else, for an arrangement that has nothing else to set
 * here: list and calendar pages fill the width of where they are shown (a list's column is resized by dragging its
 * edge on the page, and a calendar's view is chosen from its own toolbar menu).
 */
export const Toolbar_PageShapePopup: Component = () => {
  const store = useStore();
  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const close = () => closeToolbarDialog(store);
  const arrangement = pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar ? "calendar"
    : pageItem().arrangeAlgorithm == ArrangeAlgorithm.List ? "list" : null;

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Page shape"
        description={`The shape of this page in popups and where it is embedded.${arrangement == null ? "" : ` The ${arrangement} itself fills the width of where it is shown.`}`} />
      <div class="px-3 py-3">
        <ToolbarDialogPageShapeControls page={pageItem} />
      </div>
    </div>
  );
}
