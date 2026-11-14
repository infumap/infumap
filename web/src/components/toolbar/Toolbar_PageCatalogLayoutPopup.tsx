/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Index, Show, createMemo, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { CATALOG_DETAIL_COLUMN_PADDING_PX, calcCatalogLayout } from "../../layout/catalog";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  ToolbarDialogPageShapeSection, closeToolbarDialog, toolbarDialogContentRef, toolbarDialogItemChanged,
} from "./toolbarDialog";
import { DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";
import { ToolbarDialogCellShapeSection, childImageAspects } from "./toolbarCellShape";


const SCHEMATIC_W_PX = 306;
const SCHEMATIC_H_PX = 150;
const SCHEMATIC_PAD_PX = 6;
// The catalog layout treats anything narrower as this (see calcCatalogRowHeightPx).
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 10;
// Drawn for an empty page, so the preview shape still has something to show.
const EMPTY_PAGE_ROWS = 4;

/**
 * Sets the preview shape of a catalog page, which lists one item per row with a preview beside its details, so the
 * shape sets how tall each row is. It is previewed as one window's worth of the page, as at full screen, because the
 * catalog layout depends on the actual width (the preview column is clamped, and the details are dropped on narrow
 * pages). Separately, it sets the page's shape where it is shown inside something else.
 */
export const Toolbar_PageCatalogLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [cellAspect, setCellAspect] = createSignal(pageItem().gridCellAspect);

  // Children don't change while the popup is open: anywhere else they could be changed from closes it.
  const itemCount = pageItem().computed_children.length;
  const imageAspects = childImageAspects(pageItem().id);
  const windowPx = store.desktopMainAreaBoundsPx();
  const windowAspect = windowPx.w / windowPx.h;

  const applyCellAspect = (requested: number) => {
    const value = Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, requested));
    setCellAspect(value);
    if (pageItem().gridCellAspect == value) { return; }
    pageItem().gridCellAspect = value;
    toolbarDialogItemChanged(store, pageItem(), "toolbar-catalog-cell-aspect");
  };

  const close = () => closeToolbarDialog(store);

  // Schematic: the window, at full screen, showing the top of the page.

  const frameWPx = Math.min(SCHEMATIC_W_PX - 2 * SCHEMATIC_PAD_PX, (SCHEMATIC_H_PX - 2 * SCHEMATIC_PAD_PX) * windowAspect);
  const frameHPx = frameWPx / windowAspect;
  const frameStyle = `left: ${(SCHEMATIC_W_PX - frameWPx) / 2}px; top: ${(SCHEMATIC_H_PX - frameHPx) / 2}px; width: ${frameWPx}px; height: ${frameHPx}px;`;
  const scale = frameWPx / windowPx.w;
  const layout = createMemo(() => calcCatalogLayout(frameWPx, cellAspect(), scale));
  const fullLayout = createMemo(() => calcCatalogLayout(windowPx.w, cellAspect(), 1));

  const rowsPerWindow = () => (windowPx.h - 2 * fullLayout().verticalMarginPx) / fullLayout().rowHeightPx;
  const rowCount = () => itemCount == 0 ? EMPTY_PAGE_ROWS : itemCount;
  const visibleRows = () => Math.min(rowCount(), Math.ceil(rowsPerWindow()));
  const scrolls = () => rowCount() > rowsPerWindow();
  const rowIndexes = () => Array.from({ length: visibleRows() }, (_, i) => i);

  const previewStyle = (i: number) => {
    const l = layout();
    return `left: ${l.horizontalMarginPx + l.cellMarginPx}px; top: ${l.verticalMarginPx + i * l.rowHeightPx + l.cellMarginPx}px; ` +
      `width: ${Math.max(1, l.previewColumnWidthPx - 2 * l.cellMarginPx)}px; height: ${Math.max(1, l.rowHeightPx - 2 * l.cellMarginPx)}px;`;
  };
  // The details as a title and two lines of text, beside the top of the preview.
  const detailStyle = (i: number, line: number) => {
    const l = layout();
    const x = l.horizontalMarginPx + l.previewColumnWidthPx + CATALOG_DETAIL_COLUMN_PADDING_PX * scale;
    const w = l.contentWidthPx - l.previewColumnWidthPx - 2 * CATALOG_DETAIL_COLUMN_PADDING_PX * scale;
    const y = l.verticalMarginPx + i * l.rowHeightPx + l.cellMarginPx + (line == 0 ? 0 : 2 + line * 4);
    return `left: ${x}px; top: ${y}px; width: ${w * [0.45, 0.9, 0.7][line]}px; height: ${line == 0 ? 3 : 2}px;`;
  };

  const plural = (n: number, word: string) => `${n} ${word}${n == 1 ? "" : "s"}`;
  const rowsPerWindowText = () => {
    const rows = rowsPerWindow();
    return String(rows < 10 ? Math.round(rows * 10) / 10 : Math.round(rows));
  };
  const statusText = () => {
    const fitText = `About ${rowsPerWindowText()} fit in the window.`;
    if (itemCount == 0) { return `No items yet. ${fitText}`; }
    return `${plural(itemCount, "item")}, one per row. ${scrolls() ? fitText : "All are in view at full screen."}`;
  };

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Catalog layout" onClose={close}
        description="One item per row: a preview, with its details beside it. The preview shape sets how tall the rows are." />

      <div class="px-3 py-3">
        <div class="relative overflow-hidden rounded-control border border-chrome-line bg-neutral-50"
          style={`width: ${SCHEMATIC_W_PX}px; height: ${SCHEMATIC_H_PX}px;`}>
          <div class="absolute overflow-hidden border border-neutral-400 bg-white" style={frameStyle} title="The window, at full screen">
            <Index each={rowIndexes()}>{i =>
              <>
                <div class={`absolute rounded-[1px] ${itemCount == 0 ? "border border-dashed border-neutral-300" : "bg-neutral-300"}`}
                  style={previewStyle(i())} />
                <Show when={layout().showDetailColumn}>
                  <Index each={[0, 1, 2]}>{line =>
                    <div class={`absolute rounded-[1px] ${line() == 0 ? "bg-neutral-400" : "bg-neutral-200"}`} style={detailStyle(i(), line())} />
                  }</Index>
                </Show>
              </>
            }</Index>
            <Show when={scrolls()}>
              <div class="pointer-events-none absolute bottom-0 left-0 h-[24px] w-full"
                style="background: linear-gradient(to top, rgb(255 255 255), rgb(255 255 255 / 0));" />
            </Show>
          </div>
        </div>
        <div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>{statusText()}</div>

        <ToolbarDialogCellShapeSection label="Preview shape" aspect={cellAspect} apply={applyCellAspect} imageAspects={imageAspects}
          minAspect={MIN_ASPECT} maxAspect={MAX_ASPECT} />
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
