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

import { MouseAction, MouseActionState } from "../../input/state";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";
import { ItemGeometry } from "../item-geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { arrangeCellPopup } from "./popup";
import createJustifiedLayout from "justified-layout";


export function arrange_justified_page(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    realParentVeid: Veid | null,
    displayItem_pageWithChildren: PageItem,
    linkItemMaybe_pageWithChildren: LinkItem | null,
    geometry: ItemGeometry,
    flags :ArrangeItemFlags): VisualElementSpec {

  let pageWithChildrenVisualElementSpec: VisualElementSpec;

  const pageWithChildrenVeid = VeFns.veidFromItems(displayItem_pageWithChildren, linkItemMaybe_pageWithChildren);
  const pageWithChildrenVePath = VeFns.addVeidToPath(pageWithChildrenVeid, parentPath);

  const outerBoundsPx = geometry.boundsPx;
  const hitboxes = geometry.hitboxes;

  const parentIsPopup = flags & ArrangeItemFlags.IsPopup;
      
  let movingItem = null;
  if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
    movingItem = VeFns.canonicalItemFromPath(MouseActionState.get().activeElement);
  }

  // if an item is moving out of or in a grid page, then ensure the height of the grid page doesn't
  // change until after the move is complete to avoid a very distruptive jump in y scroll px.
  let nItemAdj = 0;
  if (movingItem && !MouseActionState.get().linkCreatedOnMoveStart) {
    const startParentVes = VesCache.get(MouseActionState.get().startActiveElementParent)!;
    const startParent = startParentVes.get().displayItem;
    if (startParent.id == displayItem_pageWithChildren.id && movingItem!.parentId != startParent.id) {
      nItemAdj = 1;
    }
  }

  let dims = [];
  let items = [];
  for (let i=0; i<displayItem_pageWithChildren.computed_children.length; ++i) {
    const item = itemState.get(displayItem_pageWithChildren.computed_children[i])!;
    if (movingItem && item.id == movingItem!.id) {
      continue;
    }
    let dimensions = ItemFns.calcSpatialDimensionsBl(item);
    dims.push({ width: dimensions.w, height: dimensions.h });
    items.push(item);
  }

  const layout = createJustifiedLayout(dims, createJustifyOptions(geometry.boundsPx.w, displayItem_pageWithChildren.justifiedRowAspect));
  if (layout.boxes.length != items.length) {
    panic(`incorrect number of boxes for items: ${layout.boxes.length} vs ${items.length}.`);
  }

  const childAreaBoundsPx = cloneBoundingBox(geometry.boundsPx)!;
  childAreaBoundsPx.h = layout.containerHeight;

  pageWithChildrenVisualElementSpec = {
    displayItem: displayItem_pageWithChildren,
    linkItemMaybe: linkItemMaybe_pageWithChildren,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren |
           (flags & ArrangeItemFlags.IsPopup ? VisualElementFlags.Popup : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsPopup && store.getToolbarFocus()!.itemId ==  pageWithChildrenVeid.itemId ? VisualElementFlags.HasToolbarFocus : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsRoot ? VisualElementFlags.Root : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
           (flags & ArrangeItemFlags.IsListPageMainItem ? VisualElementFlags.ListPageRootItem : VisualElementFlags.None),
    boundsPx: outerBoundsPx,
    childAreaBoundsPx,
    hitboxes,
    parentPath,
  };

  const childrenVes = [];

  for (let i=0; i<items.length; ++i) {
    const item = items[i];
    const cellBoundsPx = {
      x: layout.boxes[i].left,
      y: layout.boxes[i].top,
      w: layout.boxes[i].width,
      h: layout.boxes[i].height
    };

    const geometry = ItemFns.calcGeometry_InCell(item, cellBoundsPx, false, false, false, false, true);
    const ves = arrangeItem(
      store, pageWithChildrenVePath, pageWithChildrenVeid, ArrangeAlgorithm.Justified, item, geometry,
      ArrangeItemFlags.RenderChildrenAsFull);
    childrenVes.push(ves);
  }

  pageWithChildrenVisualElementSpec.childrenVes = childrenVes;

  if (flags & ArrangeItemFlags.IsRoot && !(flags & ArrangeItemFlags.IsPopup)) {
    const currentPopupSpec = store.history.currentPopupSpec();
    if (currentPopupSpec != null) {
      pageWithChildrenVisualElementSpec.popupVes = arrangeCellPopup(store, realParentVeid);
    }
  }

  return pageWithChildrenVisualElementSpec;
}

function createJustifyOptions(widthPx: number, rowAspect: number) {
  const NORMAL_ROW_HEIGHT = 200;
  const targetRowHeight = widthPx / rowAspect;
  const options: JustifiedLayoutOptions = {
    containerWidth: widthPx,
    containerPadding: 10 * targetRowHeight / 200,
    boxSpacing: 5 * targetRowHeight / 200,
    targetRowHeight,
  };
  return options;
}

/**
 * Options for configuring the justified layout.
 */
interface JustifiedLayoutOptions {
  /**
   * The width that boxes will be contained within irrelevant of padding.
   * @default 1060
   */
  containerWidth?: number | undefined;
  /**
   * Provide a single integer to apply padding to all sides or provide an object to apply
   * individual values to each side.
   * @default 10
   */
  containerPadding?: number | { top: number; right: number; left: number; bottom: number } | undefined;
  /**
   * Provide a single integer to apply spacing both horizontally and vertically or provide an
   * object to apply individual values to each axis.
   * @default 10
   */
  boxSpacing?: number | { horizontal: number; vertical: number } | undefined;
  /**
   * It's called a target because row height is the lever we use in order to fit everything in
   * nicely. The algorithm will get as close to the target row height as it can.
   * @default 320
   */
  targetRowHeight?: number | undefined;
  /**
   * How far row heights can stray from targetRowHeight. `0` would force rows to be the
   * `targetRowHeight` exactly and would likely make it impossible to justify. The value must
   * be between `0` and `1`.
   * @default 0.25
   */
  targetRowHeightTolerance?: number | undefined;
  /**
   * Will stop adding rows at this number regardless of how many items still need to be laid
   * out.
   * @default Number.POSITIVE_INFINITY
   */
  maxNumRows?: number | undefined;
  /**
   * Provide an aspect ratio here to return everything in that aspect ratio. Makes the values
   * in your input array irrelevant. The length of the array remains relevant.
   * @default false
   */
  forceAspectRatio?: boolean | number | undefined;
  /**
   * If you'd like to insert a full width box every n rows you can specify it with this
   * parameter. The box on that row will ignore the targetRowHeight, make itself as wide as
   * `containerWidth - containerPadding` and be as tall as its aspect ratio defines. It'll
   * only happen if that item has an aspect ratio >= 1. Best to have a look at the examples to
   * see what this does.
   * @default false
   */
  fullWidthBreakoutRowCadence?: boolean | number | undefined;
  /**
   * By default we'll return items at the end of a justified layout even if they don't make a
   * full row. If false they'll be omitted from the output.
   * @default true
   */
  showWidows?: boolean | undefined;
  /**
   * If widows are visible, how should they be laid out?
   * @default "left"
   */
  widowLayoutStyle?: "left" | "justify" | "center" | undefined;
}
