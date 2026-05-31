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

import { Component, Show, createMemo } from "solid-js";

import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { asContainerItem } from "../../items/base/container-item";
import { Item } from "../../items/base/item";
import { isPage } from "../../items/page-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, Veid, VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { serverOrRemote } from "../../server";
import { useStore } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { LIGHT_BORDER_COLOR } from "../../style";
import { BoundingBox } from "../../util/geometry";
import { Uid, newUid } from "../../util/uid";
import { arrangeNow } from "../../layout/arrange";


type SelectionGroupActionKind = "group" | "ungroup";

interface SelectionGroupActionInfo {
  kind: SelectionGroupActionKind;
  items: Array<Item>;
  boundsPx: BoundingBox;
}

const ACTION_HEIGHT_PX = 19;
const ACTION_MARGIN_PX = 6;
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

function selectedVisualElement(veid: Veid): VisualElement | null {
  const candidates = VesCache.current.findNodes(veid);
  if (candidates.length == 0) { return null; }

  return candidates.find(ve => !!(ve.flags & VisualElementFlags.SelectionHighlighted)) ??
    candidates.find(ve => !(ve.flags & VisualElementFlags.Popup)) ??
    candidates[0];
}

export const SelectionGroupAction: Component = () => {
  const store = useStore();

  const selectedItems = (): Array<Item> | null => {
    if (store.overlay.selectionMarqueePx.get() != null) {
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
    const nonNullGroupIds = new Set(items.map(item => item.groupId).filter((groupId): groupId is Uid => groupId != null));
    if (nonNullGroupIds.size == 0) {
      return items.length >= 2 ? "group" : null;
    }

    if (nonNullGroupIds.size != 1 || items.some(item => item.groupId == null)) {
      return null;
    }

    const groupId = [...nonNullGroupIds][0];
    const parentItem = itemState.get(items[0].parentId);
    if (parentItem == null || !isPage(parentItem)) {
      return null;
    }

    const selectedItemIds = new Set(items.map(item => item.id));
    const groupMemberIds = asContainerItem(parentItem).computed_children.filter(childId => itemState.get(childId)?.groupId == groupId);
    if (groupMemberIds.length != selectedItemIds.size) {
      return null;
    }
    if (groupMemberIds.some(childId => !selectedItemIds.has(childId))) {
      return null;
    }

    return "ungroup";
  };

  const actionInfo = createMemo<SelectionGroupActionInfo | null>(() => {
    const items = selectedItems();
    if (items == null) {
      return null;
    }

    const kind = actionKind(items);
    if (kind == null) {
      return null;
    }

    const boundsPx = unionBounds(store.overlay.selectedVeids.get()
      .map(selectedVisualElement)
      .filter((ve): ve is VisualElement => ve != null)
      .map(ve => VeFns.veBoundsRelativeToDesktopPx(store, ve)));
    if (boundsPx == null) {
      return null;
    }

    return { kind, items, boundsPx };
  });

  const label = () => actionInfo()?.kind ?? "";

  const buttonStyle = () => {
    const info = actionInfo()!;
    const widthPx = approxActionWidthPx(label());
    const desktopBoundsPx = store.desktopBoundsPx();
    const maxX = Math.max(ACTION_MARGIN_PX, desktopBoundsPx.w - widthPx - ACTION_MARGIN_PX);
    const maxY = Math.max(ACTION_MARGIN_PX, desktopBoundsPx.h - ACTION_HEIGHT_PX - ACTION_MARGIN_PX);
    const x = clamp(info.boundsPx.x + info.boundsPx.w - widthPx - 10, ACTION_MARGIN_PX, maxX);
    const y = clamp(info.boundsPx.y - Math.round(ACTION_HEIGHT_PX / 2), ACTION_MARGIN_PX, maxY);

    return `left: ${x}px; top: ${y}px; ` +
      `width: ${widthPx}px; height: ${ACTION_HEIGHT_PX}px; ` +
      `font-size: ${ACTION_FONT_SIZE_PX}px; ` +
      `line-height: ${ACTION_HEIGHT_PX}px; ` +
      `letter-spacing: 0.01em; ` +
      `color: rgba(57, 81, 118, 0.72); ` +
      `background: rgba(255, 255, 255, 0.96); ` +
      `border: 1px solid ${LIGHT_BORDER_COLOR}; ` +
      `border-radius: 5px; ` +
      `box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); ` +
      `z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY};`;
  };

  const stopMouseEvent = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  const applyAction = (ev: MouseEvent) => {
    stopMouseEvent(ev);

    const info = actionInfo();
    if (info == null) { return; }

    const groupId = info.kind == "group" ? newUid() : null;
    for (const item of info.items) {
      item.groupId = groupId;
      void serverOrRemote.updateItem(item, store.general.networkStatus);
    }

    store.overlay.selectedVeids.set([...store.overlay.selectedVeids.get()]);
    arrangeNow(store, "selection-group-action");
  };

  return (
    <Show when={actionInfo() != null}>
      <button type="button"
        class="absolute flex items-center justify-center font-semibold select-none cursor-pointer"
        style={buttonStyle()}
        onMouseDown={stopMouseEvent}
        onMouseUp={stopMouseEvent}
        onClick={applyAction}>
        {label()}
      </button>
    </Show>
  );
};
