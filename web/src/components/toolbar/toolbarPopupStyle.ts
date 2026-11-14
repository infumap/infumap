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
import { DIALOG_SURFACE_CLASS, MENU_SURFACE_CLASS, menuItemClass } from "../library/dialogStyle";

// The toolbar needs fallback heights before the optional dialog components are downloaded.
export const PAGE_SIZE_POPUP_HEIGHT_PX = 362;
export const PAGE_GRID_LAYOUT_POPUP_HEIGHT_PX = 436;
export const PAGE_CATALOG_LAYOUT_POPUP_HEIGHT_PX = 424;
export const PAGE_SHAPE_POPUP_HEIGHT_PX = 136;
export const PAGE_TABLE_LAYOUT_POPUP_HEIGHT_PX = 180;
export const PAGE_DOCUMENT_LAYOUT_POPUP_HEIGHT_PX = 200;

// Menus and other small popups from the toolbar look like dialogs (and so like items).
export const TOOLBAR_POPUP_CLASS = `absolute ${DIALOG_SURFACE_CLASS}`;
export const TOOLBAR_MENU_CLASS = `absolute ${MENU_SURFACE_CLASS}`;

// A 20px line plus 3px padding on each side; the panel adds padding and a 1px border.
export const toolbarMenuHeightPx = (rows: number): number => rows * 26 + 8;

export const toolbarMenuItemClass = (selected = false): string => `block ${menuItemClass(selected)}`;

// Anchor every dropdown and message to the toolbar, regardless of the trigger's baseline.
export const toolbarPopupTopPx = (store: StoreContextModel): number => store.topToolbarHeightPx() + 5;
