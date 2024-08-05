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
import { HitboxFlags, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, Dimensions, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { TitledItem, TitledMixin } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { FlagsItem, FlagsMixin, NoteFlags } from './base/flags-item';
import { VeFns, VisualElement, VisualElementFlags } from '../layout/visual-element';
import { StoreContextModel } from '../store/StoreProvider';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';
import { measureLineCount } from '../layout/text';
import { fullArrange } from '../layout/arrange';
import { FormatMixin } from './base/format-item';
import { closestCaretPositionToClientPx, setCaretPosition } from '../util/caret';
import { CursorEventState } from '../input/state';
import { VesCache } from '../layout/ves-cache';


export interface NoteItem extends NoteMeasurable, XSizableItem, AttachmentsItem, TitledItem {
  url: string,
}

export interface NoteMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin, FlagsMixin, FormatMixin {
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
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,
      title,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 10.0 * GRID_SIZE,

      flags: NoteFlags.None,

      format: "",

      url: "",

      computed_attachments: [],
    };
  },

  fromObject: (o: any, origin: string | null): NoteItem => {
    // TODO (LOW): dynamic type check of o.
    // TODO (LOW): check flags field.
    return ({
      origin,
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
      creationDate: n.creationDate,
      lastModifiedDate: n.lastModifiedDate,
      ordering: Array.from(n.ordering),
      title: n.title,
      spatialPositionGr: n.spatialPositionGr,

      spatialWidthGr: n.spatialWidthGr,

      flags: n.flags,

      url: n.url,
      format: n.format,
    });
  },

  calcSpatialDimensionsBl: (note: NoteMeasurable): Dimensions => {
    let lineCount = measureLineCount(note.title, note.spatialWidthGr / GRID_SIZE, note.flags);
    if (lineCount < 1) { lineCount = 1; }
    return { w: note.spatialWidthGr / GRID_SIZE, h: lineCount };
  },

  calcGeometry_Spatial: (note: NoteMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const sizeBl = NoteFns.calcSpatialDimensionsBl(note);
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
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: !emitHitboxes ? [] : [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.ContentEditable, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ],
    }
  },

  calcGeometry_InComposite: (measurable: NoteMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = NoteFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w
          - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
          - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
          - CONTAINER_IN_COMPOSITE_PADDING_PX
          - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
      ]
    };
  },

  calcGeometry_Attachment: (note: NoteMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(note, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_note: NoteMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, _expandable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const clickAreaBoundsPx = {
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
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
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      ]
    });
  },

  asNoteMeasurable: (item: ItemTypeMixin): NoteMeasurable => {
    if (item.itemType == ItemType.Note) { return item as NoteMeasurable; }
    panic("not note measurable");
  },

  handleLinkClick: (visualElement: VisualElement): void => {
    window.open(asNoteItem(visualElement.displayItem).url, '_blank');
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    const itemPath = VeFns.veToPath(visualElement);
    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Note });
    const editingDomId = itemPath + ":title";
    const el = document.getElementById(editingDomId)!;
    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    setCaretPosition(el, closestIdx);
  },

  handlePopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if (VesCache.get(visualElement.parentPath!)!.get().flags & VisualElementFlags.Popup) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    } else {
      store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    }
  },

  cloneMeasurableFields: (note: NoteMeasurable): NoteMeasurable => {
    return ({
      itemType: note.itemType,
      spatialPositionGr: note.spatialPositionGr,
      spatialWidthGr: note.spatialWidthGr,
      title: note.title,
      flags: note.flags,
      format: note.format,
    });
  },

  debugSummary: (noteItem: NoteItem) => {
    return "[note] " + noteItem.title;
  },

  getFingerprint: (noteItem: NoteItem): string => {
    return noteItem.title + "~~~!@#~~~" + noteItem.url + "~~~!@#~~~" + noteItem.flags + "~~~!@#~~~" + noteItem.format;
  },

  isStyleNormalText: (flagsItem: FlagsItem): boolean => {
    return (
      !(flagsItem.flags & NoteFlags.Heading1) &&
      !(flagsItem.flags & NoteFlags.Heading2) &&
      !(flagsItem.flags & NoteFlags.Heading3) &&
      !(flagsItem.flags & NoteFlags.Bullet1) &&
      !(flagsItem.flags & NoteFlags.Code)
    );
  },

  isAlignedLeft: (flagsItem: FlagsItem): boolean => {
    return (
      !(flagsItem.flags & NoteFlags.AlignCenter) &&
      !(flagsItem.flags & NoteFlags.AlignJustify) &&
      !(flagsItem.flags & NoteFlags.AlignRight)
    );
  },

  clearTextStyleFlags: (flagsItem: FlagsItem): void => {
    flagsItem.flags &= ~NoteFlags.Heading1;
    flagsItem.flags &= ~NoteFlags.Heading2;
    flagsItem.flags &= ~NoteFlags.Heading3;
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
