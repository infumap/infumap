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

export interface NoteMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, YSizableMixin, TitledMixin, FlagsMixin, FormatMixin, AttachmentsMixin, IconMixin { }

export { ItemIconMode, ItemIconRenderContext };

function noteHasFaviconUrl(note: NoteItem): boolean {
  return note.url?.trim() != "";
}

function noteIconKind(note: NoteMeasurable, context: ItemIconRenderContext): ItemIconMode.None | ItemIconMode.Symbol | ItemIconMode.Favicon {
  const hasFaviconUrl = "url" in note && noteHasFaviconUrl(note as NoteItem);
  if (note.iconMode == ItemIconMode.Auto && hasFaviconUrl) {
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
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      dateTime: o.dateTime,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,
      spatialHeightGr: o.spatialHeightGr || 0,

      flags: o.flags,

      url: o.url,
      emoji: o.emoji || null,
      iconMode: itemIconModeFromObject(o, true),
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
    const sizeBl = NoteFns.calcSpatialDimensionsBl(cloned);
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
    const moveBoundsPx = compositeMoveOutHitboxBoundsPx(moveAreaBoundsPx);
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx, { compositeMoveOut: true }),
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
    arrangeNow(store, "note-enter-edit-mode");
    const freshEl = document.getElementById(editingDomId);
    if (freshEl instanceof HTMLElement) {
      freshEl.focus();
      setCaretPosition(freshEl, caretAtEnd ? freshEl.innerText.length : closestIdx);
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
      emoji: note.emoji,
      iconMode: note.iconMode,
    });
  },

  debugSummary: (noteItem: NoteItem) => {
    return "[note] " + noteItem.title;
  },

  getFingerprint: (noteItem: NoteItem): string => {
    return noteItem.title + "~~~!@#~~~" + noteItem.url + "~~~!@#~~~" + noteItem.flags + "~~~!@#~~~" + noteItem.format +
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
