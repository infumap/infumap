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

import { Component, createMemo, For, Show } from "solid-js";
import { Z_INDEX_GLOBAL_MOVING } from "../constants";
import { groupMoveStackWindow, orderedGroupMoveItems } from "../input/move_group";
import { MouseAction, MouseActionState } from "../input/state";
import { isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { VesCache } from "../layout/ves-cache";
import { isTableView, isVeTranslucentPage, VeFns, Veid, VisualElement, VisualElementFlags } from "../layout/visual-element";
import { StoreContextModel, useStore } from "../store/StoreProvider";
import { BoundingBox } from "../util/geometry";
import { VisualElement_Desktop, VisualElement_LineItem } from "./VisualElement";


function movingOverlayBoundsPx(store: StoreContextModel, visualElement: VisualElement): BoundingBox {
  if (!(visualElement.flags & VisualElementFlags.LineItem) && isPage(visualElement.displayItem) && visualElement.viewportBoundsPx) {
    const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, visualElement);
    return {
      x: viewportBoundsPx.x - (visualElement.viewportBoundsPx.x - visualElement.boundsPx.x),
      y: viewportBoundsPx.y - (visualElement.viewportBoundsPx.y - visualElement.boundsPx.y),
      w: visualElement.boundsPx.w,
      h: visualElement.boundsPx.h,
    };
  }

  return VeFns.veBoundsRelativeToDesktopPx(store, visualElement);
}

function movingOverlayViewportBoundsPx(visualElement: VisualElement, overlayBoundsPx: BoundingBox): BoundingBox | null {
  if (!isTable(visualElement.displayItem) || visualElement.viewportBoundsPx == null) {
    return visualElement.viewportBoundsPx;
  }

  return {
    ...visualElement.viewportBoundsPx,
    x: overlayBoundsPx.x + (visualElement.viewportBoundsPx.x - visualElement.boundsPx.x),
    y: overlayBoundsPx.y + (visualElement.viewportBoundsPx.y - visualElement.boundsPx.y),
  };
}

function movingOverlayVe(store: StoreContextModel, visualElement: VisualElement): VisualElement {
  const boundsPx = movingOverlayBoundsPx(store, visualElement);
  return {
    ...visualElement,
    flags: visualElement.flags & ~VisualElementFlags.Fixed,
    boundsPx,
    viewportBoundsPx: movingOverlayViewportBoundsPx(visualElement, boundsPx),
  };
}

function movingOverlayShouldYieldToTranslucentPage(visualElement: VisualElement): boolean {
  if (!visualElement.parentPath) { return false; }

  const parentVisualElementSignal = VesCache.render.getNode(visualElement.parentPath);
  const parentVisualElement = parentVisualElementSignal?.get() ??
    VesCache.current.readNode(visualElement.parentPath) ??
    null;
  if (parentVisualElement == null || !isVeTranslucentPage(parentVisualElement)) {
    return false;
  }

  VesCache.render.getChildren(visualElement.parentPath)();
  return true;
}

/** Table pages render their moving item themselves (Page_TableContent), like translucent pages. */
function movingOverlayShouldYieldToTablePage(visualElement: VisualElement): boolean {
  if (!visualElement.parentPath) { return false; }
  const parentVisualElement = VesCache.render.getNode(visualElement.parentPath)?.get() ??
    VesCache.current.readNode(visualElement.parentPath) ??
    null;
  return parentVisualElement != null &&
    isPage(parentVisualElement.displayItem) &&
    isTableView(parentVisualElement);
}

function movingOverlayPath(visualElement: VisualElement): string {
  return VeFns.veToPath(visualElement);
}

function movingOverlayVeidKey(veid: Veid): string {
  return `${veid.itemId}/${veid.linkIdMaybe ?? ""}`;
}

function addMovingOverlayVisualElementsForVeid(
  store: StoreContextModel,
  veid: Veid,
  movingElements: Array<VisualElement>,
  seenPaths: Set<string>,
): void {
  for (const visualElementSignal of VesCache.render.find(veid)) {
    const visualElement = visualElementSignal.get();
    if (!(visualElement.flags & VisualElementFlags.Moving)) { continue; }

    const path = movingOverlayPath(visualElement);
    if (seenPaths.has(path)) { continue; }

    seenPaths.add(path);
    movingElements.push(movingOverlayVe(store, visualElement));
  }
}

function movingOverlayVisualElements(store: StoreContextModel): Array<VisualElement> {
  if (!store.anItemIsMoving.get() || !MouseActionState.isAction(MouseAction.Moving)) {
    return [];
  }

  const movingElements: Array<VisualElement> = [];
  const seenPaths = new Set<string>();
  const seenVeids = new Set<string>();

  const activeVisualElement = MouseActionState.getActiveVisualElement();
  if (activeVisualElement &&
    (movingOverlayShouldYieldToTranslucentPage(activeVisualElement) || movingOverlayShouldYieldToTablePage(activeVisualElement))) {
    return [];
  }

  if (activeVisualElement) {
    seenPaths.add(movingOverlayPath(activeVisualElement));
    movingElements.push(movingOverlayVe(store, activeVisualElement));
  }

  if (activeVisualElement) {
    seenVeids.add(movingOverlayVeidKey(VeFns.veidFromVe(activeVisualElement)));
  }

  const groupMoveItems = MouseActionState.getGroupMoveItems() ?? [];
  for (const groupMoveItem of groupMoveItems) {
    const veidKey = movingOverlayVeidKey(groupMoveItem.veid);
    if (seenVeids.has(veidKey)) { continue; }

    seenVeids.add(veidKey);
    addMovingOverlayVisualElementsForVeid(store, groupMoveItem.veid, movingElements, seenPaths);
  }

  return movingElements;
}

/**
 * Over a list page or the dock, at most GROUP_MOVE_STACK_MAX_ITEMS of a group move are drawn, stacked under the cursor
 * (see groupMoveStackWindow), and by the page itself rather than here. This is where the badge counting the rest goes:
 * the bottom right of the stack.
 */
function movingOverlayStackBadgeMaybe(store: StoreContextModel): { x: number, y: number, hiddenCount: number } | null {
  if (!store.anItemIsMoving.get()) { return null; }
  const activeElementPath = MouseActionState.getActiveElementPath();
  if (activeElementPath == null) { return null; }
  // Reading the parent's children re-runs this as they are arranged, including when the moving items move to another
  // parent, which mouse action state alone would not.
  const parentPath = VeFns.parentPath(activeElementPath);
  const stackVes = VesCache.render.getChildren(parentPath)()
    .map(veSignal => veSignal.get())
    .filter(ve => !!(ve.flags & VisualElementFlags.Moving));
  const parentVisualElement = VesCache.render.getNode(parentPath)?.get() ?? VesCache.current.readNode(parentPath) ?? null;
  // listViewportBoundsPx is set for exactly the list pages.
  if (stackVes.length == 0 || parentVisualElement == null ||
    !((parentVisualElement.flags & VisualElementFlags.IsDock) || parentVisualElement.listViewportBoundsPx != null)) {
    return null;
  }

  const activeItem = VeFns.treeItemFromPath(activeElementPath);
  if (activeItem == null) { return null; }
  const { hiddenCount } = groupMoveStackWindow(orderedGroupMoveItems(activeItem), activeItem.id);
  if (hiddenCount == 0) { return null; }
  const stackBoundsPx = stackVes.map(ve => movingOverlayBoundsPx(store, ve));
  return {
    x: Math.max(...stackBoundsPx.map(boundsPx => boundsPx.x + boundsPx.w)),
    y: Math.max(...stackBoundsPx.map(boundsPx => boundsPx.y + boundsPx.h)),
    hiddenCount,
  };
}

export const MovingItemsOverlay: Component = () => {
  const store = useStore();
  const stackBadge = createMemo(() => movingOverlayStackBadgeMaybe(store));

  return (
    <Show when={store.anItemIsMoving.get()}>
      <div class="absolute left-0 top-0 right-0 bottom-0 pointer-events-none"
        style={`overflow: visible; z-index: ${Z_INDEX_GLOBAL_MOVING};`}>
        <For each={movingOverlayVisualElements(store)}>{visualElement =>
          <Show
            when={visualElement.flags & VisualElementFlags.LineItem}
            fallback={<VisualElement_Desktop visualElement={visualElement} />}>
            <VisualElement_LineItem visualElement={visualElement} />
          </Show>
        }</For>
        <Show when={stackBadge()}>{badge =>
          <div class="absolute rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 shadow-sm whitespace-nowrap"
            style={`left: ${badge().x}px; top: ${badge().y}px; transform: translate(-50%, -50%);`}>
            +{badge().hiddenCount}
          </div>
        }</Show>
      </div>
    </Show>
  );
}
