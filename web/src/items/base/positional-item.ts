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

import { Vector } from "../../util/geometry";
import { Item, ItemTypeMixin, ItemType } from "./item";


export interface PositionalMixin {
  spatialPositionGr: Vector,
  calendarPositionGr: Vector,
}

export interface PositionalItem extends PositionalMixin, Item { }


export function isPositionalItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType !== ItemType.Placeholder;
}

export function asPositionalItem(item: ItemTypeMixin): PositionalItem {
  return item as PositionalItem;
}
