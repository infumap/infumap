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

import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { Hitbox, HitboxFlags, HitboxFns } from '../layout/hitbox';
import { compositeMoveOutHitboxBoundsPx } from '../layout/composite-move-out';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, AttachmentsMixin, calcGeometryOfAttachmentItemImpl, calcSpatialAttachmentHitboxBoundsPx } from './base/attachments-item';
import { itemCanEdit, normalizeItemCapabilities } from './base/capabilities-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { TitledItem, TitledMixin } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { YSizableItem, YSizableMixin } from './base/y-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { FlagsItem, FlagsMixin, NoteFlags } from './base/flags-item';
import { VeFns, VisualElement } from '../layout/visual-element';
import { StoreContextModel } from '../store/StoreProvider';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe, isInsidePopupHierarchy } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';
import { desktopPopupIconTextIndentPx, measureLineCount } from '../layout/text';
import { arrangeNow, requestArrange } from '../layout/arrange';
import { FormatMixin } from './base/format-item';
import { closestCaretPositionToClientPx, setCaretPosition } from '../util/caret';
import { CursorEventState } from '../input/state';
import { VesCache } from '../layout/ves-cache';
import { isNumeric } from '../util/math';
import { IconMixin, ItemIconMode, ItemIconRenderContext, iconRenderContextFromVisualElement, itemIconKind, itemIconModeFromObject, listItemIconRenderContext } from './base/icon-item';


export interface NoteItem extends NoteMeasurable, XSizableItem, YSizableItem, AttachmentsItem, TitledItem {
  url: string,
}

export interface NoteMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, TitledMixin, FlagsMixin, FormatMixin, AttachmentsMixin, IconMixin {
  inlineMarks: Array<NoteInlineMark>,
}

export { ItemIconMode, ItemIconRenderContext };

export enum NoteInlineMarkFlags {
  Bold = 0x001,
  Italic = 0x002,
}

export interface NoteInlineMark {
  start: number,
  end: number,
  flags: number,
}

export interface NoteInlineTextSegment {
  text: string,
  flags: number,
}

export const NoteTextStyle = {
  Normal: "normal",
  Heading1: "h1",
  Heading2: "h2",
  Heading3: "h3",
  Heading4: "h4",
  Bullet: "bullet",
  Code: "code",
} as const;

export type NoteTextStyle = typeof NoteTextStyle[keyof typeof NoteTextStyle];

export const NOTE_INLINE_MARK_ALLOWED_FLAGS = NoteInlineMarkFlags.Bold | NoteInlineMarkFlags.Italic;

export function normalizeNoteInlineMarks(inlineMarks: Array<NoteInlineMark>, text: string): Array<NoteInlineMark> {
  const textLen = text.length;
  const normalized = inlineMarks
    .map(mark => ({
      start: Math.trunc(mark.start),
      end: Math.trunc(mark.end),
      flags: Math.trunc(mark.flags),
    }))
    .filter(mark =>
      Number.isFinite(mark.start) &&
      Number.isFinite(mark.end) &&
      Number.isFinite(mark.flags) &&
      mark.start >= 0 &&
      mark.start < mark.end &&
      mark.end <= textLen &&
      mark.flags != 0 &&
      (mark.flags & ~NOTE_INLINE_MARK_ALLOWED_FLAGS) == 0)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.flags - b.flags);

  const result: Array<NoteInlineMark> = [];
  for (const mark of normalized) {
    const last = result[result.length - 1];
    if (last && mark.start < last.end) { continue; }
    if (last && mark.start == last.end && mark.flags == last.flags) {
      last.end = mark.end;
    } else {
      result.push(mark);
    }
  }
  return result;
}

function unpackNoteInlineMarks(value: unknown, text: string): Array<NoteInlineMark> {
  if (!Array.isArray(value) || value.length % 3 != 0) { return []; }
  const marks: Array<NoteInlineMark> = [];
  for (let i = 0; i < value.length; i += 3) {
    const start = value[i];
    const end = value[i + 1];
    const flags = value[i + 2];
    if (typeof start != "number" || typeof end != "number" || typeof flags != "number") { return []; }
    marks.push({ start, end, flags });
  }
  return normalizeNoteInlineMarks(marks, text);
}

function packNoteInlineMarks(inlineMarks: Array<NoteInlineMark>, text: string): Array<number> {
  return normalizeNoteInlineMarks(inlineMarks, text).flatMap(mark => [mark.start, mark.end, mark.flags]);
}

function clampTextOffset(text: string, offset: number): number {
  return Math.max(0, Math.min(Math.trunc(offset), text.length));
}

function flagsForInlineMarkInterval(inlineMarks: Array<NoteInlineMark>, start: number, end: number): number {
  for (const mark of inlineMarks) {
    if (mark.start <= start && mark.end >= end) {
      return mark.flags;
    }
    if (mark.start > start) {
      return 0;
    }
  }
  return 0;
}

export function noteInlineFlagsAtPosition(inlineMarks: Array<NoteInlineMark>, text: string, position: number): number {
  const normalized = normalizeNoteInlineMarks(inlineMarks, text);
  const pos = clampTextOffset(text, position);

  for (const mark of normalized) {
    if (mark.start <= pos && pos < mark.end) {
      return mark.flags;
    }
  }

  if (pos > 0) {
    for (const mark of normalized) {
      if (mark.start < pos && pos <= mark.end) {
        return mark.flags;
      }
    }
  }

  return 0;
}

export function noteInlineFlagsForRange(
  inlineMarks: Array<NoteInlineMark>,
  text: string,
  start: number,
  end: number,
): number {
  const normalized = normalizeNoteInlineMarks(inlineMarks, text);
  const rangeStart = clampTextOffset(text, Math.min(start, end));
  const rangeEnd = clampTextOffset(text, Math.max(start, end));
  if (rangeStart == rangeEnd) {
    return noteInlineFlagsAtPosition(normalized, text, rangeStart);
  }

  let result = NOTE_INLINE_MARK_ALLOWED_FLAGS;
  let pos = rangeStart;
  while (pos < rangeEnd) {
    const coveringMark = normalized.find(mark => mark.start <= pos && pos < mark.end);
    if (coveringMark == null) {
      return 0;
    }
    result &= coveringMark.flags;
    if (result == 0) {
      return 0;
    }
    pos = Math.min(rangeEnd, coveringMark.end);
  }
  return result;
}

export function setNoteInlineMarkFlag(
  inlineMarks: Array<NoteInlineMark>,
  text: string,
  start: number,
  end: number,
  flag: NoteInlineMarkFlags,
  enabled: boolean,
): Array<NoteInlineMark> {
  if ((flag & NOTE_INLINE_MARK_ALLOWED_FLAGS) == 0) {
    return normalizeNoteInlineMarks(inlineMarks, text);
  }

  const normalized = normalizeNoteInlineMarks(inlineMarks, text);
  const rangeStart = clampTextOffset(text, Math.min(start, end));
  const rangeEnd = clampTextOffset(text, Math.max(start, end));
  if (rangeStart == rangeEnd) {
    return normalized;
  }

  const boundaries = new Set<number>([0, text.length, rangeStart, rangeEnd]);
  for (const mark of normalized) {
    boundaries.add(mark.start);
    boundaries.add(mark.end);
  }
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);

  const result: Array<NoteInlineMark> = [];
  for (let i = 0; i < sortedBoundaries.length - 1; ++i) {
    const intervalStart = sortedBoundaries[i];
    const intervalEnd = sortedBoundaries[i + 1];
    if (intervalStart == intervalEnd) { continue; }

    let flags = flagsForInlineMarkInterval(normalized, intervalStart, intervalEnd);
    if (intervalStart >= rangeStart && intervalEnd <= rangeEnd) {
      flags = enabled ? flags | flag : flags & ~flag;
    }
    if (flags != 0) {
      result.push({ start: intervalStart, end: intervalEnd, flags });
    }
  }

  return normalizeNoteInlineMarks(result, text);
}

export function toggleNoteInlineMarkFlag(
  inlineMarks: Array<NoteInlineMark>,
  text: string,
  start: number,
  end: number,
  flag: NoteInlineMarkFlags,
): Array<NoteInlineMark> {
  const rangeFlags = noteInlineFlagsForRange(inlineMarks, text, start, end);
  return setNoteInlineMarkFlag(inlineMarks, text, start, end, flag, (rangeFlags & flag) == 0);
}

export function updateNoteInlineMarksForTextChange(
  inlineMarks: Array<NoteInlineMark>,
  oldText: string,
  newText: string,
  insertedFlags: number,
): Array<NoteInlineMark> {
  const normalized = normalizeNoteInlineMarks(inlineMarks, oldText);

  let prefixLength = 0;
  while (
    prefixLength < oldText.length &&
    prefixLength < newText.length &&
    oldText[prefixLength] == newText[prefixLength]
  ) {
    ++prefixLength;
  }

  let oldSuffixStart = oldText.length;
  let newSuffixStart = newText.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldText[oldSuffixStart - 1] == newText[newSuffixStart - 1]
  ) {
    --oldSuffixStart;
    --newSuffixStart;
  }

  const oldRangeStart = prefixLength;
  const oldRangeEnd = oldSuffixStart;
  const newRangeStart = prefixLength;
  const newRangeEnd = newSuffixStart;
  const delta = (newRangeEnd - newRangeStart) - (oldRangeEnd - oldRangeStart);

  const result: Array<NoteInlineMark> = [];
  for (const mark of normalized) {
    if (mark.end <= oldRangeStart) {
      result.push({ ...mark });
    } else if (mark.start >= oldRangeEnd) {
      result.push({ start: mark.start + delta, end: mark.end + delta, flags: mark.flags });
    } else {
      if (mark.start < oldRangeStart) {
        result.push({ start: mark.start, end: oldRangeStart, flags: mark.flags });
      }
      if (mark.end > oldRangeEnd) {
        result.push({ start: newRangeEnd, end: mark.end + delta, flags: mark.flags });
      }
    }
  }

  const insertedLength = newRangeEnd - newRangeStart;
  const appliedInsertedFlags = insertedFlags & NOTE_INLINE_MARK_ALLOWED_FLAGS;
  if (insertedLength > 0 && appliedInsertedFlags != 0) {
    result.push({ start: newRangeStart, end: newRangeEnd, flags: appliedInsertedFlags });
  }

  return normalizeNoteInlineMarks(result, newText);
}

export function splitNoteInlineMarks(
  inlineMarks: Array<NoteInlineMark>,
  text: string,
  splitOffset: number,
): [Array<NoteInlineMark>, Array<NoteInlineMark>] {
  const split = clampTextOffset(text, splitOffset);
  const left: Array<NoteInlineMark> = [];
  const right: Array<NoteInlineMark> = [];
  for (const mark of normalizeNoteInlineMarks(inlineMarks, text)) {
    if (mark.end <= split) {
      left.push({ ...mark });
    } else if (mark.start >= split) {
      right.push({ start: mark.start - split, end: mark.end - split, flags: mark.flags });
    } else {
      left.push({ start: mark.start, end: split, flags: mark.flags });
      right.push({ start: 0, end: mark.end - split, flags: mark.flags });
    }
  }
  return [
    normalizeNoteInlineMarks(left, text.substring(0, split)),
    normalizeNoteInlineMarks(right, text.substring(split)),
  ];
}

export function concatNoteInlineMarks(
  leftMarks: Array<NoteInlineMark>,
  leftText: string,
  rightMarks: Array<NoteInlineMark>,
  rightText: string,
): Array<NoteInlineMark> {
  const shiftedRightMarks = normalizeNoteInlineMarks(rightMarks, rightText)
    .map(mark => ({ start: mark.start + leftText.length, end: mark.end + leftText.length, flags: mark.flags }));
  return normalizeNoteInlineMarks([...normalizeNoteInlineMarks(leftMarks, leftText), ...shiftedRightMarks], leftText + rightText);
}

export function noteInlineTextSegments(inlineMarks: Array<NoteInlineMark>, text: string): Array<NoteInlineTextSegment> {
  const segments: Array<NoteInlineTextSegment> = [];
  let pos = 0;
  for (const mark of normalizeNoteInlineMarks(inlineMarks, text)) {
    if (mark.start > pos) {
      segments.push({ text: text.substring(pos, mark.start), flags: 0 });
    }
    segments.push({ text: text.substring(mark.start, mark.end), flags: mark.flags });
    pos = mark.end;
  }
  if (pos < text.length) {
    segments.push({ text: text.substring(pos), flags: 0 });
  }
  return segments;
}

function noteHasFaviconUrl(note: NoteItem): boolean {
  return !!note.url?.trim();
}

function noteIconKind(note: NoteMeasurable, context: ItemIconRenderContext): ItemIconMode.None | ItemIconMode.Symbol | ItemIconMode.Favicon {
  const hasFaviconUrl = "url" in note && noteHasFaviconUrl(note as NoteItem);
  if (note.iconMode == ItemIconMode.Auto && hasFaviconUrl && context != ItemIconRenderContext.TableAttachment) {
    return ItemIconMode.Favicon;
  }
  return itemIconKind(note.iconMode, context, hasFaviconUrl);
}


export const NoteFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): NoteItem => {
    if (parentId == EMPTY_UID) { panic("NoteFns.create: parent is empty."); }
    return {
      origin: null,
      itemType: ItemType.Note,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      groupId: null,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      ordering,
      title,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 10.0 * GRID_SIZE,
      spatialHeightGr: 0,

      flags: NoteFlags.None,

      format: "",

      url: "",
      emoji: null,
      iconMode: ItemIconMode.Auto,
      inlineMarks: [],

      computed_attachments: [],
    };
  },

  fromObject: (o: any, origin: string | null): NoteItem => {
    // TODO (LOW): dynamic type check of o.
    // TODO (LOW): check flags field.
    return ({
      origin,
      capabilities: normalizeItemCapabilities(o.capabilities),
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId,
      relationshipToParent: o.relationshipToParent,
      groupId: o.groupId ?? null,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      dateTime: o.dateTime,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,
      spatialHeightGr: o.spatialHeightGr || 0,

      flags: o.flags,

      url: o.url ?? "",
      emoji: o.emoji || null,
      iconMode: itemIconModeFromObject(o, true),
      inlineMarks: unpackNoteInlineMarks(o.inlineMarks ?? [], o.title),
      format: o.format,

      computed_attachments: [],
    });
  },

  toObject: (n: NoteItem): object => {
    return ({
      itemType: n.itemType,
      ownerId: n.ownerId,
      id: n.id,
      parentId: n.parentId,
      relationshipToParent: n.relationshipToParent,
      groupId: n.groupId,
      creationDate: n.creationDate,
      lastModifiedDate: n.lastModifiedDate,
      dateTime: n.dateTime,
      ordering: Array.from(n.ordering),
      title: n.title,
      spatialPositionGr: n.spatialPositionGr,

      spatialWidthGr: n.spatialWidthGr,
      spatialHeightGr: n.spatialHeightGr,

      flags: n.flags,

      url: n.url,
      emoji: n.emoji,
      iconMode: n.iconMode,
      inlineMarks: packNoteInlineMarks(n.inlineMarks, n.title),
      format: n.format,
    });
  },

  calcSpatialDimensionsBl: (note: NoteMeasurable, ignoreExplicitHeight: boolean = false, iconContext: ItemIconRenderContext = ItemIconRenderContext.Spatial): Dimensions => {
    if (!ignoreExplicitHeight && (note.flags & NoteFlags.ExplicitHeight) && note.spatialHeightGr > 0) {
      return { w: note.spatialWidthGr / GRID_SIZE, h: note.spatialHeightGr / GRID_SIZE };
    }
    const formattedTitle = NoteFns.noteFormatMaybe(note.title, note.format);
    const widthBl = note.spatialWidthGr / GRID_SIZE;
    const textIndentPx = NoteFns.showsIcon(note, iconContext) ? desktopPopupIconTextIndentPx(widthBl) : 0;
    let measuredHeightBl = measureLineCount(formattedTitle, widthBl, note.flags, textIndentPx);
    if (measuredHeightBl < 1) { measuredHeightBl = 1; }

    // measureLineCount already measures using the style's actual line-height,
    // so headings should not be scaled a second time here.
    return { w: note.spatialWidthGr / GRID_SIZE, h: measuredHeightBl };
  },

  calcGeometry_Spatial: (note: NoteMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean): ItemGeometry => {
    const ignoreExplicitHeight = isPopup && !(note.flags & NoteFlags.ExplicitHeight);
    const sizeBl = NoteFns.calcSpatialDimensionsBl(note, ignoreExplicitHeight);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (note.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (note.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes: Array<Hitbox> = [];
    if (emitHitboxes && NoteFns.showsIcon(note, ItemIconRenderContext.Spatial)) {
      hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, { x: 0, y: 0, w: blockSizePx.w, h: blockSizePx.h }));
    }
    if (emitHitboxes) {
      hitboxes.push(
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.ContentEditable, innerBoundsPx),
        HitboxFns.create(
          HitboxFlags.Attach,
          calcSpatialAttachmentHitboxBoundsPx(innerBoundsPx, blockSizePx.w, blockSizePx.h, note.computed_attachments.length),
        ),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      );
    }
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes,
    }
  },

  calcGeometry_InComposite: (measurable: NoteMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = NoteFns.calcSpatialDimensionsBl(cloned, true);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveAreaBoundsPx = {
      x: innerBoundsPx.w
        - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
        - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
        - CONTAINER_IN_COMPOSITE_PADDING_PX
        - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2)
    };
    const moveBoundsPx = compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx, leftMarginBl == 0 ? 2 : 0);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ShowPointer, moveBoundsPx, { compositeMoveOut: true }),
        HitboxFns.create(
          HitboxFlags.Attach,
          calcSpatialAttachmentHitboxBoundsPx(innerBoundsPx, blockSizePx.w, blockSizePx.h, measurable.computed_attachments.length),
        ),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_Attachment: (note: NoteMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(note, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (note: NoteMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, expandable: boolean, inTable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const iconContext = listItemIconRenderContext(inTable, !expandable);
    const showsIcon = NoteFns.showsIcon(note, iconContext);
    const clickAreaBoundsPx = {
      x: showsIcon ? blockSizePx.w : 0.0,
      y: 0.0,
      w: blockSizePx.w * (showsIcon ? widthBl - 1 : widthBl),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes = [
      HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
    ];
    if (showsIcon) {
      hitboxes.splice(1, 0, HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx));
    }
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes
    };
  },

  calcGeometry_InCell: (note: NoteMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = NoteFns.calcSpatialDimensionsBl(note);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes: Array<Hitbox> = [];
    if (NoteFns.showsIcon(note, ItemIconRenderContext.Spatial)) {
      hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, { x: 0, y: 0, w: blockSizePx.w, h: blockSizePx.h }));
    }
    hitboxes.push(
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    );
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes,
    });
  },

  asNoteMeasurable: (item: ItemTypeMixin): NoteMeasurable => {
    if (item.itemType == ItemType.Note) { return item as NoteMeasurable; }
    panic("not note measurable");
  },

  handleLinkClick: (visualElement: VisualElement): void => {
    window.open(asNoteItem(visualElement.displayItem).url, '_blank');
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel, forceEdit: boolean = false, caretAtEnd: boolean = false): void => {
    const handledByList = handleListPageLineItemClickMaybe(visualElement, store);
    if (!forceEdit && handledByList) { return; }
    const itemPath = VeFns.veToPath(visualElement);
    if (!itemCanEdit(visualElement.displayItem)) {
      if (!handledByList) {
        store.history.setFocus(itemPath);
        arrangeNow(store, "note-focus-only");
      }
      return;
    }
    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Note });
    const editingDomId = itemPath + ":title";
    const el = document.getElementById(editingDomId);
    const closestIdx = el instanceof HTMLElement
      ? (caretAtEnd ? el.innerText.length : closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx()))
      : 0;
    const clampedClosestIdx = Math.max(0, Math.min(closestIdx, asNoteItem(visualElement.displayItem).title.length));
    arrangeNow(store, "note-enter-edit-mode");
    const freshEl = document.getElementById(editingDomId);
    if (freshEl instanceof HTMLElement) {
      freshEl.focus();
      const caretPosition = caretAtEnd ? asNoteItem(visualElement.displayItem).title.length : clampedClosestIdx;
      setCaretPosition(freshEl, caretPosition);
      store.overlay.noteTextSelectionInfo.set({
        itemPath,
        start: caretPosition,
        end: caretPosition,
        typingFlags: noteInlineFlagsAtPosition(asNoteItem(visualElement.displayItem).inlineMarks, asNoteItem(visualElement.displayItem).title, caretPosition),
      });
      store.touchToolbar();
    } else {
      console.warn("Could not enter note edit mode because the text element no longer exists", { itemPath });
      store.overlay.setTextEditInfo(store.history, null);
    }
  },

  handlePopupClick: (visualElement: VisualElement, store: StoreContextModel, _isFromAttachment?: boolean): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if (isInsidePopupHierarchy(visualElement)) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    } else {
      store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    }
    requestArrange(store, "item-popup-open");
  },

  cloneMeasurableFields: (note: NoteMeasurable): NoteMeasurable => {
    return ({
      itemType: note.itemType,
      spatialPositionGr: note.spatialPositionGr,
      spatialWidthGr: note.spatialWidthGr,
      spatialHeightGr: note.spatialHeightGr,
      title: note.title,
      computed_attachments: note.computed_attachments,
      flags: note.flags,
      format: note.format,
      inlineMarks: normalizeNoteInlineMarks(note.inlineMarks, note.title),
      emoji: note.emoji,
      iconMode: note.iconMode,
    });
  },

  debugSummary: (noteItem: NoteItem) => {
    return "[note] " + noteItem.title;
  },

  getFingerprint: (noteItem: NoteItem): string => {
    return noteItem.title + "~~~!@#~~~" + noteItem.url + "~~~!@#~~~" + noteItem.flags + "~~~!@#~~~" + noteItem.format +
      "~~~!@#~~~" + packNoteInlineMarks(noteItem.inlineMarks, noteItem.title).join(",") +
      "~~~!@#~~~" + (noteItem.emoji || "") + "~~~!@#~~~" + noteItem.iconMode;
  },

  isStyleNormalText: (flagsItem: FlagsItem): boolean => {
    return (
      !(flagsItem.flags & NoteFlags.Heading1) &&
      !(flagsItem.flags & NoteFlags.Heading2) &&
      !(flagsItem.flags & NoteFlags.Heading3) &&
      !(flagsItem.flags & NoteFlags.Heading4) &&
      !(flagsItem.flags & NoteFlags.Bullet1) &&
      !(flagsItem.flags & NoteFlags.Code)
    );
  },

  textStyle: (flagsItem: FlagsItem): NoteTextStyle => {
    if (flagsItem.flags & NoteFlags.Heading1) { return NoteTextStyle.Heading1; }
    if (flagsItem.flags & NoteFlags.Heading2) { return NoteTextStyle.Heading2; }
    if (flagsItem.flags & NoteFlags.Heading3) { return NoteTextStyle.Heading3; }
    if (flagsItem.flags & NoteFlags.Heading4) { return NoteTextStyle.Heading4; }
    if (flagsItem.flags & NoteFlags.Bullet1) { return NoteTextStyle.Bullet; }
    if (flagsItem.flags & NoteFlags.Code) { return NoteTextStyle.Code; }
    return NoteTextStyle.Normal;
  },

  setTextStyle: (flagsItem: FlagsItem, textStyle: NoteTextStyle): void => {
    NoteFns.clearTextStyleFlags(flagsItem);
    if (textStyle == NoteTextStyle.Heading1) {
      flagsItem.flags |= NoteFlags.Heading1;
    } else if (textStyle == NoteTextStyle.Heading2) {
      flagsItem.flags |= NoteFlags.Heading2;
    } else if (textStyle == NoteTextStyle.Heading3) {
      flagsItem.flags |= NoteFlags.Heading3;
    } else if (textStyle == NoteTextStyle.Heading4) {
      flagsItem.flags |= NoteFlags.Heading4;
    } else if (textStyle == NoteTextStyle.Bullet) {
      flagsItem.flags |= NoteFlags.Bullet1;
    } else if (textStyle == NoteTextStyle.Code) {
      flagsItem.flags |= NoteFlags.Code;
    }
  },

  isAlignedLeft: (flagsItem: FlagsItem): boolean => {
    return (
      !(flagsItem.flags & NoteFlags.AlignCenter) &&
      !(flagsItem.flags & NoteFlags.AlignJustify) &&
      !(flagsItem.flags & NoteFlags.AlignRight)
    );
  },

  iconRenderContextFromVisualElement,

  showsIcon: (note: NoteMeasurable, context: ItemIconRenderContext = ItemIconRenderContext.Spatial): boolean => {
    return noteIconKind(note, context) != ItemIconMode.None;
  },

  emoji: (note: NoteMeasurable, context: ItemIconRenderContext = ItemIconRenderContext.Spatial): string | null => {
    if (noteIconKind(note, context) != ItemIconMode.Symbol) { return null; }
    const emoji = note.emoji?.trim();
    return emoji && emoji != "" ? emoji : null;
  },

  faviconPath: (note: NoteItem, context: ItemIconRenderContext = ItemIconRenderContext.Spatial): string | null => {
    if (noteIconKind(note, context) != ItemIconMode.Favicon) { return null; }
    const url = note.url?.trim();
    if (!url) { return null; }
    return `/favicons/${note.id}?u=${encodeURIComponent(url)}`;
  },

  clearTextStyleFlags: (flagsItem: FlagsItem): void => {
    flagsItem.flags &= ~NoteFlags.Heading1;
    flagsItem.flags &= ~NoteFlags.Heading2;
    flagsItem.flags &= ~NoteFlags.Heading3;
    flagsItem.flags &= ~NoteFlags.Heading4;
    flagsItem.flags &= ~NoteFlags.Bullet1;
    flagsItem.flags &= ~NoteFlags.Code;
  },

  clearAlignmentFlags: (flagsItem: FlagsItem): void => {
    flagsItem.flags &= ~NoteFlags.AlignCenter;
    flagsItem.flags &= ~NoteFlags.AlignRight;
    flagsItem.flags &= ~NoteFlags.AlignJustify;
  },

  hasUrl: (noteItem: NoteItem) => {
    return noteItem.url != null && noteItem.url != "" && noteItem.title != "";
  },

  // TODO (HIGH): something not naive.
  noteFormatMaybe: (text: string, format: string): string => {
    if (format == "") { return text; }
    if (!isNumeric(text)) { return text; }
    if (format == "0") { return Math.round(parseFloat(text)).toString(); }
    if (format == "0.0") { return parseFloat(text).toFixed(1); }
    if (format == "0.00") { return parseFloat(text).toFixed(2); }
    if (format == "0.000") { return parseFloat(text).toFixed(3); }
    if (format == "0.0000") { return parseFloat(text).toFixed(4); }
    if (format == "1,000") {
      return parseFloat(text).toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      });
    }
    if (format == "1,000.00") {
      return parseFloat(text).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }
    return text;
  }
};


export function isNote(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Note;
}

export function asNoteItem(item: ItemTypeMixin): NoteItem {
  if (item.itemType == ItemType.Note) { return item as NoteItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a note.`);
}
