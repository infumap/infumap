/*
  Copyright (C) 2022-2023 The Infumap Authors
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


export enum HitboxType {
  None = 0,
  Click = 1,
  Move = 2,
  Resize = 4,
  OpenPopup = 8,
  Attach = 16,
}

export interface Hitbox {
  type: HitboxType,
  boundsPx: BoundingBox,
}

export function cloneHitbox(hitbox: Hitbox | null): Hitbox | null {
  if (hitbox == null) { return null; }
  return {
    type: hitbox.type,
    boundsPx: cloneBoundingBox(hitbox.boundsPx)!
  };
}

export function cloneHitboxes(hitboxes: Array<Hitbox> |  null): Array<Hitbox> | null {
  if (hitboxes == null) { return null; }
  return hitboxes.map(h => cloneHitbox(h)!)
}
