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
import { Item, ItemTypeMixin, ITEM_TYPE_TABLE, ITEM_TYPE_NOTE } from "./item";

export enum ItemFlagsType {
  None =           0x000,
  ShowHeader =     0x001,
  ShowCopyIcon =   0x002,
}

const ITEM_TYPES = [ITEM_TYPE_NOTE, ITEM_TYPE_TABLE];

export interface FlagsMixin {
  flags: ItemFlagsType,
}

export interface FlagsItem extends FlagsMixin, Item { }


export function isFlagsItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}

export function asFlagsItem(item: ItemTypeMixin): FlagsItem {
  if (isFlagsItem(item)) { return item as FlagsItem; }
  panic();
}