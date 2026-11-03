/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Component, For, Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { GRID_SIZE, Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { Item } from "../../items/base/item";
import { GroupFns } from "../../items/base/group-item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../../items/base/positional-item";
import { CompositeFns, isComposite } from "../../items/composite-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../../items/page-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath } from "../../layout/visual-element";
import { serverOrRemote } from "../../server";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { LIGHT_BORDER_COLOR } from "../../style";
import { BoundingBox, Dimensions, Vector } from "../../util/geometry";
import { Uid, newUid } from "../../util/uid";
import { arrangeNow } from "../../layout/arrange";


type SelectionGroupActionKind = "group" | "ungroup";
type SelectionCleanUpActionKind = "clean up" | "undo";

interface SelectionGroupActionInfo {
  groupKind: SelectionGroupActionKind | null;
  cleanUpKind: SelectionCleanUpActionKind | null;
  cleanUpPositionsGr: Map<Uid, Vector> | null;
  items: Array<Item>;
  positionalItems: Array<PositionalItem> | null;
  boundsPx: BoundingBox;
}

interface CleanUpUndo {
  selectionKey: string;
  beforeGr: Map<Uid, Vector>;
  afterGr: Map<Uid, Vector>;
}

const ACTION_HEIGHT_PX = 19;
const ACTION_MARGIN_PX = 6;
const ACTION_GAP_PX = 4;
const ACTION_MIN_WIDTH_PX = 58;
const ACTION_HORIZONTAL_PADDING_PX = 9;
const ACTION_FONT_SIZE_PX = 11;

function treeItemIdFromVeid(veid: Veid): Uid {
  return veid.linkIdMaybe ?? veid.itemId;
}

function approxActionWidthPx(label: string): number {
  return Math.max(
    ACTION_MIN_WIDTH_PX,
    Math.round(label.length * ACTION_FONT_SIZE_PX * 0.56) + ACTION_HORIZONTAL_PADDING_PX * 2,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unionBounds(bounds: Array<BoundingBox>): BoundingBox | null {
  if (bounds.length == 0) { return null; }

  let x1 = bounds[0].x;
  let y1 = bounds[0].y;
  let x2 = bounds[0].x + bounds[0].w;
  let y2 = bounds[0].y + bounds[0].h;

  for (let i = 1; i < bounds.length; ++i) {
    x1 = Math.min(x1, bounds[i].x);
    y1 = Math.min(y1, bounds[i].y);
    x2 = Math.max(x2, bounds[i].x + bounds[i].w);
    y2 = Math.max(y2, bounds[i].y + bounds[i].h);
  }

  return {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
  };
}

const HALF_BLOCK_GR = GRID_SIZE / 2;
const CLEAN_UP_GAP_GR = HALF_BLOCK_GR;

function roundToHalfBlockGr(gr: number): number {
  return Math.round(gr / HALF_BLOCK_GR) * HALF_BLOCK_GR;
}

function ceilToHalfBlockGr(gr: number): number {
  // The epsilon stops measured sizes like 3.0000001 bl from taking an extra half block.
  return Math.ceil(gr / HALF_BLOCK_GR - 1e-6) * HALF_BLOCK_GR;
}

function spatialSizeGr(store: StoreContextModel, item: Item): Dimensions {
  // A collapsed composite renders one line high, which the generic measure can't know: it's per-item UI state.
  const sizeBl = isComposite(item)
    ? CompositeFns.calcSpatialDimensionsBl(
      CompositeFns.asCompositeMeasurable(item),
      store.perItem.getCompositeIsCollapsed(VeFns.veidFromItems(item, null)))
    : ItemFns.calcSpatialDimensionsBl(item);
  return { w: sizeBl.w * GRID_SIZE, h: sizeBl.h * GRID_SIZE };
}

function floorToHalfBlockGr(gr: number): number {
  return Math.floor(gr / HALF_BLOCK_GR + 1e-6) * HALF_BLOCK_GR;
}

/**
 * Tidied positions for the given items, or null if they are already tidy.
 *
 * Items are clustered into rows by vertical overlap, keeping their current order, then each row is top aligned and
 * laid out left to right from the selection's top-left corner with a half block gap, wrapping at the page's right
 * edge. Only positions change: widths are user intent and note heights follow their content. Every output is a
 * position a drag could snap to, and the output reproduces itself when fed back in, so the action disappears once
 * applied.
 */
function cleanUpPositionsGr(store: StoreContextModel, page: PageItem, items: Array<PositionalItem>): Map<Uid, Vector> | null {
  if (items.length < 2) { return null; }

  // Kept a half block clear of the right and bottom edges: an item ending exactly on the edge overhangs it by its
  // border, so it's drawn moved into view, with the warning hatch.
  const pageSizeGr = PageFns.calcInnerSpatialDimensionsBl(page);
  const pageWidthGr = pageSizeGr.w * GRID_SIZE - HALF_BLOCK_GR;
  const pageHeightGr = pageSizeGr.h * GRID_SIZE - HALF_BLOCK_GR;

  // Items piled on the same spot (e.g. everything dropped at 0,0) tie on position, so fall back to page order.
  const pageOrder = new Map<Uid, number>(page.computed_children.map((id, idx) => [id, idx]));
  const entries = items.map(item => ({
    item, posGr: item.spatialPositionGr, sizeGr: spatialSizeGr(store, item), order: pageOrder.get(item.id) ?? 0,
  }));
  const widestGr = Math.max(...entries.map(e => ceilToHalfBlockGr(e.sizeGr.w)));
  // Pulled left only as far as needed for the widest item to fit. This happens before wrapping, not after, because
  // a later left shift would leave room that the next run would fill, so a second clean up would move things again.
  const leftGr = Math.max(0, Math.min(
    roundToHalfBlockGr(Math.min(...entries.map(e => e.posGr.x))),
    floorToHalfBlockGr(pageWidthGr - widestGr)));
  const rightLimitGr = Math.max(pageWidthGr, leftGr + widestGr);

  entries.sort((a, b) => (a.posGr.y - b.posGr.y) || (a.posGr.x - b.posGr.x) || (a.order - b.order));
  const rows: Array<{ topGr: number, bottomGr: number, entries: typeof entries }> = [];
  for (const entry of entries) {
    const entryTopGr = entry.posGr.y;
    const entryBottomGr = entry.posGr.y + entry.sizeGr.h;
    const row = rows.length > 0 ? rows[rows.length - 1] : null;
    if (row != null) {
      // Overlap relative to the shorter of the two, so an item beside a much taller one still joins its row. Testing
      // the item's centre against the row instead splits a top aligned row when a later item is twice as tall.
      const overlapGr = Math.min(row.bottomGr, entryBottomGr) - Math.max(row.topGr, entryTopGr);
      if (overlapGr > 0 && overlapGr >= Math.min(row.bottomGr - row.topGr, entry.sizeGr.h) / 2) {
        row.entries.push(entry);
        row.bottomGr = Math.max(row.bottomGr, entryBottomGr);
        continue;
      }
    }
    rows.push({ topGr: entryTopGr, bottomGr: entryBottomGr, entries: [entry] });
  }

  // Lay out relative to a top of 0 first: the vertical position is only known once the total height is.
  const offsetsGr = new Map<Uid, Vector>();
  let yGr = 0;
  for (const row of rows) {
    row.entries.sort((a, b) => (a.posGr.x - b.posGr.x) || (a.order - b.order));
    let xGr = leftGr;
    let lineHeightGr = 0;
    for (const entry of row.entries) {
      const widthGr = ceilToHalfBlockGr(entry.sizeGr.w);
      if (xGr > leftGr && xGr + widthGr > rightLimitGr) {
        yGr += ceilToHalfBlockGr(lineHeightGr) + CLEAN_UP_GAP_GR;
        xGr = leftGr;
        lineHeightGr = 0;
      }
      offsetsGr.set(entry.item.id, { x: xGr, y: yGr });
      xGr += widthGr + CLEAN_UP_GAP_GR;
      lineHeightGr = Math.max(lineHeightGr, entry.sizeGr.h);
    }
    yGr += ceilToHalfBlockGr(lineHeightGr) + CLEAN_UP_GAP_GR;
  }
  const totalHeightGr = yGr - CLEAN_UP_GAP_GR;

  // Moved up if it would run off the bottom of the page, but never above the top. Items past the page edge are
  // drawn pinned to it, overlapping each other, which is the mess this is meant to clear up.
  const topGr = Math.max(0, Math.min(
    roundToHalfBlockGr(Math.min(...entries.map(e => e.posGr.y))),
    floorToHalfBlockGr(pageHeightGr - totalHeightGr)));

  const result = new Map<Uid, Vector>();
  let changed = false;
  for (const entry of entries) {
    const offsetGr = offsetsGr.get(entry.item.id)!;
    const posGr = { x: offsetGr.x, y: topGr + offsetGr.y };
    result.set(entry.item.id, posGr);
    if (posGr.x != entry.posGr.x || posGr.y != entry.posGr.y) { changed = true; }
  }

  return changed ? result : null;
}

function selectionKey(items: Array<Item>): string {
  return items.map(item => item.id).sort().join(",");
}

function positionsMatch(items: Array<PositionalItem>, positionsGr: Map<Uid, Vector>): boolean {
  return items.length == positionsGr.size && items.every(item => {
    const posGr = positionsGr.get(item.id);
    return posGr != null && posGr.x == item.spatialPositionGr.x && posGr.y == item.spatialPositionGr.y;
  });
}

function selectedVisualElement(veid: Veid, selectionRootPath: VisualElementPath | null): VisualElement | null {
  const candidates = VesCache.render.find(veid).map(ves => ves.get());
  if (candidates.length == 0) { return null; }

  // The same item can be rendered in more than one place (e.g. a translucent dock page also open as a popup), and
  // every rendering is selection highlighted, so anchor to the one inside the container the marquee was drawn in.
  const rootSuffix = selectionRootPath == null ? null : "-" + selectionRootPath;
  return candidates.find(ve => !!(ve.flags & VisualElementFlags.Moving)) ??
    (rootSuffix == null ? undefined : candidates.find(ve => VeFns.veToPath(ve).endsWith(rootSuffix))) ??
    candidates.find(ve => !!(ve.flags & VisualElementFlags.SelectionHighlighted)) ??
    candidates.find(ve => !(ve.flags & VisualElementFlags.Popup)) ??
    candidates[0];
}

export const SelectionGroupAction: Component = () => {
  const store = useStore();

  const selectedItems = (): Array<Item> | null => {
    if (store.anItemIsMoving.get() || store.overlay.selectionMarqueePx.get() != null) {
      return null;
    }

    const selectedVeids = store.overlay.selectedVeids.get();
    if (selectedVeids.length == 0) {
      return null;
    }

    const items: Array<Item> = [];
    const seenItemIds = new Set<Uid>();
    for (const veid of selectedVeids) {
      const itemId = treeItemIdFromVeid(veid);
      if (seenItemIds.has(itemId)) { continue; }

      const item = itemState.get(itemId);
      if (item == null) { return null; }

      seenItemIds.add(itemId);
      items.push(item);
    }

    if (items.length == 0) {
      return null;
    }

    const parentId = items[0].parentId;
    const parentItem = itemState.get(parentId);
    if (parentItem == null || !isPage(parentItem)) {
      return null;
    }
    // Rows selected in a list or table page (shift + up/down) are selected to be moved together, not grouped.
    const parentArrangeAlgorithm = asPageItem(parentItem).arrangeAlgorithm;
    if (parentArrangeAlgorithm == ArrangeAlgorithm.List || parentArrangeAlgorithm == ArrangeAlgorithm.Table) {
      return null;
    }

    for (const item of items) {
      if (item.relationshipToParent != RelationshipToParent.Child ||
        item.parentId != parentId ||
        !itemCanEdit(item)) {
        return null;
      }
    }

    return items;
  };

  const actionKind = (items: Array<Item>): SelectionGroupActionKind | null => {
    const groupIds = items.map(item => GroupFns.effectiveGroupId(item));
    const nonNullGroupIds = new Set(groupIds.filter((groupId): groupId is Uid => groupId != null));
    if (nonNullGroupIds.size == 0) {
      return items.length >= 2 ? "group" : null;
    }

    if (nonNullGroupIds.size != 1 || groupIds.some(groupId => groupId == null)) {
      return null;
    }

    const groupId = [...nonNullGroupIds][0];
    const parentItem = itemState.get(items[0].parentId);
    if (parentItem == null || !isPage(parentItem)) {
      return null;
    }

    const selectedItemIds = new Set(items.map(item => item.id));
    const groupMemberIds = GroupFns.memberIds(parentItem.id, groupId);
    if (groupMemberIds.length != selectedItemIds.size) {
      return null;
    }
    if (groupMemberIds.some(childId => !selectedItemIds.has(childId))) {
      return null;
    }

    return "ungroup";
  };

  const [cleanUpUndo, setCleanUpUndo] = createSignal<CleanUpUndo | null>(null);

  // Undo is offered until the selection changes, then the pre clean up positions are forgotten.
  const currentSelectionKey = createMemo(() => {
    const items = selectedItems();
    return items == null ? null : selectionKey(items);
  });
  createEffect(on(currentSelectionKey, () => setCleanUpUndo(null), { defer: true }));

  const actionInfo = createMemo<SelectionGroupActionInfo | null>(() => {
    const items = selectedItems();
    if (items == null) {
      return null;
    }

    const groupKind = actionKind(items);
    // Only free-form pages have positions to tidy: other arrangements compute them.
    const parentPage = asPageItem(itemState.get(items[0].parentId)!);
    const positionalItems = parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch && items.every(isPositionalItem)
      ? items.map(asPositionalItem)
      : null;
    const undo = cleanUpUndo();
    const undoAvailable = positionalItems != null && undo != null &&
      undo.selectionKey == selectionKey(items) &&
      positionsMatch(positionalItems, undo.afterGr);
    const positionsGr = undoAvailable || positionalItems == null ? null : cleanUpPositionsGr(store, parentPage, positionalItems);
    const cleanUpKind: SelectionCleanUpActionKind | null =
      undoAvailable ? "undo" : (positionsGr != null ? "clean up" : null);
    if (groupKind == null && cleanUpKind == null) {
      return null;
    }

    const selectionRootPath = store.overlay.selectionRootPath.get();
    const boundsPx = unionBounds(store.overlay.selectedVeids.get()
      .map(veid => selectedVisualElement(veid, selectionRootPath))
      .filter((ve): ve is VisualElement => ve != null)
      .map(ve => VeFns.veBoundsRelativeToDesktopPx(store, ve)));
    if (boundsPx == null) {
      return null;
    }

    return { groupKind, cleanUpKind, cleanUpPositionsGr: positionsGr, items, positionalItems, boundsPx };
  });

  const labels = (): Array<string> => {
    const info = actionInfo();
    if (info == null) { return []; }
    const result: Array<string> = [];
    if (info.cleanUpKind != null) { result.push(info.cleanUpKind); }
    if (info.groupKind != null) { result.push(info.groupKind); }
    return result;
  };

  const containerStyle = () => {
    const info = actionInfo()!;
    const widthPx = labels().reduce((acc, label) => acc + approxActionWidthPx(label), 0) +
      ACTION_GAP_PX * (labels().length - 1);
    const desktopBoundsPx = store.desktopBoundsPx();
    const maxX = Math.max(ACTION_MARGIN_PX, desktopBoundsPx.w - widthPx - ACTION_MARGIN_PX);
    const maxY = Math.max(ACTION_MARGIN_PX, desktopBoundsPx.h - ACTION_HEIGHT_PX - ACTION_MARGIN_PX);
    const x = clamp(info.boundsPx.x + info.boundsPx.w - widthPx - 10, ACTION_MARGIN_PX, maxX);
    const y = clamp(info.boundsPx.y - Math.round(ACTION_HEIGHT_PX / 2), ACTION_MARGIN_PX, maxY);

    return `left: ${x}px; top: ${y}px; ` +
      `height: ${ACTION_HEIGHT_PX}px; ` +
      `gap: ${ACTION_GAP_PX}px; ` +
      `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`;
  };

  const buttonStyle = (label: string) => {
    return `width: ${approxActionWidthPx(label)}px; height: ${ACTION_HEIGHT_PX}px; ` +
      `font-size: ${ACTION_FONT_SIZE_PX}px; ` +
      `line-height: ${ACTION_HEIGHT_PX}px; ` +
      `letter-spacing: 0.01em; ` +
      `color: rgba(57, 81, 118, 0.72); ` +
      `background: rgba(255, 255, 255, 0.96); ` +
      `border: 1px solid ${LIGHT_BORDER_COLOR}; ` +
      `border-radius: 5px; ` +
      `box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);`;
  };

  const stopMouseEvent = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const applyPositions = (items: Array<PositionalItem>, positionsGr: Map<Uid, Vector>) => {
    for (const item of items) {
      const posGr = positionsGr.get(item.id);
      if (posGr == null) { continue; }
      if (posGr.x == item.spatialPositionGr.x && posGr.y == item.spatialPositionGr.y) { continue; }
      item.spatialPositionGr = { x: posGr.x, y: posGr.y };
      void serverOrRemote.updateItem(item);
    }
  };

  const applyAction = (ev: MouseEvent, label: string) => {
    stopMouseEvent(ev);

    const info = actionInfo();
    if (info == null) { return; }

    if (label == "clean up") {
      if (info.cleanUpPositionsGr == null || info.positionalItems == null) { return; }
      const beforeGr = new Map<Uid, Vector>();
      for (const item of info.positionalItems) {
        beforeGr.set(item.id, { x: item.spatialPositionGr.x, y: item.spatialPositionGr.y });
      }
      applyPositions(info.positionalItems, info.cleanUpPositionsGr);
      setCleanUpUndo({ selectionKey: selectionKey(info.items), beforeGr, afterGr: info.cleanUpPositionsGr });
    } else if (label == "undo") {
      const undo = cleanUpUndo();
      if (undo == null || info.positionalItems == null) { return; }
      applyPositions(info.positionalItems, undo.beforeGr);
      setCleanUpUndo(null);
    } else {
      const groupId = label == "group" ? newUid() : null;
      for (const item of info.items) {
        item.groupId = groupId;
        void serverOrRemote.updateItem(item);
      }
    }

    store.overlay.selectedVeids.set([...store.overlay.selectedVeids.get()]);
    arrangeNow(store, "selection-group-action");
  };

  return (
    <Show when={actionInfo() != null}>
      <div class="absolute flex" style={containerStyle()}>
        <For each={labels()}>{label =>
          <button type="button"
            class="flex items-center justify-center font-semibold select-none cursor-pointer"
            style={buttonStyle(label)}
            onMouseDown={stopMouseEvent}
            onMouseUp={stopMouseEvent}
            onClick={ev => applyAction(ev, label)}>
            {label}
          </button>
        }</For>
      </div>
    </Show>
  );
};
