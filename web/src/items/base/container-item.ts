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

import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { Item, ItemTypeMixin, ItemType } from "./item";


const ITEM_TYPES = [ItemType.Page, ItemType.Table, ItemType.Composite, ItemType.FlipCard];

export interface ContainerMixin {
  orderChildrenBy: string | null;

  computed_children: Array<Uid>;
  childrenLoaded: boolean;
}

export interface ContainerItem extends ContainerMixin, Item { }


export function isContainer(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}

export function asContainerItem(item: ItemTypeMixin): ContainerItem {
  if (isContainer(item)) { return item as ContainerItem; }
  panic("not container item.");
}
