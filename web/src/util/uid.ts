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

import { uuid } from "./uuid";

export type Uid = string;

export function newUid(): Uid {
  return uuid.createV4().split('-').join('');
}

export const EMPTY_UID: string =           "00000000000000000000000000000000";
export const TOP_LEVEL_PAGE_UID: string =  "00000000000000000000000000000001";
export const POPUP_LINK_UID: string =      "00000000000000000000000000000002";
