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


export const renderDockMaybe = (store: StoreContextModel, parentPath: VisualElementPath, children: Array<VisualElementSignal>) => {

  if (store.user.getUserMaybe() == null) {
    return;
  }

  if (itemState.get(store.user.getUser().dockPageId) == null) {
    initiateLoadItemMaybe(store, store.user.getUser().dockPageId);
  } else {
    initiateLoadChildItemsMaybe(store, { itemId: store.user.getUser().dockPageId, linkIdMaybe: null });

    const dockPage = asPageItem(itemState.get(store.user.getUser().dockPageId)!);
    const dim = ItemFns.calcSpatialDimensionsBl(dockPage);
    const dockBoundsPx = {
      x: store.desktopBoundsPx().w - 80,
      y: store.desktopBoundsPx().h / 3,
      w: 80,
      h: 50,
    }
    const innerBoundsPx = zeroBoundingBoxTopLeft(dockBoundsPx);
    const dockVisualElementSpec = {
      displayItem: dockPage,
      linkItemMaybe: null,
      flags: VisualElementFlags.IsDock,
      boundsPx: dockBoundsPx,
      childAreaBoundsPx: dockBoundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
      ],
      parentPath: parentPath,
    };

    const dockPath = VeFns.addVeidToPath( {itemId: dockPage.id, linkIdMaybe: null},  parentPath);
    children.push(VesCache.createOrRecycleVisualElementSignal(dockVisualElementSpec, dockPath));

    if (itemState.get(store.user.getUser().trashPageId) == null) {
      initiateLoadItemMaybe(store, store.user.getUser().trashPageId);
    } else {
      const trashPage = asPageItem(itemState.get(store.user.getUser().trashPageId)!);
      const trashBoundsPx = {
        x: store.desktopBoundsPx().w - 80,
        y: store.desktopBoundsPx().h / 3 + 60,
        w: 80,
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
          HitboxFns.create(HitboxFlags.OpenPopup, innerBoundsPx),
        ],
        parentPath: parentPath,
      };

      const trashPath = VeFns.addVeidToPath( {itemId: trashPage.id, linkIdMaybe: null},  parentPath);
      children.push(VesCache.createOrRecycleVisualElementSignal(trashVisualElementSpec, trashPath));
    }
  }
}
