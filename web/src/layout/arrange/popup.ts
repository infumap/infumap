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
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { DesktopStoreContextModel } from "../../store/DesktopStoreProvider";
import { itemState } from "../../store/ItemState";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { newUid } from "../../util/uid";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, VisualElementFlags, VisualElementSpec } from "../visual-element";
import { arrangeItem } from "./common";
import { VesCache } from "../ves-cache";
import { arrangeItemAttachments } from "./attachments";


const CELL_POPUP_LINK_ID = newUid();

export function arrangeCellPopup(desktopStore: DesktopStoreContextModel): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = VeFns.prependVeidToPath(VeFns.createVeid(currentPage, null), "");
  const currentPopupSpec = desktopStore.currentPopupSpec()!;

  const popupLinkToImageId = VeFns.veidFromPath(currentPopupSpec.vePath).itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, newOrdering(), popupLinkToImageId!);
  li.id = CELL_POPUP_LINK_ID;
  li.spatialWidthGr = 1000;
  li.spatialPositionGr = { x: 0, y: 0, };
  const desktopBoundsPx = desktopStore.desktopBoundsPx();
  const cellBoundsPx = {
    x: desktopBoundsPx.w * 0.1,
    y: desktopBoundsPx.h * 0.07,
    w: desktopBoundsPx.w * 0.8,
    h: desktopBoundsPx.h * 0.8,
  };
  let geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx);

  const item = itemState.get(popupLinkToImageId)!;

  if (isPage(item)) {
    let ves: VisualElementSignal;
    batch(() => {
      ves = arrangeItem(desktopStore, currentPath, currentPage.arrangeAlgorithm, li, geometry, true, true, true);
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

    const itemPath = VeFns.prependVeidToPath(VeFns.createVeid(item, li), currentPath);
    itemVisualElement.attachments = arrangeItemAttachments(desktopStore, item, li, geometry.boundsPx, itemPath);
    return VesCache.createOrRecycleVisualElementSignal(itemVisualElement, itemPath);
  }
}
