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

import { RESIZE_BOX_SIZE_PX } from "../../../constants";
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


export const renderDockMaybe = (store: StoreContextModel, parentPath: VisualElementPath): VisualElementSignal | null => {

  if (store.user.getUserMaybe() == null) {
    return null;
  }

  if (itemState.get(store.user.getUser().dockPageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().dockPageId);
    return null;

  } else {
    const dockPageId = store.user.getUser().dockPageId;
    initiateLoadChildItemsMaybe(store, { itemId: dockPageId, linkIdMaybe: null });

    const dockPage = asPageItem(itemState.get(store.user.getUser().dockPageId)!);
    const dockPath = VeFns.addVeidToPath({ itemId: dockPageId, linkIdMaybe: null }, parentPath);

    let movingItem = null;
    if (!MouseActionState.empty() && (MouseActionState.get().action == MouseAction.Moving)) {
      movingItem = VeFns.canonicalItemFromPath(MouseActionState.get().activeElement);
    }

    const GAP_PX = 8;

    let yCurrentPx = 0;
    const dockChildren = [];
    for (let i=0; i<dockPage.computed_children.length; ++i) {
      const childId = dockPage.computed_children[i];
      const childItem = itemState.get(childId)!;

      let wPx = store.dockWidthPx.get() - GAP_PX * 2;
      if (wPx < 0) { wPx = 0; }
      const cellBoundsPx = { x: GAP_PX, y: 0, w: wPx, h: store.dockWidthPx.get() };
      const geometry = ItemFns.calcGeometry_InCell(childItem, cellBoundsPx, false, false, false, false, false);

      if (movingItem != null && childId == movingItem.id) {
        const _mouseDestkopPosPx = CursorEventState.getLatestDesktopPx();
        geometry.boundsPx.y = 0;
      } else {
        geometry.boundsPx.y = GAP_PX + yCurrentPx;
        yCurrentPx += geometry.boundsPx.h + GAP_PX;
      }

      if (store.dockWidthPx.get() > 25) {
        const ves = arrangeItem(store, dockPath, null, ArrangeAlgorithm.Dock, childItem, geometry, true, false, false, false, false);
        dockChildren.push(ves);
      }
    }
    yCurrentPx += GAP_PX;

    let trashHeightPx = 50;
    if (store.dockWidthPx.get() - GAP_PX*2 < trashHeightPx) {
      trashHeightPx = store.dockWidthPx.get() - GAP_PX*2;
      if (trashHeightPx < 0) { trashHeightPx = 0; }
    }

    const dockBoundsPx = {
      x: 0, y: 0,
      w: store.dockWidthPx.get(),
      h: store.desktopBoundsPx().h
    };

    const resizeBoundsPx = zeroBoundingBoxTopLeft(dockBoundsPx);
    resizeBoundsPx.w = RESIZE_BOX_SIZE_PX;
    resizeBoundsPx.x = store.dockWidthPx.get() - RESIZE_BOX_SIZE_PX;

    const dockVisualElementSpec = {
      displayItem: dockPage,
      linkItemMaybe: null,
      flags: VisualElementFlags.IsDock | VisualElementFlags.ShowChildren,
      boundsPx: dockBoundsPx,
      childAreaBoundsPx: dockBoundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.HorizontalResize, resizeBoundsPx),
      ],
      parentPath,
      childrenVes: dockChildren,
    };

    if (itemState.get(store.user.getUser().trashPageId) == null) {
      initiateLoadItemMaybe(store, store.user.getUser().trashPageId);
    } else {
      const trashPage = asPageItem(itemState.get(store.user.getUser().trashPageId)!);
      const trashBoundsPx = {
        x: GAP_PX,
        y: store.desktopBoundsPx().h - trashHeightPx - GAP_PX * 2,
        w: store.dockWidthPx.get() - GAP_PX*2,
        h: trashHeightPx,
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

      if (store.dockWidthPx.get() > 25) {
        const trashPath = VeFns.addVeidToPath( {itemId: trashPage.id, linkIdMaybe: null},  dockPath);
        dockChildren.push(VesCache.createOrRecycleVisualElementSignal(trashVisualElementSpec, trashPath));
      }
    }

    return VesCache.createOrRecycleVisualElementSignal(dockVisualElementSpec, dockPath);
  }
}
