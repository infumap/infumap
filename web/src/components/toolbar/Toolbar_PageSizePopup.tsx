/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { PageFns, asPageItem, autoPageAspect } from "../../items/page-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asPositionalItem, isPositionalItem } from "../../items/base/positional-item";
import { itemState } from "../../store/ItemState";
import { GRID_SIZE } from "../../constants";
import { requestArrange } from "../../layout/arrange";
import { SPATIAL_SCROLL_X_ASPECT_RATIO, SPATIAL_SCROLL_Y_ASPECT_RATIO } from "../../layout/arrange/page_spatial";
import { serverOrRemote } from "../../server";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { getToolbarFocusItem } from "./toolbarFocus";
import {
  TOOLBAR_DIALOG_INPUT_CLASS, ToolbarDialogHeader, closeToolbarDialog, toolbarDialogButtonClass, toolbarDialogContentRef, toolbarDialogNumberInput,
} from "./toolbarDialog";


export const PAGE_SIZE_POPUP_HEIGHT_PX = 362;

const SCHEMATIC_W_PX = 306;
const SCHEMATIC_H_PX = 150;
const SCHEMATIC_PAD_PX = 8;
// The page is drawn at this fraction of the schematic, so there is room to drag it larger. The scale is held for the
// duration of a drag, and the page is redrawn at this fraction when the drag ends, ready to be dragged larger again.
const SCHEMATIC_FILL = 0.6;
const MIN_SIZE_BL = 2;
const MAX_SIZE_BL = 2000;
const FIT_MARGIN_BL = 1;

type DragEdge = "right" | "bottom" | "corner";

interface DragState {
  edge: DragEdge,
  startClientPx: { x: number, y: number },
  startSizeBl: Dimensions,
  scale: number,
}

/**
 * The aspect to store for a page of w x h blocks. The page height is derived as floor(w / aspect), so w / h exactly
 * can come back as h - 1 from floating point error.
 */
function aspectForSizeBl(w: number, h: number): number {
  return w / (h + 1e-6);
}

/** The block rectangles of the page's children, as positioned in it. */
function childRectsBl(pageId: string): Array<BoundingBox> {
  const page = asPageItem(itemState.get(pageId)!);
  const result: Array<BoundingBox> = [];
  for (const childId of page.computed_children) {
    const child = itemState.get(childId);
    if (child == null || !isPositionalItem(child)) { continue; }
    const sizeBl = ItemFns.calcSpatialDimensionsBl(child);
    const posGr = asPositionalItem(child).spatialPositionGr;
    result.push({ x: posGr.x / GRID_SIZE, y: posGr.y / GRID_SIZE, w: sizeBl.w, h: sizeBl.h });
  }
  return result;
}

/**
 * Sets the inner size of a spatial page in blocks: drag the page outline (it is drawn small so it can grow), type
 * the numbers, or fit it to its items or to the window.
 */
export const Toolbar_PageSizePopup: Component = () => {
  const store = useStore();

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const [sizeBl, setSizeBl] = createSignal<Dimensions>(PageFns.calcInnerSpatialDimensionsBl(pageItem()));
  const [dragScale, setDragScale] = createSignal<number | null>(null);
  let drag: DragState | null = null;

  // Children don't change while the popup is open: anywhere else they could be changed from closes it.
  const childRects = childRectsBl(pageItem().id);
  const extentBl: Dimensions = {
    w: childRects.reduce((m, r) => Math.max(m, r.x + r.w), 0),
    h: childRects.reduce((m, r) => Math.max(m, r.y + r.h), 0),
  };
  // The page may be made smaller than its items reach: arrange moves those items into view and draws them with the
  // moved-into-view warning, and the schematic marks them. An item flush with the right or bottom edge already counts
  // as outside when arranged (its bounds include a border pixel), so the page must reach past it to contain it.
  const reachBl = (r: BoundingBox): Dimensions => ({ w: Math.floor(r.x + r.w) + 1, h: Math.floor(r.y + r.h) + 1 });
  const isOutside = (r: BoundingBox) => {
    const reach = reachBl(r);
    return reach.w > sizeBl().w || reach.h > sizeBl().h;
  };

  const restingScale = () => {
    const w = Math.max(sizeBl().w, extentBl.w);
    const h = Math.max(sizeBl().h, extentBl.h);
    return Math.min(
      (SCHEMATIC_W_PX - 2 * SCHEMATIC_PAD_PX) * SCHEMATIC_FILL / w,
      (SCHEMATIC_H_PX - 2 * SCHEMATIC_PAD_PX) * SCHEMATIC_FILL / h);
  };
  const scale = () => dragScale() ?? restingScale();

  const clampSize = (v: number, max: number = MAX_SIZE_BL) => Math.max(MIN_SIZE_BL, Math.min(max, v));

  const setSize = (requestedW: number, requestedH: number, maxW: number = MAX_SIZE_BL, maxH: number = MAX_SIZE_BL) => {
    const w = clampSize(Math.round(requestedW), maxW);
    const h = clampSize(Math.round(requestedH), maxH);
    applySize(w, aspectForSizeBl(w, h));
  };

  const applySize = (w: number, aspect: number) => {
    const page = pageItem();
    if (page.innerSpatialWidthGr == w * GRID_SIZE && page.naturalAspect == aspect) { return; }
    page.innerSpatialWidthGr = w * GRID_SIZE;
    page.naturalAspect = aspect;
    setSizeBl(PageFns.calcInnerSpatialDimensionsBl(page));
    store.touchToolbar();
    requestArrange(store, "toolbar-page-size");
  };

  const save = () => { serverOrRemote.updateItem(pageItem()); };

  const close = () => closeToolbarDialog(store);

  // Drag

  const handlePointerDown = (edge: DragEdge) => (ev: PointerEvent) => {
    if (ev.button != 0) { return; }
    ev.preventDefault();
    ev.stopPropagation();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    drag = { edge, startClientPx: { x: ev.clientX, y: ev.clientY }, startSizeBl: sizeBl(), scale: scale() };
    setDragScale(drag.scale);
  };

  const handlePointerMove = (ev: PointerEvent) => {
    if (drag == null) { return; }
    const s = drag.scale;
    const maxW = Math.floor((SCHEMATIC_W_PX - 2 * SCHEMATIC_PAD_PX) / s);
    const maxH = Math.floor((SCHEMATIC_H_PX - 2 * SCHEMATIC_PAD_PX) / s);
    const w = drag.edge == "bottom" ? drag.startSizeBl.w : drag.startSizeBl.w + (ev.clientX - drag.startClientPx.x) / s;
    const h = drag.edge == "right" ? drag.startSizeBl.h : drag.startSizeBl.h + (ev.clientY - drag.startClientPx.y) / s;
    setSize(w, h, Math.max(maxW, drag.startSizeBl.w), Math.max(maxH, drag.startSizeBl.h));
  };

  const handlePointerUp = (ev: PointerEvent) => {
    if (drag == null) { return; }
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    drag = null;
    setDragScale(null);
    save();
  };

  // Typed values

  const sizeInput = (dim: "w" | "h") => toolbarDialogNumberInput(store, () => sizeBl()[dim], value => {
    if (dim == "w") { setSize(value, sizeBl().h); } else { setSize(sizeBl().w, value); }
    save();
  }, 1);

  // Presets

  const handleFitToItems = () => {
    setSize(extentBl.w + FIT_MARGIN_BL, extentBl.h + FIT_MARGIN_BL);
    save();
  };

  const handleMatchWindow = () => {
    const aspect = autoPageAspect(store);
    let w = clampSize(sizeBl().w);
    if (Math.floor(w / aspect) < MIN_SIZE_BL) { w = clampSize(Math.ceil(MIN_SIZE_BL * aspect)); }
    applySize(w, aspect);
    save();
  };

  // Status

  const fullScreenText = () => {
    sizeBl();
    const windowPx = store.desktopMainAreaBoundsPx();
    const ratio = pageItem().naturalAspect / (windowPx.w / windowPx.h);
    if (ratio > SPATIAL_SCROLL_X_ASPECT_RATIO) { return "scrolls sideways"; }
    if (ratio < SPATIAL_SCROLL_Y_ASPECT_RATIO) { return "scrolls down"; }
    return "fills the window";
  };

  const aspectText = () => {
    sizeBl();
    return Math.round(pageItem().naturalAspect * 100) / 100;
  };

  const itemsOutside = () => childRects.some(isOutside);

  // Schematic geometry

  const pageRectPx = createMemo(() => ({
    x: SCHEMATIC_PAD_PX,
    y: SCHEMATIC_PAD_PX,
    w: sizeBl().w * scale(),
    h: sizeBl().h * scale(),
  }));

  const childRectPx = (r: BoundingBox) => ({
    x: SCHEMATIC_PAD_PX + r.x * scale(),
    y: SCHEMATIC_PAD_PX + r.y * scale(),
    w: Math.max(1, r.w * scale()),
    h: Math.max(1, r.h * scale()),
  });

  const boxStyle = (b: BoundingBox) => `left: ${b.x}px; top: ${b.y}px; width: ${b.w}px; height: ${b.h}px;`;

  const handleProps = (edge: DragEdge) => ({
    onPointerDown: handlePointerDown(edge),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
  });

  return (
    <div ref={el => toolbarDialogContentRef(el)} class="flex flex-col" onKeyDown={ev => { if (ev.key == "Escape") { ev.stopPropagation(); close(); } }}>
      <ToolbarDialogHeader title="Page size" onClose={close}
        description="In blocks: one block is the height of a line of text. Drag the outline to resize." />

      <div class="px-3 py-3">
        <div class="relative overflow-hidden rounded border border-slate-200 bg-slate-50"
          style={`width: ${SCHEMATIC_W_PX}px; height: ${SCHEMATIC_H_PX}px;`}>
          <div class={`absolute border bg-white ${itemsOutside() ? "border-amber-500" : "border-slate-400"}`} style={boxStyle(pageRectPx())} />
          <For each={childRects}>{r =>
            <div class={`absolute rounded-[1px] ${isOutside(r) ? "bg-amber-400" : "bg-slate-300"}`} style={boxStyle(childRectPx(r))} />
          }</For>
          <div class="absolute cursor-ew-resize hover:bg-blue-500/20" style={`${boxStyle({ x: pageRectPx().x + pageRectPx().w - 4, y: pageRectPx().y, w: 8, h: pageRectPx().h })} touch-action: none;`}
            title="Drag to change the width" {...handleProps("right")} />
          <div class="absolute cursor-ns-resize hover:bg-blue-500/20" style={`${boxStyle({ x: pageRectPx().x, y: pageRectPx().y + pageRectPx().h - 4, w: pageRectPx().w, h: 8 })} touch-action: none;`}
            title="Drag to change the height" {...handleProps("bottom")} />
          <div class="absolute cursor-nwse-resize rounded-[3px] border-2 border-blue-600 bg-white" style={`${boxStyle({ x: pageRectPx().x + pageRectPx().w - 6, y: pageRectPx().y + pageRectPx().h - 6, w: 12, h: 12 })} touch-action: none;`}
            title="Drag to change the size" {...handleProps("corner")} />
        </div>

        <div class="mt-[10px] flex items-center gap-2 text-[12px] text-slate-600">
          <label class="flex items-center gap-[6px]">Width
            <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={MIN_SIZE_BL} max={MAX_SIZE_BL} step="1" value={sizeBl().w}
              {...sizeInput("w")} />
          </label>
          <span class="text-slate-400">×</span>
          <label class="flex items-center gap-[6px]">Height
            <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={MIN_SIZE_BL} max={MAX_SIZE_BL} step="1" value={sizeBl().h}
              {...sizeInput("h")} />
          </label>
        </div>

        <div class="mt-2 text-[11px] leading-[16px] text-slate-500">
          Aspect {aspectText()}. At full screen it {fullScreenText()}.
        </div>
        <Show when={itemsOutside()}>
          <div class="text-[11px] leading-[16px] text-amber-700">Some items are outside the page. Fit to items brings them back in.</div>
        </Show>
      </div>

      <div class="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2">
        <button type="button" class={toolbarDialogButtonClass()} disabled={childRects.length == 0}
          title="Size the page to its items, plus a block of margin" onClick={handleFitToItems}>Fit to items</button>
        <button type="button" class={toolbarDialogButtonClass()}
          title="Keep the width and set the height so the page fills the window without stretching" onClick={handleMatchWindow}>Match window aspect</button>
      </div>
    </div>
  );
}
