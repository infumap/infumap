/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component } from "solid-js";
import { StoreContextModel } from "../../store/StoreProvider";
import { arrangeNow } from "../../layout/arrange";
import { serverOrRemote } from "../../server";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { getToolbarFocusItem } from "./toolbarFocus";


// Toolbar popups that hold several related settings use the look of the chat configuration dialogs, in place of the
// plain bordered box used for single values.
export const TOOLBAR_DIALOG_CLASS = "absolute flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-lg";

export const toolbarDialogButtonClass = (selected: boolean = false): string =>
  `h-[24px] rounded-md border px-2 text-[12px] disabled:cursor-default disabled:opacity-50 ` +
  (selected ? "border-slate-500 bg-slate-100 text-black" : "border-[#d6d6d6] bg-white text-[#555] hover:bg-slate-50");

export const TOOLBAR_DIALOG_INPUT_CLASS = "w-[64px] rounded border border-slate-300 px-[6px] py-[1px] text-[13px] text-black focus:border-blue-500 focus:outline-none";

/** Closes the open toolbar popup, saving the focus item as closing it by clicking elsewhere does. */
export function closeToolbarDialog(store: StoreContextModel): void {
  store.overlay.toolbarPopupInfoMaybe.set(null);
  store.touchToolbar();
  arrangeNow(store, "toolbar-dialog-close");
  const focusItem = getToolbarFocusItem(store);
  if (itemCanEdit(focusItem)) { serverOrRemote.updateItem(focusItem); }
}

export const ToolbarDialogHeader: Component<{ title: string, description: string, onClose: () => void }> = (props) => (
  <div class="shrink-0 border-b border-slate-200 px-3 py-2">
    <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">{props.title}
      <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label={`Close ${props.title.toLowerCase()}`} onClick={props.onClose}><i class="bi-x-lg" /></button>
    </div>
    <div class="mt-[2px] text-[11px] text-slate-500">{props.description}</div>
  </div>
);
