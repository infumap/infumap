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
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, Veid, VisualElementFlags, VisualElementSpec } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { VesCache } from "../ves-cache";
import { arrangeItemAttachments } from "./attachments";
import { POPUP_LINK_UID, TOP_LEVEL_PAGE_UID } from "../../util/uid";


export function arrangeCellPopup(store: StoreContextModel, realParentVeid: Veid | null): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(store.history.currentPage()!.itemId)!);
  const currentPath = VeFns.addVeidToPath(VeFns.veidFromItems(currentPage, null), TOP_LEVEL_PAGE_UID);
  const currentPopupSpec = store.history.currentPopupSpec()!;

  const renderAsFixed = (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
                         currentPage.arrangeAlgorithm == ArrangeAlgorithm.Justified);

  const popupLinkToImageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, newOrdering(), popupLinkToImageId!);
  li.id = POPUP_LINK_UID;
  li.spatialWidthGr = 1000;
  li.spatialPositionGr = { x: 0, y: 0, };
  const desktopBoundsPx = store.desktopMainAreaBoundsPx();
  const cellBoundsPx = {
    x: desktopBoundsPx.w * 0.1,
    y: desktopBoundsPx.h * 0.07,
    w: desktopBoundsPx.w * 0.8,
    h: desktopBoundsPx.h * 0.8,
  };
  let geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx, false, false, true, PageFns.popupPositioningHasChanged(currentPage), false);
  if (renderAsFixed) {
    geometry.boundsPx.x += store.dockWidthPx.get();
  }
  const item = itemState.get(popupLinkToImageId)!;

  if (isPage(item)) {
    let ves: VisualElementSignal;
    batch(() => {
      ves = arrangeItem(store, currentPath, realParentVeid, currentPage.arrangeAlgorithm, li, geometry, ArrangeItemFlags.IsPopup);
      let ve = ves.get();
      ve.flags |= (renderAsFixed ? VisualElementFlags.Fixed : VisualElementFlags.None);
      ves.set(ve);
    });
    return ves!;
  } else {
    const itemVisualElement: VisualElementSpec = {
      displayItem: item,
      linkItemMaybe: li,
      flags: VisualElementFlags.Popup |
             VisualElementFlags.Detailed |
             (renderAsFixed ? VisualElementFlags.Fixed : VisualElementFlags.None),
      boundsPx: geometry.boundsPx,
      childAreaBoundsPx: isPage(item) ? geometry.boundsPx : undefined,
      hitboxes: geometry.hitboxes,
      parentPath: currentPath,
    };

    const itemPath = VeFns.addVeidToPath(VeFns.veidFromItems(item, li), currentPath);
    itemVisualElement.attachmentsVes = arrangeItemAttachments(store, item, li, geometry.boundsPx, itemPath);
    return VesCache.createOrRecycleVisualElementSignal(itemVisualElement, itemPath);
  }
}
