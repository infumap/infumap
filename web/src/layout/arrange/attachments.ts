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

import { ItemFns } from "../../items/base/item-polymorphism";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { BoundingBox, Dimensions } from "../../util/geometry";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import { getVePropertiesForItem } from "./util";
import { ArrangeItemFlags } from "./item";
import { Uid } from "../../util/uid";
import { Item } from "../../items/base/item";
import { asAttachmentsItem, isAttachmentsItem, setGeometryAttachmentBlockSizePx } from "../../items/base/attachments-item";
import { ItemGeometry } from "../item-geometry";


/**
 * For arrangements where items are scaled to fit (e.g. grid, justified), render attachments of the
 * item at the specified block size, rather than the block size implied by the item's scaling.
 * If canAttach is true, also ensure the item has an attach (drop target) hitbox, since the in-cell
 * geometry of most item types does not include one.
 */
export function setNaturalAttachmentBlockSizePx(store: StoreContextModel, item: Item, geometry: ItemGeometry, blockSizePx: number, canAttach: boolean) {
  const { displayItem } = getVePropertiesForItem(store, item);
  const isAttachments = isAttachmentsItem(displayItem);
  const attachmentCount = isAttachments ? asAttachmentsItem(displayItem).computed_attachments.length : 0;
  setGeometryAttachmentBlockSizePx(geometry, attachmentCount, blockSizePx, canAttach && isAttachments);
}


export function arrangeItemAttachments(
  store: StoreContextModel,
  attachmentIds: Array<Uid>,
  parentItemSizeBl: Dimensions,
  parentItemBoundsPx: BoundingBox,
  parentItemVePath: VisualElementPath,
  blockSizePxMaybe?: number): Array<VisualElementPath> {

  // Attachment geometry derives block size from parent bounds / parent size. Override the latter
  // to achieve a specific block size.
  if (blockSizePxMaybe != null) {
    parentItemSizeBl = {
      w: parentItemBoundsPx.w / blockSizePxMaybe,
      h: parentItemBoundsPx.h / blockSizePxMaybe,
    };
  }

  const attachmentPaths: Array<VisualElementPath> = [];
  for (let i = 0; i < attachmentIds.length; ++i) {
    const attachmentId = attachmentIds[i];
    const attachmentItem = itemState.get(attachmentId)!;
    const { displayItem: attachmentDisplayItem, linkItemMaybe: attachmentLinkItemMaybe } = getVePropertiesForItem(store, attachmentItem);
    const attachmentVeid: Veid = {
      itemId: attachmentDisplayItem.id,
      linkIdMaybe: attachmentLinkItemMaybe ? attachmentLinkItemMaybe.id : null
    };
    const attachmentVePath = VeFns.addVeidToPath(attachmentVeid, parentItemVePath);

    // Auto-moved-into-view state is keyed by ve path, and an attachment has the same path it would have
    // as a child of its parent (e.g. if it was moved into the parent page before being attached). Attachments
    // are never auto-moved, so clear any stale state.
    store.perVe.setAutoMovedIntoView(attachmentVePath, false);

    let isSelected = false;

    const attachmentGeometry = ItemFns.calcGeometry_Attachment(attachmentItem, parentItemBoundsPx, parentItemSizeBl, i, isSelected);

    const veSpec: VisualElementSpec = {
      displayItem: attachmentDisplayItem,
      linkItemMaybe: attachmentLinkItemMaybe,
      actualLinkItemMaybe: attachmentLinkItemMaybe,
      boundsPx: attachmentGeometry.boundsPx,
      hitboxes: attachmentGeometry.hitboxes,
      parentPath: parentItemVePath,
      flags: VisualElementFlags.Attachment |
        (isSelected ? VisualElementFlags.Detailed : VisualElementFlags.None) |
        (isSelected ? VisualElementFlags.ZAbove : VisualElementFlags.None),
      _arrangeFlags_useForPartialRearrangeOnly: ArrangeItemFlags.None,
    };
    const veRelationships: VisualElementRelationships = {};
    VesCache.arrange.writeVisualElement(veSpec, veRelationships, attachmentVePath);
    attachmentPaths.push(attachmentVePath);
  }

  return attachmentPaths;
}
