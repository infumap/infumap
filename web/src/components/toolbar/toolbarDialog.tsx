/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, createSignal, onCleanup } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { serverOrRemote } from "../../server";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { PageItem, autoPageAspect } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";


// Toolbar popups that hold several related settings use the look of the chat configuration dialogs, in place of the
// plain bordered box used for single values.
export const TOOLBAR_DIALOG_CLASS = "absolute flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-lg";

export const toolbarDialogButtonClass = (selected: boolean = false): string =>
  `h-[24px] rounded-md border px-2 text-[12px] disabled:cursor-default disabled:opacity-50 ` +
  (selected ? "border-slate-500 bg-slate-100 text-black" : "border-[#d6d6d6] bg-white text-[#555] hover:bg-slate-50");

export const TOOLBAR_DIALOG_INPUT_CLASS = "w-[64px] rounded border border-slate-300 px-[6px] py-[1px] text-[13px] text-black focus:border-blue-500 focus:outline-none";

const MIN_PAGE_ASPECT = 0.1;
const MAX_PAGE_ASPECT = 10;

export const roundAspect = (aspect: number): number => Math.round(aspect * 100) / 100;

// Text in a dialog wraps differently with different fonts, so a fixed height either clips it or leaves a gap. The
// open dialog measures its content instead, and the popup's bounds use that (they are also what a click is tested
// against to decide whether it is outside the popup). The fixed heights remain for before the first measurement.
const [dialogContentHeightPx, setDialogContentHeightPx] = createSignal<number | null>(null);

/** The height of the open toolbar dialog, including its border. */
export function toolbarDialogHeightPx(fallbackPx: number): number {
  const contentPx = dialogContentHeightPx();
  return contentPx == null ? fallbackPx : contentPx + 2;
}

/** Ref for the root element of a toolbar dialog's content, which is measured for the height of the dialog. */
export function toolbarDialogContentRef(el: HTMLElement): void {
  const observer = new ResizeObserver(() => {
    if (el.offsetHeight > 0) { setDialogContentHeightPx(el.offsetHeight); }
  });
  observer.observe(el);
  onCleanup(() => {
    observer.disconnect();
    setDialogContentHeightPx(null);
  });
}

/** Closes the open toolbar popup, saving the focus item as closing it by clicking elsewhere does. */
export function closeToolbarDialog(store: StoreContextModel): void {
  store.overlay.toolbarPopupInfoMaybe.set(null);
  store.touchToolbar();
  arrangeNow(store, "toolbar-dialog-close");
  const focusItem = getToolbarFocusItem(store);
  if (itemCanEdit(focusItem)) { serverOrRemote.updateItem(focusItem); }
}

/**
 * Applies a change to a page's layout settings: redraws it and the toolbar, and saves it unless asked not to (while
 * a slider is being dragged).
 */
export function toolbarDialogPageChanged(store: StoreContextModel, page: PageItem, reason: string, save: boolean = true): void {
  store.touchToolbar();
  requestArrange(store, reason);
  if (save) { serverOrRemote.updateItem(page); }
}

/**
 * Handlers for a number input in a toolbar dialog. It applies on Enter or when left, and steps with the arrow keys
 * (by 10 steps with shift). Escape closes the dialog.
 */
export function toolbarDialogNumberInput(
  store: StoreContextModel,
  current: () => number,
  apply: (value: number) => void,
  step: number,
  format: (value: number) => string = String) {
  const show = (input: HTMLInputElement) => { input.value = format(current()); };
  const applyText = (input: HTMLInputElement) => {
    const value = parseFloat(input.value);
    if (Number.isFinite(value)) { apply(value); }
    // The value may not change (e.g. it was clamped back to the current one), so the input won't update itself.
    show(input);
  };
  return {
    onChange: (ev: Event) => { applyText(ev.currentTarget as HTMLInputElement); },
    onKeyDown: (ev: KeyboardEvent) => {
      ev.stopPropagation();
      const input = ev.currentTarget as HTMLInputElement;
      if (ev.key == "Escape") { ev.preventDefault(); closeToolbarDialog(store); return; }
      if (ev.key == "Enter") { applyText(input); input.select(); return; }
      if (ev.key == "ArrowUp" || ev.key == "ArrowDown") {
        // Handled here rather than by the number input, which would apply the change without a change event.
        ev.preventDefault();
        apply(current() + (ev.key == "ArrowUp" ? step : -step) * (ev.shiftKey ? 10 : 1));
        show(input);
      }
    },
  };
}

export const ToolbarDialogHeader: Component<{ title: string, description: string, onClose: () => void }> = (props) => (
  <div class="shrink-0 border-b border-slate-200 px-3 py-2">
    <div class="flex items-center gap-2 text-[12px] font-medium text-slate-600">{props.title}
      <button type="button" class="ml-auto h-5 w-5 rounded hover:bg-slate-100" aria-label={`Close ${props.title.toLowerCase()}`} onClick={props.onClose}><i class="bi-x-lg" /></button>
    </div>
    <div class="mt-[2px] text-[11px] text-slate-500">{props.description}</div>
  </div>
);

/**
 * The aspect of a page whose own arrangement doesn't use it (it fills the width of where it is shown and scrolls),
 * but which sets its shape where it is shown inside something else.
 */
export const ToolbarDialogPageShapeControls: Component<{ page: () => PageItem }> = (props) => {
  const store = useStore();
  const [aspect, setAspect] = createSignal(props.page().naturalAspect);
  const apply = (requested: number) => {
    const value = Math.max(MIN_PAGE_ASPECT, Math.min(MAX_PAGE_ASPECT, requested));
    setAspect(value);
    if (props.page().naturalAspect == value) { return; }
    props.page().naturalAspect = value;
    toolbarDialogPageChanged(store, props.page(), "toolbar-page-shape");
  };
  return (
    <div class="flex items-center gap-2">
      <label class="flex items-center gap-[6px] text-[12px] text-slate-600">Aspect
        <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={MIN_PAGE_ASPECT} max={MAX_PAGE_ASPECT} step="0.01"
          value={roundAspect(aspect())} {...toolbarDialogNumberInput(store, aspect, apply, 0.01, v => String(roundAspect(v)))} />
      </label>
      <button type="button" class={toolbarDialogButtonClass()}
        title="Use the shape of the window" onClick={() => apply(autoPageAspect(store))}>Match window</button>
    </div>
  );
};

/** The page shape controls as the last section of a layout dialog. */
export const ToolbarDialogPageShapeSection: Component<{ page: () => PageItem }> = (props) => (
  <div class="shrink-0 border-t border-slate-200 px-3 py-2">
    <div class="text-[11px] leading-[16px] text-slate-500">Shape of this page in popups and where it is embedded</div>
    <div class="mt-[6px]"><ToolbarDialogPageShapeControls page={props.page} /></div>
  </div>
);
