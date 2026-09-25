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

// Use the conversion menu's border throughout the toolbar, with a plain white surface.
export const TOOLBAR_POPUP_CLASS = "absolute border border-slate-400 rounded bg-white shadow-sm";
export const TOOLBAR_MENU_CLASS = `${TOOLBAR_POPUP_CLASS} p-[3px]`;

// A 20px line plus 3px padding on each side; the panel adds padding and a 1px border.
export const toolbarMenuHeightPx = (rows: number): number => rows * 26 + 8;

export const toolbarMenuItemClass = (selected = false): string =>
  `block w-full text-left text-sm leading-[20px] p-[3px] cursor-pointer hover:bg-slate-300 focus-visible:bg-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${selected ? "font-bold text-slate-900" : "text-black"}`;

// Anchor every dropdown and message to the toolbar, regardless of the trigger's baseline.
export const toolbarPopupTopPx = (store: StoreContextModel): number => store.topToolbarHeightPx() + 5;
