/*
  Copyright (C) 2023 The Infumap Authors
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

import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { cloneHitbox, Hitbox } from "./hitbox";


export interface ItemGeometry {
  boundsPx: BoundingBox, // relative to containing render area.
  hitboxes: Array<Hitbox>, // higher index => takes precedence.
}

export function cloneItemGeometry(g: ItemGeometry | null): ItemGeometry | null {
  if (g == null) { return null; }
  return ({
    boundsPx: cloneBoundingBox(g.boundsPx)!,
    hitboxes: g.hitboxes.map(hb => cloneHitbox(hb)!)
  });
}
