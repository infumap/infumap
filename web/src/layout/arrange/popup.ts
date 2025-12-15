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
import { LinkFns, asLinkItem } from "../../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../../items/page-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { newOrdering } from "../../util/ordering";
import { VisualElementSignal } from "../../util/signals";
import { RelationshipToParent } from "../relationship-to-parent";
import { VeFns, VisualElementFlags } from "../visual-element";
import { ArrangeItemFlags, arrangeItem } from "./item";
import { POPUP_LINK_UID, UMBRELLA_PAGE_UID } from "../../util/uid";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../../items/base/y-sizeable-item";


export function arrangeCellPopup(store: StoreContextModel): VisualElementSignal {
  const currentPage = asPageItem(itemState.get(store.history.currentPageVeid()!.itemId)!);
  const currentPageVeid = store.history.currentPageVeid()!;
  const currentPath = VeFns.addVeidToPath(currentPageVeid, UMBRELLA_PAGE_UID);
  const currentPopupSpec = store.history.currentPopupSpec()!;

  const renderAsFixed = (currentPage.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
                         currentPage.arrangeAlgorithm == ArrangeAlgorithm.Justified ||
                         currentPage.arrangeAlgorithm == ArrangeAlgorithm.Calendar);

  const popupVeid = currentPopupSpec.actualVeid;
  const actualLinkItemMaybe = popupVeid.linkIdMaybe == null ? null : asLinkItem(itemState.get(popupVeid.linkIdMaybe)!);
  const popupLinkToId = popupVeid.itemId;
  const li = LinkFns.create(currentPage.ownerId, currentPage.id, RelationshipToParent.Child, popupLinkToId!, newOrdering());
  li.id = POPUP_LINK_UID;
  // Apply client-side popup overrides if present for this popup's source vePath
  if (currentPopupSpec.vePath) {
    const filter = store.perVe.getPopupFilterDate(currentPopupSpec.vePath);
    if (filter) {
      (li as any).overrideArrangeAlgorithm = ArrangeAlgorithm.List;
      (li as any).filterDate = filter;
      const mm = filter.month.toString().padStart(2, '0');
      const dd = filter.day.toString().padStart(2, '0');
      (li as any).overrideTitle = `${filter.year}-${mm}-${dd}`;
    }
  }
  if (popupVeid.linkIdMaybe) {
    if (isXSizableItem(itemState.get(popupVeid.linkIdMaybe)!)) {
      li.spatialWidthGr = asXSizableItem(itemState.get(popupVeid.linkIdMaybe)!).spatialWidthGr;
    }
    if (isYSizableItem(itemState.get(popupVeid.linkIdMaybe)!)) {
      li.spatialHeightGr = asYSizableItem(itemState.get(popupVeid.linkIdMaybe)!).spatialHeightGr;
    }
  } else {
    if (isXSizableItem(itemState.get(popupVeid.itemId)!)) {
      li.spatialWidthGr = asXSizableItem(itemState.get(popupVeid.itemId)!).spatialWidthGr;
    }
    if (isYSizableItem(itemState.get(popupVeid.itemId)!)) {
      li.spatialHeightGr = asYSizableItem(itemState.get(popupVeid.itemId)!).spatialHeightGr;
    }
  }
  li.spatialPositionGr = { x: 0, y: 0 };

  const desktopBoundsPx = store.desktopMainAreaBoundsPx();

  const popupItem = itemState.get(popupVeid.itemId);
  if (popupItem && isPage(popupItem) && asPageItem(popupItem).arrangeAlgorithm === ArrangeAlgorithm.Calendar) {
    li.aspectOverride = desktopBoundsPx.w / desktopBoundsPx.h;
  }

  const cellBoundsPx = {
    x: desktopBoundsPx.w * 0.1,
    y: desktopBoundsPx.h * 0.07,
    w: desktopBoundsPx.w * 0.8,
    h: desktopBoundsPx.h * 0.8,
  };
  let geometry = ItemFns.calcGeometry_InCell(li, cellBoundsPx, false, false, false, true, PageFns.popupPositioningHasChanged(currentPage), false, false, store.smallScreenMode());
  if (renderAsFixed) {
    geometry.boundsPx.x += store.getCurrentDockWidthPx();
    if (geometry.viewportBoundsPx != null) {
      geometry.viewportBoundsPx!.x += store.getCurrentDockWidthPx();
    }
  }

  let ves: VisualElementSignal;
  batch(() => {
    ves = arrangeItem(store, currentPath, currentPage.arrangeAlgorithm, li, actualLinkItemMaybe, geometry, ArrangeItemFlags.IsPopupRoot | ArrangeItemFlags.RenderChildrenAsFull);
    let ve = ves.get();
    ve.flags |= (renderAsFixed ? VisualElementFlags.Fixed : VisualElementFlags.None);
    ves.set(ve);
  });
  return ves!;
}
