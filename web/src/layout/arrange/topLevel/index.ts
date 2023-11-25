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

import { CursorEventState, MouseAction, MouseActionState } from "../../../input/state";
import { ItemFns } from "../../../items/base/item-polymorphism";
import { ArrangeAlgorithm, asPageItem } from "../../../items/page-item";
import { itemState } from "../../../store/ItemState";
import { StoreContextModel } from "../../../store/StoreProvider";
import { zeroBoundingBoxTopLeft } from "../../../util/geometry";
import { VisualElementSignal } from "../../../util/signals";
import { HitboxFlags, HitboxFns } from "../../hitbox";
import { initiateLoadChildItemsMaybe, initiateLoadItemMaybe } from "../../load";
import { VesCache } from "../../ves-cache";
import { VeFns, VisualElementFlags, VisualElementPath } from "../../visual-element";
import { arrangeItem } from "../item";


export const renderDockMaybe = (store: StoreContextModel, parentPath: VisualElementPath, pageChildren: Array<VisualElementSignal>) => {

  if (store.user.getUserMaybe() == null) {
    return;
  }

  if (itemState.get(store.user.getUser().briefcasePageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().briefcasePageId);
  } else {
    const dockPageId = store.user.getUser().briefcasePageId;
    initiateLoadChildItemsMaybe(store, { itemId: dockPageId, linkIdMaybe: null });

    const dockPage = asPageItem(itemState.get(store.user.getUser().briefcasePageId)!);
    const dockPath = VeFns.addVeidToPath({ itemId: dockPageId, linkIdMaybe: null }, parentPath);

    let movingItem = null;
    if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
      movingItem = VeFns.canonicalItemFromPath(MouseActionState.get().activeElement);
    }

    let yCurrentPx = 0;
    const dockChildren = [];
    for (let i=0; i<dockPage.computed_children.length; ++i) {
      const childId = dockPage.computed_children[i];
      const childItem = itemState.get(childId)!;

      const cellBoundsPx = { x: 0, y: 0, w: 50, h: 50 };
      const geometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, false, false, false);

      if (movingItem != null && childId == movingItem.id) {
        const _mouseDestkopPosPx = CursorEventState.getLatestDesktopPx();
        geometry.boundsPx.y = 0;
      } else {
        geometry.boundsPx.y = 2 + yCurrentPx;
        yCurrentPx += geometry.boundsPx.h + 3;
      }

      const ves = arrangeItem(store, dockPath, ArrangeAlgorithm.Dock, childItem, geometry, true, false, false, false, false);
      dockChildren.push(ves);
    }

    const dockBoundsPx = {
      x: store.desktopBoundsPx().w - 53,
      y: store.desktopBoundsPx().h / 3,
      w: 50,
      h: 130,
    }

    const innerBoundsPx = zeroBoundingBoxTopLeft(dockBoundsPx);
    const dockVisualElementSpec = {
      displayItem: dockPage,
      linkItemMaybe: null,
      flags: VisualElementFlags.IsDock | VisualElementFlags.ShowChildren,
      boundsPx: dockBoundsPx,
      childAreaBoundsPx: dockBoundsPx,
      hitboxes: [
        // HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        // HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
      ],
      parentPath,
      children: dockChildren,
    };

    if (itemState.get(store.user.getUser().trashPageId) == null) {
      initiateLoadItemMaybe(store, store.user.getUser().trashPageId);
    } else {
      const trashPage = asPageItem(itemState.get(store.user.getUser().trashPageId)!);
      const trashBoundsPx = {
        x: 0,
        y: yCurrentPx,
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
        parentPath: dockPath,
      };

      const trashPath = VeFns.addVeidToPath( {itemId: trashPage.id, linkIdMaybe: null},  dockPath);
      dockChildren.push(VesCache.createOrRecycleVisualElementSignal(trashVisualElementSpec, trashPath));
    }

    pageChildren.push(VesCache.createOrRecycleVisualElementSignal(dockVisualElementSpec, dockPath));
  }
}
