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

import { ItemFns } from "../../../items/base/item-polymorphism";
import { asPageItem } from "../../../items/page-item";
import { itemState } from "../../../store/ItemState";
import { StoreContextModel } from "../../../store/StoreProvider";
import { zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { VisualElementSignal } from "../../../util/signals";
import { HitboxFlags, HitboxFns } from "../../hitbox";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../../load";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath } from "../../visual-element";
// import { arrangeItem } from "../item";


export const renderBriefcaseMaybe = (store: StoreContextModel, parentPath: VisualElementPath, children: Array<VisualElementSignal>) => {

  if (store.user.getUserMaybe() == null) {
    return;
  }

  if (itemState.get(store.user.getUser().briefcasePageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().briefcasePageId);
  } else {
    initiateLoadChildItemsMaybe(store, { itemId: store.user.getUser().briefcasePageId, linkIdMaybe: null });

    const briefcasePage = asPageItem(itemState.get(store.user.getUser().briefcasePageId)!);

    // const currentPath =
    let yCurrentPx = 0;
    for (let i=0; i<briefcasePage.computed_children.length; ++i) {
      const childId = briefcasePage.computed_children[i];
      const childItem = itemState.get(childId)!;
      const cellBoundsPx = { x: 0, y: 0, w: 50, h: 50 };
      const geometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, false, false, false);
      geometry.boundsPx.y = 2 + yCurrentPx;
      yCurrentPx += geometry.boundsPx.h;

      // const ves = arrangeItem(store, currentPath, ArrangeAlgorithm.Grid, childItem, geometry, true, false, false, false, false);
      // children.push(ves);
    }

    const briefcaseBoundsPx = {
      x: store.desktopBoundsPx().w - 53,
      y: store.desktopBoundsPx().h / 3,
      w: 50,
      h: 50,
    }
    const innerBoundsPx = zeroBoundingBoxTopLeft(briefcaseBoundsPx);
    const briefcaseVisualElementSpec = {
      displayItem: briefcasePage,
      linkItemMaybe: null,
      flags: VisualElementFlags.IsBriefcase,
      boundsPx: briefcaseBoundsPx,
      childAreaBoundsPx: briefcaseBoundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
      ],
      parentPath: parentPath,
    };

    const briefcasePath = VeFns.addVeidToPath( {itemId: briefcasePage.id, linkIdMaybe: null},  parentPath);
    children.push(VesCache.createOrRecycleVisualElementSignal(briefcaseVisualElementSpec, briefcasePath));

    if (itemState.get(store.user.getUser().trashPageId) == null) {
      initiateLoadItemMaybe(store, store.user.getUser().trashPageId);
    } else {
      const trashPage = asPageItem(itemState.get(store.user.getUser().trashPageId)!);
      const trashBoundsPx = {
        x: store.desktopBoundsPx().w - 53,
        y: store.desktopBoundsPx().h / 3 + 55,
        w: 50,
        h: 50,
      }
      const innerBoundsPx = zeroBoundingBoxTopLeft(trashBoundsPx);
      const trashVisualElementSpec = {
        displayItem: trashPage,
        linkItemMaybe: null,
        flags: VisualElementFlags.IsTrash,
        boundsPx: trashBoundsPx,
        childAreaBoundsPx: trashBoundsPx,
        hitboxes: [
          HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
          HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
        ],
        parentPath: parentPath,
      };

      const trashPath = VeFns.addVeidToPath( {itemId: trashPage.id, linkIdMaybe: null},  parentPath);
      children.push(VesCache.createOrRecycleVisualElementSignal(trashVisualElementSpec, trashPath));
    }
  }
}
