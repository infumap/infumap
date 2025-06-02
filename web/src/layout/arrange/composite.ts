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

import { CHILD_ITEMS_VISIBLE_WIDTH_BL, COMPOSITE_ITEM_GAP_BL, GRID_SIZE } from "../../constants";
import { asAttachmentsItem, isAttachmentsItem } from "../../items/base/attachments-item";
import { Item } from "../../items/base/item";
import { ItemFns } from "../../items/base/item-polymorphism";
import { CompositeItem } from "../../items/composite-item";
import { isExpression } from "../../items/expression-item";
import { isImage } from "../../items/image-item";
import { LinkItem } from "../../items/link-item";
import { asPageItem, isPage } from "../../items/page-item";
import { asTableItem, isTable } from "../../items/table-item";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { Dimensions, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { ItemGeometry } from "../item-geometry";
import { initiateLoadChildItemsMaybe } from "../load";
import { VesCache } from "../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { arrangeItemAttachments } from "./attachments";
import { ArrangeItemFlags } from "./item";
import { arrangePageWithChildren } from "./page";
import { arrangeTable } from "./table";
import { getVePropertiesForItem } from "./util";


export const arrangeComposite = (
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_Composite: CompositeItem,
    linkItemMaybe_Composite: LinkItem | null,
    actualLinkItemMaybe_Composite: LinkItem | null,
    compositeGeometry: ItemGeometry,
    flags: ArrangeItemFlags): VisualElementSignal => {

  const compositeVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_Composite, linkItemMaybe_Composite), parentPath);

  let viewportBoundsPx = {
    x: compositeGeometry.boundsPx.x, y: compositeGeometry.boundsPx.y,
    w: compositeGeometry.boundsPx.w, h: compositeGeometry.boundsPx.h
  };
  let childAreaBoundsPx = zeroBoundingBoxTopLeft(viewportBoundsPx);

  const compositeVisualElementSpec: VisualElementSpec = {
    displayItem: displayItem_Composite,
    linkItemMaybe: linkItemMaybe_Composite,
    actualLinkItemMaybe: actualLinkItemMaybe_Composite,
    flags: VisualElementFlags.Detailed |
          (flags & ArrangeItemFlags.IsPopupRoot ? VisualElementFlags.Popup : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsMoving ? VisualElementFlags.Moving : VisualElementFlags.None) |
          (flags & ArrangeItemFlags.IsListPageMainRoot ? VisualElementFlags.ListPageRoot : VisualElementFlags.None),
    _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
    boundsPx: compositeGeometry.boundsPx,
    childAreaBoundsPx,
    viewportBoundsPx,
    hitboxes: compositeGeometry.hitboxes,
    parentPath,
  };

  const compositeSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_Composite ? linkItemMaybe_Composite : displayItem_Composite);
  const blockSizePx = { w: compositeGeometry.boundsPx.w / compositeSizeBl.w, h: compositeGeometry.boundsPx.h / compositeSizeBl.h };

  let compositeVeChildren: Array<VisualElementSignal> = [];
  let topPx = 0.0;
  for (let idx=0; idx<displayItem_Composite.computed_children.length; ++idx) {
    const childId = displayItem_Composite.computed_children[idx];
    const childItem = itemState.get(childId)!;

    const { displayItem: displayItem_childItem, linkItemMaybe: linkItemMaybe_childItem } = getVePropertiesForItem(store, childItem);

    const geometry = ItemFns.calcGeometry_InComposite(
      linkItemMaybe_childItem ? linkItemMaybe_childItem : displayItem_childItem,
      blockSizePx,
      compositeSizeBl.w,
      0,
      topPx,
      store.smallScreenMode());

    topPx += geometry.boundsPx.h + COMPOSITE_ITEM_GAP_BL * blockSizePx.h;

    const compositeChildVeSignal = arrangeCompositeChildItem(
      store, compositeVePath,
      displayItem_childItem, linkItemMaybe_childItem,
      geometry, idx, blockSizePx, compositeSizeBl.w);

    compositeVeChildren.push(compositeChildVeSignal);
  }

  compositeVisualElementSpec.childrenVes = compositeVeChildren;

  const compositeVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(compositeVisualElementSpec, compositeVePath);

  return compositeVisualElementSignal;
}

function arrangeCompositeChildItem(
    store: StoreContextModel,
    parentPath: VisualElementPath,
    displayItem_childItem: Item,
    linkItemMaybe_childItem: LinkItem | null,
    geometry: ItemGeometry,
    idx: number,
    blockSizePx: Dimensions,
    compositeWidthBl: number): VisualElementSignal {

  if (isTable(displayItem_childItem)) {
    initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem));
    return arrangeTable(
      store, parentPath,
      asTableItem(displayItem_childItem), linkItemMaybe_childItem,
      linkItemMaybe_childItem, geometry, ArrangeItemFlags.InsideCompositeOrDoc,
      compositeWidthBl);
  }

  if (isPage(displayItem_childItem)) {
    let widthBl = compositeWidthBl;
    if (asPageItem(displayItem_childItem).spatialWidthGr / GRID_SIZE < widthBl) {
      widthBl = asPageItem(displayItem_childItem).spatialWidthGr / GRID_SIZE;
    }
    const renderPageWithChildren = widthBl >= CHILD_ITEMS_VISIBLE_WIDTH_BL;
    if (renderPageWithChildren) {
      initiateLoadChildItemsMaybe(store, VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem));
      return arrangePageWithChildren(
        store, parentPath,
        asPageItem(displayItem_childItem), linkItemMaybe_childItem,
        linkItemMaybe_childItem, geometry, ArrangeItemFlags.InsideCompositeOrDoc);
    }
  }

  const compositeChildVePath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem_childItem, linkItemMaybe_childItem), parentPath);

  const compositeChildVeSpec: VisualElementSpec = {
    displayItem: displayItem_childItem,
    linkItemMaybe: linkItemMaybe_childItem,
    actualLinkItemMaybe: linkItemMaybe_childItem,
    flags: VisualElementFlags.InsideCompositeOrDoc | VisualElementFlags.Detailed,
    _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
    boundsPx: {
      x: geometry.boundsPx.x,
      y: geometry.boundsPx.y,
      w: geometry.boundsPx.w,
      h: geometry.boundsPx.h,
    },
    hitboxes: geometry.hitboxes,
    parentPath,
    col: 0,
    row: idx,
    blockSizePx,
  };

  if (isAttachmentsItem(displayItem_childItem)) {
    const parentItemSizeBl = ItemFns.calcSpatialDimensionsBl(linkItemMaybe_childItem == null ? displayItem_childItem : linkItemMaybe_childItem);
    if (!isPage(displayItem_childItem) && !isImage(displayItem_childItem)) {
      parentItemSizeBl.w = compositeWidthBl;
    }
    const attachments = arrangeItemAttachments(store, asAttachmentsItem(displayItem_childItem).computed_attachments, parentItemSizeBl, geometry.boundsPx, parentPath);
    compositeChildVeSpec.attachmentsVes = attachments;
  } else {
    compositeChildVeSpec.attachmentsVes = [];
  }

  const compositeChildVeSignal = VesCache.full_createOrRecycleVisualElementSignal(compositeChildVeSpec, compositeChildVePath);

  if (isExpression(displayItem_childItem)) {
    VesCache.markEvaluationRequired(compositeChildVePath);
  }

  return compositeChildVeSignal;
}
