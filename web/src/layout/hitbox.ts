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
import { Uid } from "../util/uid";
import { VisualElementPath } from "./visual-element";


export enum HitboxFlags {
  None = 0x000000,
  Click = 0x000001,
  Move = 0x000002,
  Resize = 0x000004,
  OpenPopup = 0x000008,
  Attach = 0x000010,
  HorizontalResize = 0x000020,
  OpenAttachment = 0x000040,
  AttachComposite = 0x000080,
  AnchorChild = 0x000100,
  ShiftLeft = 0x000200,
  Settings = 0x000400,
  TriangleLinkSettings = 0x000800,
  ContentEditable = 0x001000,
  Expand = 0x002000,
  TableColumnContextMenu = 0x004000,
  VerticalResize = 0x008000,
  ShowPointer = 0x010000,
  AnchorDefault = 0x040000,
  CalendarRangeResize = 0x080000,
}

export function hitboxFlagsToString(flags: HitboxFlags): string {
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
  if (flags & HitboxFlags.AnchorChild) { result += "AnchorChild "; }
  if (flags & HitboxFlags.AnchorDefault) { result += "AnchorDefault "; }
  if (flags & HitboxFlags.ShiftLeft) { result += "ShiftLeft "; }
  if (flags & HitboxFlags.Settings) { result += "Settings "; }
  if (flags & HitboxFlags.TriangleLinkSettings) { result += "TriangleLinkSettings "; }
  if (flags & HitboxFlags.ContentEditable) { result += "ContentEditable "; }
  if (flags & HitboxFlags.Expand) { result += "Expand "; }
  if (flags & HitboxFlags.TableColumnContextMenu) { result += "TableColumnContextMenu "; }
  if (flags & HitboxFlags.ShowPointer) { result += "ShowPointer "; }
  if (flags & HitboxFlags.CalendarRangeResize) { result += "CalendarRangeResize "; }
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
  catalogRowNumber?: number,
  searchGridCellIndex?: number,
  startBl?: number,
  endBl?: number,
  focusOnly?: boolean,
  openActualItem?: boolean,
  openContainingPageOfItemId?: Uid,
  allowOutsideBounds?: boolean,
  compositeMoveOut?: boolean,
  compositeContentCollapse?: boolean,
  popupTitleTargetPath?: VisualElementPath,
  calendarDividerMonth?: number,
  calendarRangeItemId?: Uid,
  calendarRangeOccurrenceItemId?: Uid,
  calendarRangeStartDateTime?: number,
}

export const HitboxFns = {
  create: (type: HitboxFlags, boundsPx: BoundingBox, meta?: HitboxMeta) => {
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
    if (typeof (meta.colNum) != 'undefined') {
      result.colNum = meta.colNum;
    }
    if (typeof (meta.catalogRowNumber) != 'undefined') {
      result.catalogRowNumber = meta.catalogRowNumber;
    }
    if (typeof (meta.searchGridCellIndex) != 'undefined') {
      result.searchGridCellIndex = meta.searchGridCellIndex;
    }
    if (typeof (meta.startBl) != 'undefined') {
      result.startBl = meta.startBl;
    }
    if (typeof (meta.endBl) != 'undefined') {
      result.endBl = meta.endBl;
    }
    if (typeof (meta.focusOnly) != 'undefined') {
      result.focusOnly = meta.focusOnly;
    }
    if (typeof (meta.openActualItem) != 'undefined') {
      result.openActualItem = meta.openActualItem;
    }
    if (typeof (meta.openContainingPageOfItemId) != 'undefined') {
      result.openContainingPageOfItemId = meta.openContainingPageOfItemId;
    }
    if (typeof (meta.allowOutsideBounds) != 'undefined') {
      result.allowOutsideBounds = meta.allowOutsideBounds;
    }
    if (typeof (meta.compositeMoveOut) != 'undefined') {
      result.compositeMoveOut = meta.compositeMoveOut;
    }
    if (typeof (meta.compositeContentCollapse) != 'undefined') {
      result.compositeContentCollapse = meta.compositeContentCollapse;
    }
    if (typeof (meta.popupTitleTargetPath) != 'undefined') {
      result.popupTitleTargetPath = meta.popupTitleTargetPath;
    }
    if (typeof (meta.calendarDividerMonth) != 'undefined') {
      result.calendarDividerMonth = meta.calendarDividerMonth;
    }
    if (typeof (meta.calendarRangeItemId) != 'undefined') {
      result.calendarRangeItemId = meta.calendarRangeItemId;
    }
    if (typeof (meta.calendarRangeOccurrenceItemId) != 'undefined') {
      result.calendarRangeOccurrenceItemId = meta.calendarRangeOccurrenceItemId;
    }
    if (typeof (meta.calendarRangeStartDateTime) != 'undefined') {
      result.calendarRangeStartDateTime = meta.calendarRangeStartDateTime;
    }
    return result;
  },

  compare: (a: Hitbox, b: Hitbox): number => {
    if (a.type != b.type) { return 1; }
    if (a.meta != b.meta) {
      if (a.meta == null || b.meta == null) { return 1; }
      if (a.meta.colNum != b.meta.colNum) { return 1; }
      if (a.meta.calendarRangeItemId != b.meta.calendarRangeItemId) { return 1; }
      if (a.meta.calendarRangeOccurrenceItemId != b.meta.calendarRangeOccurrenceItemId) { return 1; }
      if (a.meta.calendarRangeStartDateTime != b.meta.calendarRangeStartDateTime) { return 1; }
    }
    return compareBoundingBox(a.boundsPx, b.boundsPx);
  },

  ArrayCompare: (a: Array<Hitbox>, b: Array<Hitbox>): number => {
    if (a.length != b.length) { return 1; }
    for (let i = 0; i < a.length; ++i) {
      if (HitboxFns.compare(a[i], b[i]) == 1) { return 1; }
    }
    return 0;
  },

  hitboxFlagsToString: (flags: HitboxFlags): string => {
    return hitboxFlagsToString(flags);
  },

  hitboxMetaToString: (meta: HitboxMeta): string => {
    return "[colNum: " +
      (typeof meta.colNum != "undefined" ? meta.colNum : "undefined") + ", catalogRowNumber: " +
      (typeof meta.catalogRowNumber != "undefined" ? meta.catalogRowNumber : "undefined") + ", searchGridCellIndex: " +
      (typeof meta.searchGridCellIndex != "undefined" ? meta.searchGridCellIndex : "undefined") + ", startBl: " +
      (meta.startBl ? meta.startBl : "undefined") + ", endBl: " +
      (meta.endBl ? meta.endBl : "undefined") + ", openActualItem: " +
      (meta.openActualItem ? meta.openActualItem : "undefined") + ", allowOutsideBounds: " +
      (meta.allowOutsideBounds ? meta.allowOutsideBounds : "undefined") + ", compositeMoveOut: " +
      (meta.compositeMoveOut ? meta.compositeMoveOut : "undefined") + ", compositeContentCollapse: " +
      (meta.compositeContentCollapse ? meta.compositeContentCollapse : "undefined") + ", popupTitleTargetPath: " +
      (meta.popupTitleTargetPath ? meta.popupTitleTargetPath : "undefined") + ", dividerMonth: " +
      (meta.calendarDividerMonth ? meta.calendarDividerMonth : "undefined") + ", calendarRangeItemId: " +
      (meta.calendarRangeItemId ? meta.calendarRangeItemId : "undefined") + ", calendarRangeOccurrenceItemId: " +
      (meta.calendarRangeOccurrenceItemId ? meta.calendarRangeOccurrenceItemId : "undefined") + ", calendarRangeStartDateTime: " +
      (meta.calendarRangeStartDateTime ?? "undefined") + "]";
  }
}
