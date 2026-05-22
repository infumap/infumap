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

import { GRID_SIZE } from "../constants";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { PageFns, asPageItem, isPage } from "../items/page-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VeFns, Veid, VisualElement } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { Dimensions, Vector, vectorSubtract } from "../util/geometry";
import { panic } from "../util/lang";

export interface GroupMoveItem {
  veid: Veid,
  startPosGr: Vector,
  parentId: string,
}

type GroupMoveEntry = {
  entry: GroupMoveItem,
  item: PositionalItem,
}

function veidsMatch(a: Veid, b: Veid): boolean {
  return a.itemId === b.itemId && a.linkIdMaybe === b.linkIdMaybe;
}

export function movingHitIgnoreIds(
  activeVisualElement: VisualElement,
  group: Array<GroupMoveItem> | null | undefined,
): Array<string> {
  const ignoreIds: Array<string> = [];
  const addIgnoreId = (id: string | null | undefined) => {
    if (id != null && !ignoreIds.includes(id)) {
      ignoreIds.push(id);
    }
  };
  const addCompositeChildrenIgnoreIds = (itemId: string | null | undefined) => {
    if (itemId == null) { return; }
    const item = itemState.get(itemId);
    if (item == null || !isComposite(item)) { return; }
    const compositeItem = asCompositeItem(item);
    for (let childId of compositeItem.computed_children) {
      addIgnoreId(childId);
      const child = itemState.get(childId);
      if (child != null && isLink(child)) {
        addIgnoreId(LinkFns.getLinkToId(asLinkItem(child)));
      }
    }
  };

  addIgnoreId(activeVisualElement.displayItem.id);
  addIgnoreId(activeVisualElement.linkItemMaybe?.id);
  addIgnoreId(activeVisualElement.actualLinkItemMaybe?.id);
  addCompositeChildrenIgnoreIds(activeVisualElement.displayItem.id);

  for (const entry of group ?? []) {
    addIgnoreId(entry.veid.itemId);
    addIgnoreId(entry.veid.linkIdMaybe);
    addCompositeChildrenIgnoreIds(entry.veid.itemId);
  }

  return ignoreIds;
}

export function calculateMoveToPagePositionGr(
  store: StoreContextModel,
  moveToVe: VisualElement,
  desktopPx: Vector,
  activeItem: PositionalItem,
  relationshipToParent: string,
  clickOffsetProp: Vector | null,
): { activePosGr: Vector, startPosBl: Vector, moveToPageInnerSizeBl: Dimensions } {
  if (!isPage(moveToVe.displayItem)) {
    panic(`calculateMoveToPagePositionGr: target is not a page (${moveToVe.displayItem.itemType}).`);
  }

  const moveToPage = asPageItem(moveToVe.displayItem);
  const moveToPageInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(moveToPage);
  const mousePointGr = VeFns.desktopPxToPageGr(store, moveToVe, desktopPx);
  const mousePointBl = (() => {
    if (mousePointGr != null) {
      return {
        x: Math.round((mousePointGr.x / GRID_SIZE) * 2.0) / 2.0,
        y: Math.round((mousePointGr.y / GRID_SIZE) * 2.0) / 2.0,
      };
    }

    const pagePx = VeFns.desktopPxToTopLevelPagePx(store, desktopPx);
    const moveToPageAbsoluteBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, moveToVe);
    return {
      x: Math.round((pagePx.x - moveToPageAbsoluteBoundsPx.x) / moveToPageAbsoluteBoundsPx.w * moveToPageInnerSizeBl.w * 2.0) / 2.0,
      y: Math.round((pagePx.y - moveToPageAbsoluteBoundsPx.y) / moveToPageAbsoluteBoundsPx.h * moveToPageInnerSizeBl.h * 2.0) / 2.0,
    };
  })();

  const activeItemDimensionsBl = ItemFns.calcSpatialDimensionsBl(activeItem);
  const clickOffsetInActiveItemBl = relationshipToParent == RelationshipToParent.Child && clickOffsetProp != null
    ? {
      x: Math.round(activeItemDimensionsBl.w * clickOffsetProp.x * 2.0) / 2.0,
      y: Math.round(activeItemDimensionsBl.h * clickOffsetProp.y * 2.0) / 2.0,
    }
    : { x: 0, y: 0 };

  const startPosBl = vectorSubtract(mousePointBl, clickOffsetInActiveItemBl);
  return {
    activePosGr: { x: startPosBl.x * GRID_SIZE, y: startPosBl.y * GRID_SIZE },
    startPosBl,
    moveToPageInnerSizeBl,
  };
}

export function getGroupMoveEntriesInParent(
  group: Array<GroupMoveItem> | null | undefined,
  sourceParentId: string,
): Array<GroupMoveEntry> {
  if (!group || group.length == 0) { return []; }

  const result: Array<GroupMoveEntry> = [];
  for (const entry of group) {
    const itemId = entry.veid.linkIdMaybe ? entry.veid.linkIdMaybe : entry.veid.itemId;
    const itemMaybe = itemState.get(itemId);
    if (!itemMaybe || !isPositionalItem(itemMaybe)) { continue; }
    const item = asPositionalItem(itemMaybe);
    if (item.parentId != sourceParentId) { continue; }
    result.push({ entry, item });
  }
  return result;
}

export function moveGroupToChildParentPreservingOffsets(
  group: Array<GroupMoveItem> | null | undefined,
  activeVeid: Veid,
  sourceParentId: string,
  targetParentId: string,
  activePosGr: Vector,
): Array<string> {
  const groupEntries = getGroupMoveEntriesInParent(group, sourceParentId);
  if (groupEntries.length == 0) { return []; }

  const activeEntry = groupEntries.find(({ entry }) => veidsMatch(entry.veid, activeVeid))?.entry;
  if (!activeEntry) { return []; }

  const deltaFromStart = {
    x: activePosGr.x - activeEntry.startPosGr.x,
    y: activePosGr.y - activeEntry.startPosGr.y,
  };

  const movedIds: Array<string> = [];
  for (const { entry, item } of groupEntries) {
    item.spatialPositionGr = {
      x: entry.startPosGr.x + deltaFromStart.x,
      y: entry.startPosGr.y + deltaFromStart.y,
    };
    itemState.moveToNewParent(item, targetParentId, RelationshipToParent.Child);
    movedIds.push(item.id);
  }
  return movedIds;
}
