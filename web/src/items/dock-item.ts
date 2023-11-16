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

import { currentUnixTimeSeconds, panic } from "../util/lang";
import { Uid, newUid } from "../util/uid";
import { ContainerItem } from "./base/container-item";
import { Item, ItemType, ItemTypeMixin } from "./base/item";


export interface DockItem extends ContainerItem, Item { }

export interface DockMeasurable extends ItemTypeMixin {
  id: Uid;
  childrenLoaded: boolean;
  computed_children: Array<Uid>;
}

export const DockFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, ordering: Uint8Array): DockItem => {
    return ({
      origin: null,
      itemType: ItemType.Dock,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,

      orderChildrenBy: "",

      computed_children: [],
      childrenLoaded: true,
    });
  },

  asDockMeasurable: (item: ItemTypeMixin): DockMeasurable => {
    if (item.itemType == ItemType.Dock) { return item as DockMeasurable; }
    panic("not dock measurable.");
  },

  debugSummary: (_dockItem: DockItem) => {
    return "[dock] ...";
  },

  getFingerprint: (_dockItem: DockItem): string => {
    return "~~~!@#~~~";
  }  
}

export function isDock(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Dock;
}

export function asDockItem(item: ItemTypeMixin): DockItem {
  if (item.itemType == ItemType.Dock) { return item as DockItem; }
  panic("not dock item.");
}
