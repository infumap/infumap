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


export enum TableFlags {
  None = 0x000,
  ShowColHeader = 0x001,
};

export enum NoteFlags {
  // Note:
  //   PlainText is implicit via lack of other text style flags.
  //   AlignLeft is implicit via lack of other alignment flags.
  // TODO (LOW): better group the flags together. Current ordering reflects implementation order.
  None = 0x000,
  Heading3 = 0x001,
  ShowCopyIcon = 0x002,
  Heading1 = 0x004,
  Heading2 = 0x008,
  Bullet1 = 0x010,
  AlignCenter = 0x020,
  AlignRight = 0x040,
  AlignJustify = 0x080,
  HideBorder = 0x100,
  Code = 0x200,
  ExplicitHeight = 0x400,
};

export enum CompositeFlags {
  None = 0x000,
  HideBorder = 0x001,
};

export enum PageFlags {
  None = 0x000,
  EmbeddedInteractive = 0x001,
};

export enum ImageFlags {
  None = 0x000,
  HideBorder = 0x001,
  NoCrop = 0x002,
}

const ITEM_TYPES = [ItemType.Note, ItemType.Table, ItemType.Composite, ItemType.Page, ItemType.Image, ItemType.Expression];


export interface FlagsMixin {
  flags: number,
}

export interface FlagsItem extends FlagsMixin, Item { }


export function isFlagsItem(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return ITEM_TYPES.find(t => t == item.itemType) != null;
}

export function asFlagsItem(item: ItemTypeMixin): FlagsItem {
  if (isFlagsItem(item)) { return item as FlagsItem; }
  panic("not flags item.");
}
