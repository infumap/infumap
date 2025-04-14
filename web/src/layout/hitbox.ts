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


export enum HitboxFlags {
  None =                    0x000000,
  Click =                   0x000001,
  Move =                    0x000002,
  Resize =                  0x000004,
  OpenPopup =               0x000008,
  Attach =                  0x000010,
  HorizontalResize =        0x000020,
  OpenAttachment =          0x000040,
  AttachComposite =         0x000080,
  Anchor =                  0x000100,
  ShiftLeft =               0x000200,
  Settings =                0x000400,
  TriangleLinkSettings =    0x000800,
  ContentEditable =         0x001000,
  Expand =                  0x002000,
  TableColumnContextMenu =  0x004000,
  VerticalResize =          0x008000,
  Flip =                    0x010000,
  TimedFlip =               0x020000,
  Edit =                    0x040000,
  ShowPointer =             0x080000,
}

function hitboxFlagsToString(flags: HitboxFlags): string {
  let result = " ";
  if (flags & HitboxFlags.Click) { result += "Click "; }
  if (flags & HitboxFlags.Move) { result += "Move "; }
  if (flags & HitboxFlags.Resize) { result += "Resize "; }
  if (flags & HitboxFlags.OpenPopup) { result += "OpenPopup "; }
  if (flags & HitboxFlags.Attach) { result += "Attach "; }
  if (flags & HitboxFlags.HorizontalResize) { result += "HorizontalResize "; }
  if (flags & HitboxFlags.VerticalResize) { result += "VerticalResize "; }
  if (flags & HitboxFlags.OpenAttachment) { result += "OpenAttachment "; }
  if (flags & HitboxFlags.AttachComposite) { result += "AttachComposite "; }
  if (flags & HitboxFlags.Anchor) { result += "Anchor "; }
  if (flags & HitboxFlags.ShiftLeft) { result += "ShiftLeft "; }
  if (flags & HitboxFlags.Settings) { result += "Settings "; }
  if (flags & HitboxFlags.TriangleLinkSettings) { result += "TriangleLinkSettings "; }
  if (flags & HitboxFlags.ContentEditable) { result += "ContentEditable "; }
  if (flags & HitboxFlags.Expand) { result += "Expand "; }
  if (flags & HitboxFlags.TableColumnContextMenu) { result += "TableColumnContextMenu "; }
  if (flags & HitboxFlags.Flip) { result += "Flip "; }
  if (flags & HitboxFlags.TimedFlip) { result += "TimedFlip "; }
  if (flags & HitboxFlags.Edit) { result += "Edit"; }
  if (flags & HitboxFlags.ShowPointer) { result += "ShowPointer "; }
  result += "(" + flags + ")";
  return result;
}

export interface Hitbox {
  type: HitboxFlags,
  boundsPx: BoundingBox,
  meta: HitboxMeta | null,
}

export interface HitboxMeta {
  colNum?: number,
  startBl?: number,
  endBl?: number,
}

export const HitboxFns = {
  create: (type: HitboxFlags, boundsPx: BoundingBox, meta?: HitboxMeta ) => {
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
    if (typeof(meta.colNum) != 'undefined') {
      result.colNum = meta.colNum;
    }
    if (typeof(meta.startBl) != 'undefined') {
      result.startBl = meta.startBl;
    }
    if (typeof(meta.endBl) != 'undefined') {
      result.endBl = meta.endBl;
    }
    return result;
  },
  
  compare: (a: Hitbox, b: Hitbox): number => {
    if (a.type != b.type) { return 1; }
    if (a.meta != b.meta) {
      if (a.meta == null || b.meta == null) { return 1; }
      if (a.meta.colNum != b.meta.colNum) { return 1; }
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
  
  hitboxFlagsToString: (flags: HitboxFlags): string => {
    return hitboxFlagsToString(flags);
  },

  hitboxMetaToString: (meta: HitboxMeta): string => {
    return "[colNum: " +
      (meta.colNum ? meta.colNum : "undefined") + ", startBl: " +
      (meta.startBl ? meta.startBl : "undefined") + ", endBl: " +
      (meta.endBl ? meta.endBl : "undefined") + "]";
  }
}
