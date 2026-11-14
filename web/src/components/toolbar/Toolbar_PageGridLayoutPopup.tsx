/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Index, Show, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  TOOLBAR_DIALOG_INPUT_CLASS, ToolbarDialogHeader, ToolbarDialogPageShapeSection, closeToolbarDialog, toolbarDialogNumberInput,
  toolbarDialogContentRef, toolbarDialogPageChanged,
} from "./toolbarDialog";
import { ToolbarDialogCellShapeSection, childImageAspects } from "./toolbarCellShape";


const SCHEMATIC_W_PX = 306;
const SCHEMATIC_H_PX = 112;
const SCHEMATIC_PAD_PX = 6;
const SCHEMATIC_GAP_PX = 2;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 20;
const MIN_ASPECT = 0.1;
const MAX_ASPECT = 10;

/**
 * Sets how a grid page lays out its items (columns and cell shape, previewed with the page's own item count), and,
 * separately, the page's shape where it is shown inside something else. The grid itself always takes the full width
 * of where it is shown, and scrolls down, so the page aspect has no effect on it.
 */
export const Toolbar_PageGridLayoutPopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [columns, setColumns] = createSignal(pageItem().gridNumberOfColumns);
  const [cellAspect, setCellAspect] = createSignal(pageItem().gridCellAspect);

  // Children don't change while the popup is open: anywhere else they could be changed from closes it.
  const itemCount = pageItem().computed_children.length;
  const imageAspects = childImageAspects(pageItem().id);

  const changed = (reason: string) => toolbarDialogPageChanged(store, pageItem(), reason);

  const applyColumns = (requested: number) => {
    const value = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(requested)));
    setColumns(value);
    if (pageItem().gridNumberOfColumns == value) { return; }
    pageItem().gridNumberOfColumns = value;
    changed("toolbar-grid-columns");
  };

  const applyCellAspect = (requested: number) => {
    const value = Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, requested));
    setCellAspect(value);
    if (pageItem().gridCellAspect == value) { return; }
    pageItem().gridCellAspect = value;
    changed("toolbar-grid-cell-aspect");
  };

  const close = () => closeToolbarDialog(store);

  // Schematic: the grid at the width of the schematic, with one cell per item.

  const rows = () => Math.ceil(itemCount / columns());
  const cellWPx = () => (SCHEMATIC_W_PX - 2 * SCHEMATIC_PAD_PX - (columns() - 1) * SCHEMATIC_GAP_PX) / columns();
  const cellHPx = () => cellWPx() / cellAspect();
  const visibleRows = () => Math.max(1, Math.ceil((SCHEMATIC_H_PX - SCHEMATIC_PAD_PX) / (cellHPx() + SCHEMATIC_GAP_PX)));
  const overflows = () => rows() > visibleRows() ||
    SCHEMATIC_PAD_PX + rows() * (cellHPx() + SCHEMATIC_GAP_PX) > SCHEMATIC_H_PX;
  const cellCount = () => itemCount == 0 ? columns() : Math.min(itemCount, visibleRows() * columns());
  const cellStyle = (i: number) => {
    const col = i % columns();
    const row = Math.floor(i / columns());
    return `left: ${SCHEMATIC_PAD_PX + col * (cellWPx() + SCHEMATIC_GAP_PX)}px; top: ${SCHEMATIC_PAD_PX + row * (cellHPx() + SCHEMATIC_GAP_PX)}px; ` +
      `width: ${cellWPx()}px; height: ${cellHPx()}px;`;
  };
  const cellIndexes = () => Array.from({ length: cellCount() }, (_, i) => i);

  const plural = (n: number, word: string) => `${n} ${word}${n == 1 ? "" : "s"}`;
  const statusText = () => itemCount == 0 ? "No items yet." : `${plural(itemCount, "item")} in ${plural(rows(), "row")}.`;

  const sectionLabelClass = "text-[12px] text-slate-600";
  const stepperButtonClass = "h-[24px] w-[24px] rounded-md border border-[#d6d6d6] bg-white text-[12px] text-[#555] hover:bg-slate-50 disabled:cursor-default disabled:opacity-50";

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <ToolbarDialogHeader title="Grid layout" onClose={close}
        description="The grid fills the width of the page and scrolls down. Columns and cell shape set how big the cells are." />

      <div class="px-3 py-3">
        <div class="relative overflow-hidden rounded border border-slate-200 bg-slate-50"
          style={`width: ${SCHEMATIC_W_PX}px; height: ${SCHEMATIC_H_PX}px;`}>
          <Index each={cellIndexes()}>{i =>
            <div class={`absolute rounded-[2px] ${itemCount == 0 ? "border border-dashed border-slate-300" : "bg-slate-300"}`}
              style={cellStyle(i())} />
          }</Index>
          <Show when={overflows()}>
            <div class="pointer-events-none absolute bottom-0 left-0 h-[28px] w-full"
              style="background: linear-gradient(to top, rgb(248 250 252), rgb(248 250 252 / 0));" />
          </Show>
        </div>
        <div class="mt-1 text-[11px] leading-[16px] text-slate-500">{statusText()}</div>

        <div class="mt-3 flex items-center gap-2">
          <div class={`${sectionLabelClass} w-[72px]`}>Columns</div>
          <button type="button" class={stepperButtonClass} aria-label="Fewer columns" disabled={columns() <= MIN_COLUMNS}
            onClick={() => applyColumns(columns() - 1)}><i class="bi-dash" /></button>
          <input class={`${TOOLBAR_DIALOG_INPUT_CLASS} !w-[44px] text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`} type="number" min={MIN_COLUMNS} max={MAX_COLUMNS} step="1"
            aria-label="Columns" value={columns()} {...toolbarDialogNumberInput(store, columns, applyColumns, 1)} />
          <button type="button" class={stepperButtonClass} aria-label="More columns" disabled={columns() >= MAX_COLUMNS}
            onClick={() => applyColumns(columns() + 1)}><i class="bi-plus" /></button>
        </div>

        <ToolbarDialogCellShapeSection label="Cell shape" aspect={cellAspect} apply={applyCellAspect} imageAspects={imageAspects}
          minAspect={MIN_ASPECT} maxAspect={MAX_ASPECT} />
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
