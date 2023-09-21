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

import { BoundingBox, cloneBoundingBox, compareBoundingBox } from "../util/geometry";


export enum HitboxType {
  None =            0x000,
  Click =           0x001,
  Move =            0x002,
  Resize =          0x004,
  OpenPopup =       0x008,
  Attach =          0x010,
  ColResize =       0x020,
  OpenAttachment =  0x040,
  AttachComposite = 0x080,
}

export interface Hitbox {
  type: HitboxType,
  boundsPx: BoundingBox,
  meta: HitboxMeta | null,
}

export interface HitboxMeta {
  resizeColNumber?: number
}

export const HitboxFns = {
  create: (type: HitboxType, boundsPx: BoundingBox, meta?: HitboxMeta ) => {
    return ({ type, boundsPx, meta: (typeof meta !== 'undefined') ? meta : null });
  },
  
  clone: (hitbox: Hitbox | null): Hitbox | null => {
    if (hitbox == null) { return null; }
    return {
      type: hitbox.type,
      boundsPx: cloneBoundingBox(hitbox.boundsPx)!,
      meta: hitbox.meta == null ? null : Object.assign({}, hitbox.meta) as HitboxMeta
    };
  },
  
  createMeta: (meta: HitboxMeta) => {
    let result: HitboxMeta = {};
    if (typeof(meta.resizeColNumber) != 'undefined') { result.resizeColNumber = meta.resizeColNumber; }
    return result;
  },
  
  compare: (a: Hitbox, b: Hitbox): number => {
    if (a.type != b.type) { return 1; }
    if (a.meta != b.meta) {
      if (a.meta == null || b.meta == null) { return 1; }
      if (a.meta.resizeColNumber != b.meta.resizeColNumber) { return 1; }
    }
    return compareBoundingBox(a.boundsPx, b.boundsPx);
  },
  
  ArrayCompare: (a: Array<Hitbox>, b: Array<Hitbox>): number => {
    if (a.length != b.length) { return 1; }
    for (let i=0; i<a.length; ++i) {
      if (HitboxFns.compare(a[i], b[i]) == 1) { return 1; }
    }
    return 0;
  },
  
}
