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

import type { StoreContextModel } from "../../store/StoreProvider";

// The toolbar needs fallback heights before the optional dialog components are downloaded.
export const PAGE_SIZE_POPUP_HEIGHT_PX = 362;
export const PAGE_GRID_LAYOUT_POPUP_HEIGHT_PX = 436;
export const PAGE_CATALOG_LAYOUT_POPUP_HEIGHT_PX = 424;
export const PAGE_SHAPE_POPUP_HEIGHT_PX = 136;
export const PAGE_TABLE_LAYOUT_POPUP_HEIGHT_PX = 180;
export const PAGE_DOCUMENT_LAYOUT_POPUP_HEIGHT_PX = 200;

// Menus and other small popups from the toolbar: the outline, corner radius and shadow of a dialog (DIALOG_SURFACE_CLASS),
// which are those of items.
export const TOOLBAR_POPUP_CLASS = "absolute border border-control-border rounded-control bg-white shadow-xl";
export const TOOLBAR_MENU_CLASS = `${TOOLBAR_POPUP_CLASS} p-[3px]`;

// A 20px line plus 3px padding on each side; the panel adds padding and a 1px border.
export const toolbarMenuHeightPx = (rows: number): number => rows * 26 + 8;

export const toolbarMenuItemClass = (selected = false): string =>
  `block w-full text-left text-sm leading-[20px] p-[3px] rounded-control cursor-pointer text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ` +
  (selected ? "bg-control-selected" : "hover:bg-control-hover focus-visible:bg-control-hover");

// Anchor every dropdown and message to the toolbar, regardless of the trigger's baseline.
export const toolbarPopupTopPx = (store: StoreContextModel): number => store.topToolbarHeightPx() + 5;
