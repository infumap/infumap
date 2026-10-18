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

// The toolbar's divider lines are fixed, positioned from the window's right edge. TODO (LOW): don't use fixed layout.

const ICON_BUTTON_WIDTH_PX = 24; // InfuIconButton: 21px wide, 3px left margin.

/**
 * Before the right-most icons: user, help, network status, hide toolbar. Midway between the icon either side, so it
 * allows for each button's 3px left margin.
 */
export const TOOLBAR_RIGHT_DIVIDER_RIGHT_PX = 8 + 4 * ICON_BUTTON_WIDTH_PX + 5;

/** Before an item's info and id buttons, midway between the info button and the 16px of space left of it. */
export const TOOLBAR_INFO_DIVIDER_RIGHT_PX = TOOLBAR_RIGHT_DIVIDER_RIGHT_PX + 63;

/** As TOOLBAR_INFO_DIVIDER_RIGHT_PX, with one more button (e.g. download) before the info button. */
export const TOOLBAR_INFO_DIVIDER_WITH_EXTRA_BUTTON_RIGHT_PX = TOOLBAR_INFO_DIVIDER_RIGHT_PX + ICON_BUTTON_WIDTH_PX;
