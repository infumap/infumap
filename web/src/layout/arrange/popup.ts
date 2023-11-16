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

import { batch } from "solid-js";
import { ItemFns } from "../../items/base/item-polymorphism";
import { LinkFns } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { newUid } from "../../util/uid";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, VisualElementFlags, VisualElementSpec } from "../visual-element";
import { arrangeItem } from "./item";
import { VesCache } from "../ves-cache";
import { arrangeItemAttachments } from "./attachments";


export const POPUP_LINK_ID = newUid();

export function arrangeCellPopup(store: StoreContextModel): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(store.currentPage()!.itemId)!);
  const currentPath = VeFns.addVeidToPath(VeFns.veidFromItems(currentPage, null), "");
  const currentPopupSpec = store.currentPopupSpec()!;

  const popupLinkToImageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, newOrdering(), popupLinkToImageId!);
  li.id = POPUP_LINK_ID;
  li.spatialWidthGr = 1000;
  li.spatialPositionGr = { x: 0, y: 0, };
  const desktopBoundsPx = store.desktopBoundsPx();
  const cellBoundsPx = {
    x: desktopBoundsPx.w * 0.1,
    y: desktopBoundsPx.h * 0.07,
    w: desktopBoundsPx.w * 0.8,
    h: desktopBoundsPx.h * 0.8,
  };
  let geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx, false, false, true, PageFns.popupPositioningHasChanged(currentPage));

  const item = itemState.get(popupLinkToImageId)!;

  if (isPage(item)) {
    let ves: VisualElementSignal;
    batch(() => {
      ves = arrangeItem(store, currentPath, currentPage.arrangeAlgorithm, li, geometry, true, true, true, false, false);
      let newV = ves.get();
      newV.flags |= (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ? VisualElementFlags.Fixed : VisualElementFlags.None);
      ves.set(newV);
    });
    return ves!;
  } else {
    const itemVisualElement: VisualElementSpec = {
      displayItem: item,
      linkItemMaybe: li,
      flags: VisualElementFlags.Detailed | VisualElementFlags.Popup |
             (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ? VisualElementFlags.Fixed : VisualElementFlags.None),
      boundsPx: geometry.boundsPx,
      childAreaBoundsPx: isPage(item) ? geometry.boundsPx : undefined,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
    };

    const itemPath = VeFns.addVeidToPath(VeFns.veidFromItems(item, li), currentPath);
    itemVisualElement.attachments = arrangeItemAttachments(store, item, li, geometry.boundsPx, itemPath);
    return VesCache.createOrRecycleVisualElementSignal(itemVisualElement, itemPath);
  }
}
