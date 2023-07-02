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

import { BoundingBox, cloneBoundingBox } from "../util/geometry";


export enum HitboxType {
  None =           0x000,
  Click =          0x001,
  Move =           0x002,
  Resize =         0x004,
  OpenPopup =      0x008,
  Attach =         0x010,
  ColResize =      0x020,
  OpenAttachment = 0x040,
}

export interface Hitbox {
  type: HitboxType,
  boundsPx: BoundingBox,
  meta: HitboxMeta | null,
}

export function createHitbox(type: HitboxType, boundsPx: BoundingBox, meta?: HitboxMeta ) {
  return ({ type, boundsPx, meta: (typeof meta !== 'undefined') ? meta : null });
}

export function cloneHitbox(hitbox: Hitbox | null): Hitbox | null {
  if (hitbox == null) { return null; }
  return {
    type: hitbox.type,
    boundsPx: cloneBoundingBox(hitbox.boundsPx)!,
    meta: hitbox.meta == null ? null : Object.assign({}, hitbox.meta) as HitboxMeta
  };
}

export function cloneHitboxes(hitboxes: Array<Hitbox> |  null): Array<Hitbox> | null {
  if (hitboxes == null) { return null; }
  return hitboxes.map(h => cloneHitbox(h)!)
}

export interface HitboxMeta {
  resizeColNumber?: number
}

export function createHitboxMeta(meta: HitboxMeta) {
  let result: HitboxMeta = {};
  if (typeof(meta.resizeColNumber) != 'undefined') { result.resizeColNumber = meta.resizeColNumber; }
  return result;
}
