/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, Index, Show, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  ToolbarDialogPageShapeSection, ToolbarDialogStepper, closeToolbarDialog,
  toolbarDialogContentRef, toolbarDialogItemChanged,
} from "./toolbarDialog";
import { DIALOG_NOTE_CLASS, DialogHeader } from "../library/dialogStyle";
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

  const changed = (reason: string) => toolbarDialogItemChanged(store, pageItem(), reason);

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

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <DialogHeader title="Grid layout" onClose={close}
        description="The grid fills the width of the page and scrolls down. Columns and cell shape set how big the cells are." />

      <div class="px-3 py-3">
        <div class="relative overflow-hidden rounded-control border border-chrome-line bg-neutral-50"
          style={`width: ${SCHEMATIC_W_PX}px; height: ${SCHEMATIC_H_PX}px;`}>
          <Index each={cellIndexes()}>{i =>
            <div class={`absolute rounded-[2px] ${itemCount == 0 ? "border border-dashed border-neutral-300" : "bg-neutral-300"}`}
              style={cellStyle(i())} />
          }</Index>
          <Show when={overflows()}>
            <div class="pointer-events-none absolute bottom-0 left-0 h-[28px] w-full"
              style="background: linear-gradient(to top, rgb(248 250 252), rgb(248 250 252 / 0));" />
          </Show>
        </div>
        <div class={`mt-1 ${DIALOG_NOTE_CLASS}`}>{statusText()}</div>

        <div class="mt-3">
          <ToolbarDialogStepper label="Columns" value={columns} apply={applyColumns} min={MIN_COLUMNS} max={MAX_COLUMNS}
            decreaseLabel="Fewer columns" increaseLabel="More columns" />
        </div>

        <ToolbarDialogCellShapeSection label="Cell shape" aspect={cellAspect} apply={applyCellAspect} imageAspects={imageAspects}
          minAspect={MIN_ASPECT} maxAspect={MAX_ASPECT} />
      </div>

      <ToolbarDialogPageShapeSection page={pageItem} />
    </div>
  );
}
