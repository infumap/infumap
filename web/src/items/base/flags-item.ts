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
  HideTitle = 0x002,
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
  Unused = 0x800,
  Heading4 = 0x1000,
};

export enum FileFlags {
  None = 0x000,
  Unused = 0x001,
}

export enum TextFlags {
  None = 0x000,
  Unused = 0x001,
}

export enum PasswordFlags {
  None = 0x000,
  Unused = 0x001,
}

export enum CompositeFlags {
  None = 0x000,
  HideBorder = 0x001,
};

export enum PageFlags {
  None = 0x000,
  EmbeddedInteractive = 0x001,
  HideDocumentTitle = 0x002,
  CalendarIndependentRows = 0x004,
};

export const PageCalendarDisplayMode = {
  Auto: "auto",
  Month: "month",
  Quarter: "quarter",
  HalfYear: "half-year",
  Year: "year",
} as const;

export type PageCalendarDisplayMode = typeof PageCalendarDisplayMode[keyof typeof PageCalendarDisplayMode];

const PAGE_CALENDAR_DISPLAY_MODE_MASK = 0x038;
const PAGE_CALENDAR_DISPLAY_MODE_SHIFT = 3;

function calendarDisplayModeBits(mode: PageCalendarDisplayMode): number {
  if (mode == PageCalendarDisplayMode.Month) { return 1; }
  if (mode == PageCalendarDisplayMode.Quarter) { return 2; }
  if (mode == PageCalendarDisplayMode.HalfYear) { return 3; }
  if (mode == PageCalendarDisplayMode.Year) { return 4; }
  return 0;
}

export function getPageCalendarDisplayMode(page: FlagsMixin): PageCalendarDisplayMode {
  const bits = (page.flags & PAGE_CALENDAR_DISPLAY_MODE_MASK) >> PAGE_CALENDAR_DISPLAY_MODE_SHIFT;
  if (bits == 1) { return PageCalendarDisplayMode.Month; }
  if (bits == 2) { return PageCalendarDisplayMode.Quarter; }
  if (bits == 3) { return PageCalendarDisplayMode.HalfYear; }
  if (bits == 4) { return PageCalendarDisplayMode.Year; }
  return PageCalendarDisplayMode.Auto;
}

export function setPageCalendarDisplayMode(page: FlagsMixin, mode: PageCalendarDisplayMode): void {
  page.flags = (page.flags & ~PAGE_CALENDAR_DISPLAY_MODE_MASK) |
    (calendarDisplayModeBits(mode) << PAGE_CALENDAR_DISPLAY_MODE_SHIFT);
}

export enum ImageFlags {
  None = 0x000,
  HideBorder = 0x001,
  NoCrop = 0x002,
}

const ITEM_TYPES = [ItemType.Note, ItemType.File, ItemType.Text, ItemType.Password, ItemType.Table, ItemType.Composite, ItemType.Page, ItemType.Image];


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
