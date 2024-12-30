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

export const EMPTY_UID: string =                 "00000000000000000000000000000000";
export const UMBRELLA_PAGE_UID: string =         "00000000000000000000000000000001";
export const POPUP_LINK_UID: string =            "00000000000000000000000000000002";
export const SOLO_ITEM_HOLDER_PAGE_UID: string = "00000000000000000000000000000003";

export function newUid(): Uid {
  return uuid.createV4().split('-').join('');
}

export function isUid(uidMaybe: string): boolean {
  if (uidMaybe.length != EMPTY_UID.length) { return false; }
  for (let i=0; i<uidMaybe.length; ++i) {
    const c = uidMaybe[i];
    if (c != "a" && c != "b" && c != "c" && c != "d" && c != "e" && c != "f" &&
        c != "0" && c != "1" && c != "2" && c != "3" && c != "4" && c != "5" && c != "6" && c != "7" && c != "8" && c != "9") {
      return false;
    }
  }
  return true;
}
