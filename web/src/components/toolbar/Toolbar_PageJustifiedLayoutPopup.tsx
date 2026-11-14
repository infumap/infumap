/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, For, Show, createMemo, createSignal } from "solid-js";
import createJustifiedLayout from "justified-layout";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { PageItem, asPageItem } from "../../items/page-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { createJustifyOptions } from "../../layout/arrange/page_justified";
import { calcJustifiedBoxSpacingPx, calcJustifiedPagePaddingPx, calcJustifiedTargetRowHeightPx } from "../../layout/arrange/justified_metrics";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  TOOLBAR_DIALOG_INPUT_CLASS, ToolbarDialogPageShapeSection, closeToolbarDialog, toolbarDialogContentRef,
  toolbarDialogNumberInput, toolbarDialogItemChanged,
} from "./toolbarDialog";
import { DIALOG_LABEL_CLASS, DIALOG_NOTE_CLASS, DialogHeader, dialogButtonClass } from "../library/dialogStyle";


export const PAGE_JUSTIFIED_LAYOUT_POPUP_HEIGHT_PX = 420;

const SCHEMATIC_W_PX = 306;
const SCHEMATIC_H_PX = 150;
const SCHEMATIC_PAD_PX = 6;
// Row aspect is the page width over the target row height, so a larger value means smaller rows.
const MIN_ROW_ASPECT = 1.5;
const MAX_ROW_ASPECT = 30;
const SLIDER_STEPS = 1000;
// Drawn for an empty page, so the row height still has something to show.
const EMPTY_PAGE_DIMS = Array.from({ length: 9 }, (_, i) => ({ width: i % 3 == 1 ? 2 : 3, height: 2 }));

const roundRowAspect = (rowAspect: number): number => Math.round(rowAspect * 10) / 10;

/** The sizes of a page's children, as the justified arrangement lays them out. */
function childDims(page: PageItem): Array<{ width: number, height: number }> {
  return page.computed_children
    .map(id => itemState.get(id))
    .filter(item => item != null)
    .map(item => { const d = ItemFns.calcSpatialDimensionsBl(item!); return { width: d.w, height: d.h }; });
}

function rowCount(layout: { boxes: Array<{ top: number }> }): number {
  return new Set(layout.boxes.map(box => Math.round(box.top))).size;
}

/** About how many rows of a justified page with this row aspect fit in the window, at full screen. */
function justifiedRowsPerWindow(store: StoreContextModel, rowAspect: number): number {
  const windowPx = store.desktopMainAreaBoundsPx();
  const rowHPx = calcJustifiedTargetRowHeightPx(windowPx.w, rowAspect);
  const spacingPx = calcJustifiedBoxSpacingPx(windowPx.w, rowAspect);
  const paddingPx = calcJustifiedPagePaddingPx(windowPx.w, rowAspect);
  return (windowPx.h - 2 * paddingPx + spacingPx) / (rowHPx + spacingPx);
}

function justifiedRowsPerWindowText(store: StoreContextModel, rowAspect: number): string {
  const rows = justifiedRowsPerWindow(store, rowAspect);
  return String(rows < 10 ? Math.round(rows * 10) / 10 : Math.round(rows));
}

// The slider is logarithmic in row height, so each step changes the size by the same proportion, and runs from
// small rows on the left to large on the right.
const sliderFromRowAspect = (rowAspect: number): number =>
  Math.round(SLIDER_STEPS * Math.log(MAX_ROW_ASPECT / rowAspect) / Math.log(MAX_ROW_ASPECT / MIN_ROW_ASPECT));
const rowAspectFromSlider = (value: number): number =>
  MAX_ROW_ASPECT * Math.pow(MIN_ROW_ASPECT / MAX_ROW_ASPECT, value / SLIDER_STEPS);

const ROW_SIZE_WORDS = ["tiny", "small", "medium", "large", "huge"];

/**
 * The row height of a justified page as a word, from equal parts of the slider. It is what the toolbar shows: no
 * number (rows in the page or the window, items per row) reads well there, and this doesn't depend on the window.
 */
export function justifiedRowSizeWord(rowAspect: number): string {
  const part = Math.floor(sliderFromRowAspect(rowAspect) * ROW_SIZE_WORDS.length / (SLIDER_STEPS + 1));
  return ROW_SIZE_WORDS[Math.max(0, Math.min(ROW_SIZE_WORDS.length - 1, part))];
}

/**
 * Sets the row height of a justified page, previewed as one window's worth of the page laid out with its own items,
 * and, separately, the page's shape where it is shown inside something else.
 */
export const Toolbar_PageJustifiedLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [rowAspect, setRowAspect] = createSignal(pageItem().justifiedRowAspect);

  // Children don't change while the popup is open: anywhere else they could be changed from closes it.
  const itemDims = childDims(pageItem());
  const windowPx = store.desktopMainAreaBoundsPx();
  const windowAspect = windowPx.w / windowPx.h;

  const layoutAt = (widthPx: number, ra: number) =>
    createJustifiedLayout(itemDims.length == 0 ? EMPTY_PAGE_DIMS : itemDims, createJustifyOptions(widthPx, ra));

  // The largest rows that show every item in the window without scrolling, or null if even the smallest don't.
  // Smaller rows always make the page shorter, so a binary search finds it.
  const fitInWindowRowAspect = ((): number | null => {
    if (itemDims.length == 0) { return null; }
    const fits = (ra: number) => layoutAt(windowPx.w, ra).containerHeight <= windowPx.h;
    if (!fits(MAX_ROW_ASPECT)) { return null; }
    if (fits(MIN_ROW_ASPECT)) { return MIN_ROW_ASPECT; }
    let lo = MIN_ROW_ASPECT, hi = MAX_ROW_ASPECT;
    for (let i = 0; i < 30; ++i) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) { hi = mid; } else { lo = mid; }
    }
    // Rounded up, as shown, so the rounding can't tip it into scrolling.
    return Math.ceil(hi * 10) / 10;
  })();

  const apply = (requested: number, save: boolean = true) => {
    const value = Math.max(MIN_ROW_ASPECT, Math.min(MAX_ROW_ASPECT, requested));
    setRowAspect(value);
    if (pageItem().justifiedRowAspect == value) {
      if (save) { toolbarDialogItemChanged(store, pageItem(), "toolbar-justified-row-aspect"); }
      return;
    }
    pageItem().justifiedRowAspect = value;
    toolbarDialogItemChanged(store, pageItem(), "toolbar-justified-row-aspect", save);
  };

  const close = () => closeToolbarDialog(store);

  // Schematic: the window, at full screen, showing the top of the page.

  const frameWPx = Math.min(SCHEMATIC_W_PX - 2 * SCHEMATIC_PAD_PX, (SCHEMATIC_H_PX - 2 * SCHEMATIC_PAD_PX) * windowAspect);
  const frameHPx = frameWPx / windowAspect;
  const frameStyle = `left: ${(SCHEMATIC_W_PX - frameWPx) / 2}px; top: ${(SCHEMATIC_H_PX - frameHPx) / 2}px; width: ${frameWPx}px; height: ${frameHPx}px;`;
  const miniature = createMemo(() => layoutAt(frameWPx, rowAspect()));
  const fullLayout = createMemo(() => layoutAt(windowPx.w, rowAspect()));
  const rows = () => rowCount(fullLayout());
  const scrolls = () => miniature().containerHeight > frameHPx;

  const plural = (n: number, word: string) => `${n} ${word}${n == 1 ? "" : "s"}`;
  const statusText = () => {
    const fitText = `About ${justifiedRowsPerWindowText(store, rowAspect())} rows fit in the window.`;
    if (itemDims.length == 0) { return `No items yet. ${fitText}`; }
    const perRow = Math.round(itemDims.length / rows() * 10) / 10;
    return `${plural(itemDims.length, "item")} in ${plural(rows(), "row")}, about ${perRow} per row. ${scrolls() ? fitText : "All are in view at full screen."}`;
  };

  const fitTitle = () => itemDims.length == 0
    ? "There are no items on this page"
    : fitInWindowRowAspect == null
      ? "There are too many items to fit in the window"
      : "Make the rows as large as possible with every item in view at full screen";

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Justified layout" onClose={close}
        description="Items keep their shape and fill rows the width of the page, which scrolls down. Row height sets how big they are." />

      <div class="px-3 py-3">
        <div class="relative overflow-hidden rounded-control border border-chrome-line bg-neutral-50"
          style={`width: ${SCHEMATIC_W_PX}px; height: ${SCHEMATIC_H_PX}px;`}>
          <div class="absolute overflow-hidden border border-neutral-400 bg-white" style={frameStyle} title="The window, at full screen">
            <For each={miniature().boxes}>{box =>
              // Drawn a pixel smaller than laid out: at this scale the spacing between items is less than a pixel.
              <div class={`absolute rounded-[1px] ${itemDims.length == 0 ? "border border-dashed border-neutral-300" : "bg-neutral-300"}`}
                style={`left: ${box.left}px; top: ${box.top}px; width: ${Math.max(1, box.width - 1)}px; height: ${Math.max(1, box.height - 1)}px;`} />
            }</For>
            <Show when={scrolls()}>
              <div class="pointer-events-none absolute bottom-0 left-0 h-[24px] w-full"
                style="background: linear-gradient(to top, rgb(255 255 255), rgb(255 255 255 / 0));" />
            </Show>
          </div>
        </div>
        <div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>{statusText()}</div>

        <div class="mt-3 flex items-center gap-2">
          <div class={`w-[72px] shrink-0 leading-[15px] ${DIALOG_LABEL_CLASS}`}>Row height
            <div class="text-[11px] text-neutral-500">{justifiedRowSizeWord(rowAspect())}</div>
          </div>
          <i class="bi-grid-3x3-gap text-[11px] text-neutral-400" title="Smaller" />
          <input class="min-w-0 grow accent-neutral-600" type="range" min="0" max={SLIDER_STEPS} step="1" aria-label="Row height"
            value={sliderFromRowAspect(rowAspect())}
            onInput={ev => apply(rowAspectFromSlider(parseInt(ev.currentTarget.value)), false)}
            onChange={ev => apply(rowAspectFromSlider(parseInt(ev.currentTarget.value)))}
            onKeyDown={ev => { ev.stopPropagation(); if (ev.key == "Escape") { ev.preventDefault(); close(); } }} />
          <i class="bi-grid-1x2 text-[13px] text-neutral-400" title="Larger" />
        </div>

        <div class="mt-2 flex items-center gap-2">
          <label class={`flex items-center gap-[6px] ${DIALOG_LABEL_CLASS}`}
            title="Page width divided by row height. Larger values give smaller rows.">Aspect
            <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={MIN_ROW_ASPECT} max={MAX_ROW_ASPECT} step="0.1"
              value={roundRowAspect(rowAspect())} {...toolbarDialogNumberInput(store, rowAspect, apply, 0.1, v => String(roundRowAspect(v)))} />
          </label>
          <button type="button" class={dialogButtonClass()} disabled={fitInWindowRowAspect == null}
            title={fitTitle()} onClick={() => apply(fitInWindowRowAspect!)}>Fit in window</button>
        </div>
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
