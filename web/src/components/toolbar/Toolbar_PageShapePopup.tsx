/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import { ToolbarDialogHeader, ToolbarDialogPageShapeControls, closeToolbarDialog, toolbarDialogContentRef } from "./toolbarDialog";


export const PAGE_SHAPE_POPUP_HEIGHT_PX = 136;

/**
 * Sets the shape of a page where it is shown inside something else, for an arrangement that has nothing else to set
 * here. A list page fills the width of where it is shown, and its column is resized by dragging its edge on the page.
 */
export const Toolbar_PageShapePopup: Component = () => {
  const store = useStore();
  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const close = () => closeToolbarDialog(store);

  return (
    <div ref={toolbarDialogContentRef} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <ToolbarDialogHeader title="Page shape" onClose={close}
        description="The shape of this page in popups and where it is embedded. The list itself fills the width of where it is shown." />
      <div class="px-3 py-3">
        <ToolbarDialogPageShapeControls page={pageItem} />
      </div>
    </div>
  );
}
