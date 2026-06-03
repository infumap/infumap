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

import { Component, For, Show } from "solid-js";
import { Z_INDEX_GLOBAL_MOVING } from "../constants";
import { MouseAction, MouseActionState } from "../input/state";
import { isPage } from "../items/page-item";
import { isTable } from "../items/table-item";
import { VesCache } from "../layout/ves-cache";
import { isVeTranslucentPage, VeFns, Veid, VisualElement, VisualElementFlags } from "../layout/visual-element";
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
  if (activeVisualElement && movingOverlayShouldYieldToTranslucentPage(activeVisualElement)) {
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

export const MovingItemsOverlay: Component = () => {
  const store = useStore();

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
      </div>
    </Show>
  );
}
