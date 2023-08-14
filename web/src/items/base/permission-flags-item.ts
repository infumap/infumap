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
import { Item, ItemTypeMixin, ITEM_TYPE_PAGE } from "./item";

export enum PermissionFlags {
  None =           0x000,
  Public =         0x001,
}


const ITEM_TYPES = [ITEM_TYPE_PAGE];

export interface PermissionFlagsMixin {
  permissionFlags: number,
}

export interface PermissionFlagsItem extends PermissionFlagsMixin, Item { }


export function isPermissionFlagsItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}

export function asPermissionFlagsItem(item: ItemTypeMixin): PermissionFlagsItem {
  if (isPermissionFlagsItem(item)) { return item as PermissionFlagsItem; }
  panic();
}
