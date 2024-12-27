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
import { VisualElementSignal } from "../../util/signals";
import { VesCache } from "../ves-cache";
import { VeFns, Veid, VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { getVePropertiesForItem } from "./util";
import { ArrangeItemFlags } from "./item";
import { Uid } from "../../util/uid";


export function arrangeItemAttachments(
    store: StoreContextModel,
    attachmentIds: Array<Uid>,
    parentItemSizeBl: Dimensions,
    parentItemBoundsPx: BoundingBox,
    parentItemVePath: VisualElementPath): Array<VisualElementSignal> {

  const attachments: Array<VisualElementSignal> = [];
  for (let i=0; i<attachmentIds.length; ++i) {
    const attachmentId = attachmentIds[i];
    const attachmentItem = itemState.get(attachmentId)!;
    const { displayItem: attachmentDisplayItem, linkItemMaybe: attachmentLinkItemMaybe } = getVePropertiesForItem(store, attachmentItem);
    const attachmentVeid: Veid = {
      itemId: attachmentDisplayItem.id,
      linkIdMaybe: attachmentLinkItemMaybe ? attachmentLinkItemMaybe.id : null
    };
    const attachmentVePath = VeFns.addVeidToPath(attachmentVeid, parentItemVePath);

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
    const attachmentVisualElementSignal = VesCache.full_createOrRecycleVisualElementSignal(veSpec, attachmentVePath);
    attachments.push(attachmentVisualElementSignal);
  }

  return attachments;
}
