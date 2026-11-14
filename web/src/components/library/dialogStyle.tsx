/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, JSX, Show } from "solid-js";


// The look shared by dialogs, popovers and pickers: the toolbar layout dialogs, the chat configuration pickers, and
// modal dialogs. Use these in place of writing the classes out, so they don't drift apart again.

/** The panel: position, size and layout (e.g. flex flex-col overflow-hidden) are added by the caller. */
export const DIALOG_SURFACE_CLASS = "rounded-md border border-slate-300 bg-white text-black shadow-lg";

/** A label in front of, or above, a control. */
export const DIALOG_LABEL_CLASS = "text-[12px] text-slate-600";

/** Explanatory or status text under a control. */
export const DIALOG_NOTE_CLASS = "text-[11px] leading-[16px] text-slate-500";

/** A text or number input. The width is added by the caller. Its height matches the buttons. */
export const DIALOG_INPUT_CLASS =
  "h-[24px] rounded border border-slate-300 bg-white px-[6px] text-[13px] text-black placeholder:text-slate-400 " +
  "focus:border-blue-500 focus:outline-none disabled:opacity-50";

/** A number input without the browser's spin buttons, for use between the buttons of a stepper. */
export const DIALOG_STEPPER_INPUT_CLASS =
  `${DIALOG_INPUT_CLASS} w-[44px] text-center [appearance:textfield] ` +
  "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

// The same border and text colors as the buttons in a chat's controls.
const BUTTON_BASE_CLASS =
  "h-[24px] shrink-0 rounded-md border text-[12px] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 " +
  "focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-50 ";
const buttonColorClass = (selected: boolean): string =>
  selected
    ? "border-slate-500 bg-slate-100 text-black"
    : "border-control-border bg-white text-control-text hover:bg-slate-50 disabled:hover:bg-white";

/** A button with a text label. `selected` is for one of a set of choices. */
export const dialogButtonClass = (selected: boolean = false): string =>
  `${BUTTON_BASE_CLASS} px-2 ${buttonColorClass(selected)}`;

/** A square button holding an icon or a single character. */
export const dialogIconButtonClass = (selected: boolean = false): string =>
  `${BUTTON_BASE_CLASS} inline-flex w-[24px] items-center justify-center ${buttonColorClass(selected)}`;

/** A text action that reads as a link. */
export const DIALOG_LINK_CLASS = "cursor-pointer text-[12px] text-blue-700 hover:underline disabled:cursor-default disabled:opacity-50";

const DIALOG_CLOSE_BUTTON_CLASS =
  "ml-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[12px] text-slate-500 " +
  "hover:bg-slate-100 hover:text-slate-800";

/**
 * The title, close button and description at the top of a dialog. Anything else that belongs above the dialog's
 * scrolling content (a search field, warnings) goes in children.
 */
export const DialogHeader: Component<{
  title: string,
  description?: JSX.Element,
  onClose: () => void,
  closeLabel?: string,
  children?: JSX.Element,
}> = (props) => (
  <div class="shrink-0 border-b border-slate-200 px-3 py-2">
    <div class="flex items-center gap-2 text-[13px] font-medium text-slate-800">{props.title}
      <button type="button" class={DIALOG_CLOSE_BUTTON_CLASS} aria-label={props.closeLabel ?? `Close ${props.title.toLowerCase()}`}
        onClick={() => props.onClose()}><i class="bi-x-lg" /></button>
    </div>
    <Show when={props.description}><div class={`mt-[2px] ${DIALOG_NOTE_CLASS}`}>{props.description}</div></Show>
    {props.children}
  </div>
);
