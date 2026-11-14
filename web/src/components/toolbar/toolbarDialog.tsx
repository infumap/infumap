/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, createSignal, onCleanup } from "solid-js";
import { Item } from "../../items/base/item";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { serverOrRemote } from "../../server";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { PageItem, autoPageAspect } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  DIALOG_INPUT_CLASS, DIALOG_LABEL_CLASS, DIALOG_NOTE_CLASS, DIALOG_STEPPER_INPUT_CLASS, DIALOG_SURFACE_CLASS, dialogButtonClass,
  dialogIconButtonClass,
} from "../library/dialogStyle";


// Toolbar popups that hold related settings, or a value to edit, use the look shared by dialogs, in place of the
// plain bordered box used for menus.
export const TOOLBAR_DIALOG_CLASS = `absolute flex flex-col overflow-hidden ${DIALOG_SURFACE_CLASS}`;

/** A number input for a value such as an aspect. */
export const TOOLBAR_DIALOG_INPUT_CLASS = `${DIALOG_INPUT_CLASS} w-[64px]`;

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
 * Applies a change to an item's settings: redraws it and the toolbar, and saves it unless asked not to (while a
 * slider is being dragged).
 */
export function toolbarDialogItemChanged(store: StoreContextModel, item: Item, reason: string, save: boolean = true): void {
  store.touchToolbar();
  requestArrange(store, reason);
  if (save) { serverOrRemote.updateItem(item); }
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

/**
 * A whole number set with - and + buttons, or typed. The label is in a fixed width column, so the controls of
 * successive rows line up.
 */
export const ToolbarDialogStepper: Component<{
  label: string,
  value: () => number,
  apply: (value: number) => void,
  min: number,
  max: number,
  decreaseLabel: string,
  increaseLabel: string,
  unit?: string,
}> = (props) => {
  const store = useStore();
  return (
    <div class="flex items-center gap-2">
      <div class={`w-[72px] shrink-0 ${DIALOG_LABEL_CLASS}`}>{props.label}</div>
      <button type="button" class={dialogIconButtonClass()} aria-label={props.decreaseLabel} disabled={props.value() <= props.min}
        onClick={() => props.apply(props.value() - 1)}><i class="bi-dash" /></button>
      <input class={DIALOG_STEPPER_INPUT_CLASS} type="number" min={props.min} max={props.max} step="1" aria-label={props.label}
        value={props.value()} {...toolbarDialogNumberInput(store, props.value, props.apply, 1)} />
      <button type="button" class={dialogIconButtonClass()} aria-label={props.increaseLabel} disabled={props.value() >= props.max}
        onClick={() => props.apply(props.value() + 1)}><i class="bi-plus" /></button>
      {props.unit != null ? <div class={DIALOG_LABEL_CLASS}>{props.unit}</div> : null}
    </div>
  );
};

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
    toolbarDialogItemChanged(store, props.page(), "toolbar-page-shape");
  };
  return (
    <div class="flex items-center gap-2">
      <label class={`flex items-center gap-[6px] ${DIALOG_LABEL_CLASS}`}>Aspect
        <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={MIN_PAGE_ASPECT} max={MAX_PAGE_ASPECT} step="0.01"
          value={roundAspect(aspect())} {...toolbarDialogNumberInput(store, aspect, apply, 0.01, v => String(roundAspect(v)))} />
      </label>
      <button type="button" class={dialogButtonClass()}
        title="Use the shape of the window" onClick={() => apply(autoPageAspect(store))}>Match window</button>
    </div>
  );
};

/** The page shape controls as the last section of a layout dialog. */
export const ToolbarDialogPageShapeSection: Component<{ page: () => PageItem }> = (props) => (
  <div class="shrink-0 border-t border-chrome-line px-3 py-2">
    <div class={DIALOG_NOTE_CLASS}>Shape of this page in popups and where it is embedded</div>
    <div class="mt-[6px]"><ToolbarDialogPageShapeControls page={props.page} /></div>
  </div>
);
