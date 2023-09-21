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

import { ATTACH_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX } from '../constants';
import { HitboxType, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemTypeMixin, ITEM_TYPE_NOTE, calcBoundsInCellFromSizeBl } from './base/item';
import { TitledItem, TitledMixin } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { measureLineCount } from '../util/html';
import { FlagsMixin, NoteFlags } from './base/flags-item';
import { VisualElement } from '../layout/visual-element';
import { DesktopStoreContextModel } from '../store/DesktopStoreProvider';
import { handleListPageLineItemClickMaybe } from './base/item-common';
import { cloneMeasurableFields } from './base/item-polymorphism';


export interface NoteItem extends NoteMeasurable, XSizableItem, AttachmentsItem, TitledItem {
  url: string,
}

export interface NoteMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin, FlagsMixin { }


export function newNoteItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): NoteItem {
  if (parentId == EMPTY_UID) { panic(); }
  return {
    itemType: ITEM_TYPE_NOTE,
    ownerId,
    id: newUid(),
    parentId,
    relationshipToParent,
    creationDate: currentUnixTimeSeconds(),
    lastModifiedDate: currentUnixTimeSeconds(),
    ordering,
    title,
    spatialPositionGr: { x: 0.0, y: 0.0 },

    spatialWidthGr: 10.0 * GRID_SIZE,

    flags: NoteFlags.None,

    url: "",

    computed_attachments: [],
  };
}

export function noteFromObject(o: any): NoteItem {
  // TODO (LOW): dynamic type check of o.
  // TODO (LOW): check flags field.
  return ({
    itemType: o.itemType,
    ownerId: o.ownerId,
    id: o.id,
    parentId: o.parentId,
    relationshipToParent: o.relationshipToParent,
    creationDate: o.creationDate,
    lastModifiedDate: o.lastModifiedDate,
    ordering: new Uint8Array(o.ordering),
    title: o.title,
    spatialPositionGr: o.spatialPositionGr,

    spatialWidthGr: o.spatialWidthGr,

    flags: o.flags,

    url: o.url,

    computed_attachments: [],
  });
}

export function noteToObject(n: NoteItem): object {
  return ({
    itemType: n.itemType,
    ownerId: n.ownerId,
    id: n.id,
    parentId: n.parentId,
    relationshipToParent: n.relationshipToParent,
    creationDate: n.creationDate,
    lastModifiedDate: n.lastModifiedDate,
    ordering: Array.from(n.ordering),
    title: n.title,
    spatialPositionGr: n.spatialPositionGr,

    spatialWidthGr: n.spatialWidthGr,

    flags: n.flags,

    url: n.url,
  });
}

export function calcNoteSizeForSpatialBl(note: NoteMeasurable): Dimensions {
  let lineCount = measureLineCount(note.title, note.spatialWidthGr / GRID_SIZE);
  if (lineCount < 1) { lineCount = 1; }
  return { w: note.spatialWidthGr / GRID_SIZE, h: lineCount };
}

export function calcGeometryOfNoteItem_Desktop(note: NoteMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  const boundsPx = {
    x: (note.spatialPositionGr.x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (note.spatialPositionGr.y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcNoteSizeForSpatialBl(note).w / containerInnerSizeBl.w * containerBoundsPx.w + ITEM_BORDER_WIDTH_PX,
    h: calcNoteSizeForSpatialBl(note).h / containerInnerSizeBl.h * containerBoundsPx.h + ITEM_BORDER_WIDTH_PX,
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      HitboxFns.create(HitboxType.Click, innerBoundsPx),
      HitboxFns.create(HitboxType.Move, innerBoundsPx),
      HitboxFns.create(HitboxType.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
      HitboxFns.create(HitboxType.AttachComposite, {
        x: innerBoundsPx.w / 4,
        y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
        w: innerBoundsPx.w / 2,
        h: ATTACH_AREA_SIZE_PX,
      }),
      HitboxFns.create(HitboxType.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ],
  }
}

export function calcGeometryOfNoteItem_InComposite(measurable: NoteMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry {
  let cloned = asNoteMeasurable(cloneMeasurableFields(measurable));
  cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
  const sizePx = calcNoteSizeForSpatialBl(cloned);
  const boundsPx = {
    x: 0,
    y: topPx,
    w: compositeWidthBl * blockSizePx.w,
    h: sizePx.h * blockSizePx.h
  };
  const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
  let moveWidthPx = 10;
  if (innerBoundsPx.w < 10) {
    // TODO (MEDIUM): something sensible.
    moveWidthPx = 1;
  }
  const moveBoundsPx = {
    x: innerBoundsPx.w - moveWidthPx,
    y: innerBoundsPx.y,
    w: moveWidthPx,
    h: innerBoundsPx.h
  };
  return {
    boundsPx,
    hitboxes: [
      HitboxFns.create(HitboxType.Click, innerBoundsPx),
      HitboxFns.create(HitboxType.Move, moveBoundsPx),
      HitboxFns.create(HitboxType.AttachComposite, {
        x: innerBoundsPx.w / 4,
        y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
        w: innerBoundsPx.w / 2,
        h: ATTACH_AREA_SIZE_PX,
      }),
    ]
  };
}

export function calcGeometryOfNoteItem_Attachment(note: NoteMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  return calcGeometryOfAttachmentItemImpl(note, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
}

export function calcGeometryOfNoteItem_ListItem(_note: NoteMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
  const innerBoundsPx = {
    x: 0.0,
    y: 0.0,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      HitboxFns.create(HitboxType.Click, innerBoundsPx),
      HitboxFns.create(HitboxType.Move, innerBoundsPx)
    ]
  };
}

export function calcGeometryOfNoteItem_Cell(note: NoteMeasurable, cellBoundsPx: BoundingBox): ItemGeometry {
  const boundsPx = calcBoundsInCellFromSizeBl(calcNoteSizeForSpatialBl(note), cellBoundsPx);
  return ({
    boundsPx: cloneBoundingBox(boundsPx)!,
    hitboxes: [
      HitboxFns.create(HitboxType.Click, zeroBoundingBoxTopLeft(boundsPx))
    ]
  });
}

export function isNote(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ITEM_TYPE_NOTE;
}

export function asNoteItem(item: ItemTypeMixin): NoteItem {
  if (item.itemType == ITEM_TYPE_NOTE) { return item as NoteItem; }
  panic();
}

export function asNoteMeasurable(item: ItemTypeMixin): NoteMeasurable {
  if (item.itemType == ITEM_TYPE_NOTE) { return item as NoteMeasurable; }
  panic();
}

export function handleNoteClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void {
  if (handleListPageLineItemClickMaybe(visualElement, desktopStore)) { return; }
  const noteItem = asNoteItem(visualElement.displayItem);
  if (noteItem.url != "") {
    window.open(noteItem.url, '_blank');
  }
}

export function cloneNoteMeasurableFields(note: NoteMeasurable): NoteMeasurable {
  return ({
    itemType: note.itemType,
    spatialPositionGr: note.spatialPositionGr,
    spatialWidthGr: note.spatialWidthGr,
    title: note.title,
    flags: note.flags,
  });
}

export function noteDebugSummary(noteItem: NoteItem) {
  return "[note] " + noteItem.title;
}

export function getNoteItemFingerprint(noteItem: NoteItem): string {
  return noteItem.title + "~~~!@#~~~" + noteItem.url + "~~~!@#~~~" + noteItem.flags;
}
