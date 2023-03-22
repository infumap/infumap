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

import { GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, RESIZE_BOX_SIZE_PX } from '../../../constants';
import { HitboxType } from '../hitbox';
import { BoundingBox, cloneBoundingBox, cloneVector, Dimensions, zeroTopLeft } from '../../../util/geometry';
import { currentUnixTimeSeconds, panic } from '../../../util/lang';
import { newUid, Uid } from '../../../util/uid';
import { AttachmentsItem } from './base/attachments-item';
import { Item, ItemTypeMixin, ITEM_TYPE_NOTE } from './base/item';
import { TitledItem, TitledMixin } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../item-geometry';
import { PositionalMixin } from './base/positional-item';
import { createBooleanSignal, createUidArraySignal, createVectorSignal } from '../../../util/signals';


// TODO: re-imagine this as something more general. note == combination of paragraphs and other things.

export interface NoteItem extends NoteMeasurable, XSizableItem, AttachmentsItem, TitledItem {
  url: string,
}

export interface NoteMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin { }


export function newNoteItem(ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): NoteItem {
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
    spatialPositionGr: createVectorSignal({ x: 0.0, y: 0.0 }),

    spatialWidthGr: 4.0 * GRID_SIZE,

    url: "",

    computed_attachments: createUidArraySignal([]),
    computed_mouseIsOver: createBooleanSignal(false),
  };
}

export function noteFromObject(o: any): NoteItem {
  // TODO: dynamic type check of o.
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
    spatialPositionGr: createVectorSignal(o.spatialPositionGr),

    spatialWidthGr: o.spatialWidthGr,

    url: o.url,

    computed_attachments: createUidArraySignal([]),
    computed_mouseIsOver: createBooleanSignal(false),
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
    spatialPositionGr: n.spatialPositionGr.get(),

    spatialWidthGr: n.spatialWidthGr,

    url: n.url,
  });
}


function measureLineCount(s: string, widthBl: number): number {
  const div = document.createElement("div");
  div.setAttribute("style", `line-height: ${LINE_HEIGHT_PX}px; width: ${widthBl*LINE_HEIGHT_PX}px; overflow-wrap: break-word; padding: ${NOTE_PADDING_PX}px;`);
  const txt = document.createTextNode(s);
  div.appendChild(txt);
  document.body.appendChild(div);
  let lineCount = div.offsetHeight / LINE_HEIGHT_PX;
  document.body.removeChild(div);
  return Math.floor(lineCount);
}

export function calcNoteSizeForSpatialBl(note: NoteMeasurable, _getItem: (id: Uid) => (Item | null)): Dimensions {
  let lineCount = measureLineCount(note.title, note.spatialWidthGr / GRID_SIZE);
  return { w: note.spatialWidthGr / GRID_SIZE, h: lineCount };
}

export function calcGeometryOfNoteItem(note: NoteMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: (note.spatialPositionGr.get().x / (containerInnerSizeBl.w * GRID_SIZE)) * containerBoundsPx.w + containerBoundsPx.x,
    y: (note.spatialPositionGr.get().y / (containerInnerSizeBl.h * GRID_SIZE)) * containerBoundsPx.h + containerBoundsPx.y,
    w: calcNoteSizeForSpatialBl(note, getItem).w / containerInnerSizeBl.w * containerBoundsPx.w,
    h: calcNoteSizeForSpatialBl(note, getItem).h / containerInnerSizeBl.h * containerBoundsPx.h,
  };
  return {
    boundsPx,
    hitboxes: !emitHitboxes ? [] : [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Resize,
        boundsPx: { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX,
                    w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX } }
    ],
  }
}

export function calcGeometryOfNoteAttachmentItem(_note: NoteMeasurable, containerBoundsPx: BoundingBox, index: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: containerBoundsPx.w - (20 * index),
    y: -5,
    w: 15,
    h: 10,
  };
  return {
    boundsPx,
    hitboxes: [],
  }
}

export function calcGeometryOfNoteItemInTable(_note: NoteMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  const boundsPx = {
    x: blockSizePx.w * col,
    y: blockSizePx.h * row,
    w: blockSizePx.w * widthBl,
    h: blockSizePx.h
  };
  return {
    boundsPx,
    hitboxes: [
      { type: HitboxType.Click, boundsPx: zeroTopLeft(boundsPx) },
      { type: HitboxType.Move, boundsPx: zeroTopLeft(boundsPx) }
    ],
  };
}

export function calcGeometryOfNoteItemInCell(_note: NoteMeasurable, cellBoundsPx: BoundingBox, _getItem: (id: Uid) => (Item | null)): ItemGeometry {
  return ({
    boundsPx: cloneBoundingBox(cellBoundsPx)!,
    hitboxes: [{ type: HitboxType.Click, boundsPx: zeroTopLeft(cellBoundsPx) }]
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

export function handleNoteClick(noteItem: NoteItem): void {
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
  });
}
