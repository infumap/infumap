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
import { Item, ItemTypeMixin, ItemType } from "./item";


const ITEM_TYPES = [ItemType.Page, ItemType.Note, ItemType.Table, ItemType.Image, ItemType.File, ItemType.Password, ItemType.Composite, ItemType.Expression, ItemType.FlipCard];
const HALF_SIZEABLE_ITEM_TYPES = [ItemType.Note, ItemType.Table, ItemType.Image, ItemType.File, ItemType.Password, ItemType.Composite, ItemType.Expression];

export interface XSizableMixin {
  spatialWidthGr: number,
}

export interface XSizableItem extends XSizableMixin, Item { }


export function isXSizableItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}

export function asXSizableItem(item: ItemTypeMixin): XSizableItem {
  if (isXSizableItem(item)) { return item as XSizableItem; }
  console.error("asXSizableItem failed:", {
    itemType: item?.itemType,
    itemId: (item as any)?.id,
    item: item,
    expectedTypes: ITEM_TYPES
  });
  panic("not x-sizable item.");
}

export function allowHalfBlockWidth(item: XSizableItem): boolean {
  return HALF_SIZEABLE_ITEM_TYPES.find(t => t == item.itemType) != null;
}
