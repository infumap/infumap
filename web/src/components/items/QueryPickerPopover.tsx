/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import type { QueryItem } from "../../items/query-item";

export interface QueryPickerProps {
  queryItem: () => QueryItem,
  disabled?: () => boolean,
  beforeChange?: () => void,
  note?: () => string | null,
  buttonRef?: (el: HTMLButtonElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
}

interface PopoverProps {
  label: JSX.Element,
  title: string,
  ariaLabel: string,
  buttonClass?: string,
  width?: number,
  disabled?: boolean,
  buttonRef?: (el: HTMLButtonElement) => void,
  onTabKey?: (ev: KeyboardEvent) => void,
  onOpen?: () => void,
  children: (close: () => void) => JSX.Element,
}

export const stopQueryPickerEvent = (ev: Event) => ev.stopPropagation();

/** Shared placement, keyboard containment and focus return for query configuration dialogs. */
export function QueryPickerPopover(props: PopoverProps) {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const close = () => {
    setOpen(false);
    queueMicrotask(() => { if (button?.isConnected) { button.focus(); } });
  };
  const updateAnchor = () => setAnchor(button?.getBoundingClientRect() ?? null);

  createEffect(() => {
    if (props.disabled && open()) { close(); }
  });
  createEffect(() => {
    if (!open()) { return; }
    queueMicrotask(() => {
      const target = panel?.querySelector<HTMLElement>("[data-picker-autofocus]:not([disabled])")
        ?? panel?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), button:not([disabled]), summary, [tabindex='0']") ?? panel;
      target?.focus();
    });
    const escape = (ev: KeyboardEvent) => {
      if (ev.key == "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); close(); }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    onCleanup(() => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    });
  });

  const panelStyle = () => {
    const rect = anchor();
    const margin = 8;
    const gap = 6;
    const width = Math.min(props.width ?? 420, Math.max(0, window.innerWidth - margin * 2));
    const above = rect == null ? 0 : rect.top - margin - gap;
    const below = rect == null ? window.innerHeight - margin * 2 : window.innerHeight - rect.bottom - margin - gap;
    const placeAbove = above > below;
    const height = Math.max(0, Math.min(520, placeAbove ? above : below, window.innerHeight - margin * 2));
    // Open towards the middle of the window: from the button's left edge when it is in the left half.
    const preferredLeft = rect == null ? margin
      : rect.left + rect.width / 2 < window.innerWidth / 2 ? rect.left : rect.right - width;
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin));
    const vertical = rect == null ? `top: ${margin}px;` : placeAbove
      ? `bottom: ${Math.max(margin, window.innerHeight - rect.top + gap)}px;`
      : `top: ${rect.bottom + gap}px;`;
    return `left: ${left}px; ${vertical} width: ${width}px; max-height: ${height}px; z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 1};`;
  };
  const panelKeyDown = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (panel == null) { return; }
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    if ((ev.key == "ArrowDown" || ev.key == "ArrowUp") && target?.getAttribute("role") == "radio") {
      const group = target.closest("[role='radiogroup']");
      const options = Array.from(group?.querySelectorAll<HTMLElement>("[role='radio']:not([disabled]):not([aria-disabled='true'])") ?? []);
      const index = options.indexOf(target);
      if (index >= 0) {
        ev.preventDefault();
        options[(index + (ev.key == "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      }
    }
    if (ev.key != "Tab") { return; }
    const elements = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex='0']"))
      .filter(el => el.getClientRects().length > 0 && el.getAttribute("aria-disabled") != "true");
    if (elements.length == 0) { ev.preventDefault(); panel.focus(); return; }
    const first = elements[0];
    const last = elements[elements.length - 1];
    // A focused control may disappear or become disabled while a request or save starts.
    if (!elements.includes(document.activeElement as HTMLElement)) {
      ev.preventDefault(); (ev.shiftKey ? last : first)?.focus(); return;
    }
    if (ev.shiftKey && document.activeElement == first) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && document.activeElement == last) { ev.preventDefault(); first?.focus(); }
  };

  return <>
    <button
      ref={el => { button = el; props.buttonRef?.(el); }} type="button" disabled={props.disabled}
      class={`flex h-[22px] min-w-0 items-center gap-1 overflow-hidden rounded-md border border-[#d6d6d6] bg-white px-2 text-[#555] hover:bg-slate-50 disabled:cursor-default disabled:opacity-50 ${props.buttonClass ?? ""}`}
      style="font-size: 12px; line-height: 18px;" title={props.title}
      aria-label={props.ariaLabel} aria-haspopup="dialog" aria-expanded={open()}
      onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent}
      onClick={ev => {
        ev.stopPropagation();
        if (open()) { close(); }
        else { updateAnchor(); props.onOpen?.(); setOpen(true); }
      }}
      onKeyDown={ev => { ev.stopPropagation(); if (ev.key == "Tab" && !open()) { props.onTabKey?.(ev); } }}>
      {props.label}<i class="bi-chevron-expand ml-auto shrink-0 text-[10px]" />
    </button>
    <Show when={open()}>
      <Portal mount={document.body}>
        <div class="fixed inset-0" style={`z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`}
          onMouseDown={ev => { ev.stopPropagation(); close(); }} onClick={stopQueryPickerEvent} />
        <div ref={panel} tabindex={-1} role="dialog" aria-modal="true" aria-label={props.ariaLabel}
          class="fixed flex flex-col overflow-hidden rounded-md border border-slate-300 bg-white text-black shadow-lg"
          style={panelStyle()} onMouseDown={stopQueryPickerEvent} onMouseUp={stopQueryPickerEvent}
          onClick={stopQueryPickerEvent} onKeyDown={panelKeyDown} onKeyUp={stopQueryPickerEvent}>
          {props.children(close)}
        </div>
      </Portal>
    </Show>
  </>;
}
