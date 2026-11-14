/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, JSX, Show } from "solid-js";


// The look shared by dialogs, popovers and pickers: the toolbar layout dialogs, the chat configuration pickers, and
// modal dialogs. Use these in place of writing the classes out, so they don't drift apart again. The colors, corner
// radius and focus indicator are the chrome tokens in index.css, which are shared with items and the toolbar, and the
// shadows are those of a popped-up page: a dialog should look like part of the same application, not like a web form.

const SURFACE_BASE_CLASS = "rounded-control border border-control-border bg-white text-black";

/**
 * The panel of a dialog, menu or picker anchored to the toolbar or a control. Position, size and layout (e.g. flex
 * flex-col overflow-hidden) are added by the caller.
 */
export const DIALOG_SURFACE_CLASS = `${SURFACE_BASE_CLASS} shadow-popover`;

/** The panel of a dialog that floats free over the page, which has the stronger shadow of a popped-up page. */
export const FLOATING_DIALOG_SURFACE_CLASS = `${SURFACE_BASE_CLASS} shadow-popup`;

/** The shade over the rest of the window behind a modal dialog. */
export const DIALOG_BACKDROP_CLASS = "bg-black/20";

/** A menu: a dialog panel with a little padding around its entries. */
export const MENU_SURFACE_CLASS = `${DIALOG_SURFACE_CLASS} p-[3px]`;

/**
 * An entry in a menu: a 20px line with 3px padding. The display (block, or flex for an icon and shortcut) is added by
 * the caller. Selected is for the current choice of the menu.
 */
export const menuItemClass = (selected: boolean = false): string =>
  "w-full text-left text-sm leading-[20px] p-[3px] rounded-control cursor-pointer text-black " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus " +
  (selected ? "bg-control-selected" : "hover:bg-control-hover focus-visible:bg-control-hover");

/** An entry that can't be chosen. */
export const MENU_ITEM_DISABLED_CLASS = "w-full text-left text-sm leading-[20px] p-[3px] cursor-default text-neutral-400";

/** A line between groups of menu entries. */
export const MENU_SEPARATOR_CLASS = "mx-[3px] my-[3px] border-t border-chrome-line";

/** A label in front of, or above, a control. */
export const DIALOG_LABEL_CLASS = "text-[12px] text-neutral-600";

/** Explanatory or status text under a control. */
export const DIALOG_NOTE_CLASS = "text-[11px] leading-[16px] text-neutral-500";

/** A text or number input. The width is added by the caller. Its height matches the buttons. */
export const DIALOG_INPUT_CLASS =
  "h-[24px] rounded-control border border-control-border bg-white px-[6px] text-[13px] text-black placeholder:text-neutral-400 " +
  "focus:border-focus focus:outline-1 focus:outline-focus disabled:opacity-50";

/** A number input without the browser's spin buttons, for use between the buttons of a stepper. */
export const DIALOG_STEPPER_INPUT_CLASS =
  `${DIALOG_INPUT_CLASS} w-[44px] text-center [appearance:textfield] ` +
  "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

// The same outline, hover and selected colors as the buttons in the toolbar.
const BUTTON_BASE_CLASS =
  "h-[24px] shrink-0 rounded-control border border-control-border text-[12px] text-control-text cursor-pointer " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50 ";
const buttonColorClass = (selected: boolean): string =>
  selected ? "bg-control-selected" : "bg-white hover:bg-control-hover disabled:hover:bg-white";

/** A button with a text label. `selected` is for one of a set of choices. */
export const dialogButtonClass = (selected: boolean = false): string =>
  `${BUTTON_BASE_CLASS} px-2 ${buttonColorClass(selected)}`;

/** A square button holding an icon or a single character. */
export const dialogIconButtonClass = (selected: boolean = false): string =>
  `${BUTTON_BASE_CLASS} inline-flex w-[24px] items-center justify-center ${buttonColorClass(selected)}`;

/** A text action that reads as a link. */
export const DIALOG_LINK_CLASS = "cursor-pointer text-[12px] text-blue-700 hover:underline disabled:cursor-default disabled:opacity-50";

const DIALOG_CLOSE_BUTTON_CLASS =
  "ml-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-control text-[12px] text-neutral-500 " +
  "hover:bg-control-hover hover:text-neutral-800";

/**
 * The title, description and, for a modal dialog, close button at the top of a dialog. Anything else that belongs
 * above the dialog's scrolling content (a search field, warnings) goes in children.
 *
 * Only a modal dialog (one with a backdrop, which blocks the rest of the app) gets a close button: pass onClose. A
 * dialog that closes on a press outside it or Escape doesn't need one, and it is clutter in a small panel.
 */
export const DialogHeader: Component<{
  title: string,
  description?: JSX.Element,
  onClose?: () => void,
  closeLabel?: string,
  children?: JSX.Element,
}> = (props) => (
  <div class="shrink-0 border-b border-chrome-line px-3 py-2">
    <div class="flex items-center gap-2 text-[13px] font-medium text-neutral-800">{props.title}
      <Show when={props.onClose}>{onClose =>
        <button type="button" class={DIALOG_CLOSE_BUTTON_CLASS} aria-label={props.closeLabel ?? `Close ${props.title.toLowerCase()}`}
          onClick={() => onClose()()}><i class="bi-x-lg" /></button>
      }</Show>
    </div>
    <Show when={props.description}><div class={`mt-[2px] ${DIALOG_NOTE_CLASS}`}>{props.description}</div></Show>
    {props.children}
  </div>
);
