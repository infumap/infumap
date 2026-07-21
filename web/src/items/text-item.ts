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
import { AttachmentsItem, AttachmentsMixin, calcGeometryOfAttachmentItemImpl, calcSpatialAttachmentHitboxBoundsPx } from './base/attachments-item';
import { itemCanEdit, normalizeItemCapabilities } from './base/capabilities-item';
import { ItemType, ItemTypeMixin } from './base/item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { DataItem } from "./base/data-item";
import { TitledItem, TitledMixin } from './base/titled-item';
import { ItemGeometry } from '../layout/item-geometry';
import { PositionalMixin } from './base/positional-item';
import { StoreContextModel } from '../store/StoreProvider';
import { VeFns, VisualElement, VisualElementFlags } from '../layout/visual-element';
import { calcBoundsInCell, calcBoundsInCellFromSizeBl, handleListPageLineItemClickMaybe, isInsidePopupHierarchy } from './base/item-common-fns';
import { ItemFns } from './base/item-polymorphism';
import { desktopPopupIconTextIndentPx, measureLineCount } from '../layout/text';
import { TextFlags, FlagsMixin } from './base/flags-item';
import { IconMixin, ItemIconMode, ItemIconRenderContext, iconRenderContextFromVisualElement, itemIconKind, itemIconModeFromObject, listItemIconRenderContext } from './base/icon-item';
import { VesCache } from '../layout/ves-cache';
import { arrangeNow, requestArrange } from '../layout/arrange';
import { closestCaretPositionToClientPx, setCaretPosition } from '../util/caret';
import { CursorEventState } from '../input/state';
import { openTextDocumentProjection } from './text-document';
import { EMPTY_UID, newUid, Uid } from '../util/uid';


export interface TextItem extends TextMeasurable, XSizableItem, AttachmentsItem, DataItem, TitledItem {
  documentWidthBl: number | null,
  documentShowTitle: boolean | null,
  clipboardTextCreateState?: "awaiting-paste" | "editing-title" | "persisting",
  clipboardTextContent?: string | null,
}

export interface TextMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, TitledMixin, FlagsMixin, AttachmentsMixin, IconMixin { }

export const TEXT_CLIPBOARD_PLACEHOLDER_TITLE = "paste text";

export function isClipboardTextCreateItem(item: ItemTypeMixin | null): item is TextItem {
  return isText(item) && (item as TextItem).clipboardTextCreateState != null;
}

export function clipboardTextCreateShowsPlaceholder(item: TextItem): boolean {
  return item.clipboardTextCreateState == "awaiting-paste";
}

export function textDisplayTitle(textItem: TextItem): string {
  return clipboardTextCreateShowsPlaceholder(textItem) ? TEXT_CLIPBOARD_PLACEHOLDER_TITLE : textItem.title;
}


export const TextFns = {
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): TextItem => {
    if (parentId == EMPTY_UID) { panic("TextFns.create: parent is empty."); }
    const now = currentUnixTimeSeconds();
    return {
      origin: null,
      itemType: ItemType.Text,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      groupId: null,
      creationDate: now,
      lastModifiedDate: now,
      dateTime: now,
      endDateTime: null,
      ordering,
      title,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 8.0 * GRID_SIZE,

      flags: TextFlags.None,
      emoji: null,
      iconMode: ItemIconMode.Auto,

      originalCreationDate: now,
      mimeType: "text/plain",
      fileSizeBytes: 0,
      documentWidthBl: null,
      documentShowTitle: null,

      computed_attachments: [],
    };
  },

  fromObject: (o: any, origin: string | null): TextItem => {
    // TODO: dynamic type check of o.
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
      endDateTime: o.endDateTime ?? null,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,

      flags: o.flags ?? TextFlags.None,
      emoji: o.emoji || null,
      iconMode: itemIconModeFromObject(o, false),

      originalCreationDate: o.originalCreationDate,
      mimeType: o.mimeType,
      fileSizeBytes: o.fileSizeBytes,
      documentWidthBl: typeof o.documentWidthBl == "number" && Number.isFinite(o.documentWidthBl)
        ? Math.max(1, Math.round(o.documentWidthBl))
        : null,
      documentShowTitle: typeof o.documentShowTitle == "boolean" ? o.documentShowTitle : null,

      computed_attachments: [],
    });
  },

  toObject: (f: TextItem): object => {
    const result: any = {
      itemType: f.itemType,
      ownerId: f.ownerId,
      id: f.id,
      parentId: f.parentId,
      relationshipToParent: f.relationshipToParent,
      groupId: f.groupId,
      creationDate: f.creationDate,
      lastModifiedDate: f.lastModifiedDate,
      dateTime: f.dateTime,
      endDateTime: f.endDateTime,
      ordering: Array.from(f.ordering),
      title: f.title,
      spatialPositionGr: f.spatialPositionGr,

      spatialWidthGr: f.spatialWidthGr,

      flags: f.flags,
      emoji: f.emoji,
      iconMode: f.iconMode,

      originalCreationDate: f.originalCreationDate,
      mimeType: f.mimeType,
      fileSizeBytes: f.fileSizeBytes,
    };
    if (f.documentWidthBl != null) {
      result.documentWidthBl = f.documentWidthBl;
    }
    if (f.documentShowTitle != null) {
      result.documentShowTitle = f.documentShowTitle;
    }
    return result;
  },

  calcSpatialDimensionsBl: (text: TextMeasurable, iconContext: ItemIconRenderContext = ItemIconRenderContext.Spatial): Dimensions => {
    const widthBl = text.spatialWidthGr / GRID_SIZE;
    const textIndentPx = TextFns.showsIcon(text, iconContext) ? desktopPopupIconTextIndentPx(widthBl) : 0;
    let lineCount = measureLineCount(text.title, widthBl, 0, textIndentPx);
    if (lineCount < 1) { lineCount = 1; }
    return { w: widthBl, h: lineCount };
  },

  calcGeometry_Spatial: (text: TextMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, _parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry => {
    const sizeBl = TextFns.calcSpatialDimensionsBl(text);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (text.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (text.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes: Array<Hitbox> = [];
    if (emitHitboxes && TextFns.showsIcon(text, ItemIconRenderContext.Spatial)) {
      hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, { x: 0, y: 0, w: blockSizePx.w, h: blockSizePx.h }));
    }
    if (emitHitboxes) {
      hitboxes.push(
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(
          HitboxFlags.Attach,
          calcSpatialAttachmentHitboxBoundsPx(innerBoundsPx, blockSizePx.w, blockSizePx.h, text.computed_attachments.length),
        ),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: 0,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: boundsPx.w - RESIZE_BOX_SIZE_PX, y: boundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
      );
    }
    return {
      boundsPx,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes,
    }
  },

  calcGeometry_InComposite: (measurable: TextMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = TextFns.asTextMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = TextFns.calcSpatialDimensionsBl(cloned);
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

  calcGeometry_Attachment: (text: TextMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(text, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (text: TextMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, padTop: boolean, expandable: boolean, inTable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
    const iconContext = listItemIconRenderContext(inTable, !expandable);
    const showsIcon = TextFns.showsIcon(text, iconContext);
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row + (padTop ? LIST_PAGE_TOP_PADDING_PX * scale : 0),
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const clickAreaBoundsPx = {
      x: showsIcon ? blockSizePx.w : 0.0,
      y: 0.0,
      w: blockSizePx.w * (showsIcon ? widthBl - 1 : widthBl),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
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

  calcGeometry_InCell: (text: TextMeasurable, cellBoundsPx: BoundingBox, maximize: boolean): ItemGeometry => {
    const sizeBl = TextFns.calcSpatialDimensionsBl(text);
    const boundsPx = maximize ? calcBoundsInCell(sizeBl, cellBoundsPx) : calcBoundsInCellFromSizeBl(sizeBl, cellBoundsPx);
    const blockSizePx = {
      w: boundsPx.w / sizeBl.w,
      h: boundsPx.h / sizeBl.h,
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const hitboxes: Array<Hitbox> = [];
    if (TextFns.showsIcon(text, ItemIconRenderContext.Spatial)) {
      hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, { x: 0, y: 0, w: blockSizePx.w, h: blockSizePx.h }));
    }
    hitboxes.push(
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    );
    return ({
      boundsPx: cloneBoundingBox(boundsPx)!,
      viewportBoundsPx: null,
      blockSizePx,
      hitboxes,
    });
  },

  asTextMeasurable: (item: ItemTypeMixin): TextMeasurable => {
    if (item.itemType == ItemType.Text) { return item as TextMeasurable; }
    panic("not text measurable.");
  },

  handleLinkClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const textItem = asTextItem(visualElement.displayItem);
    void openTextDocumentProjection(store, textItem);
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel, forceEdit: boolean = false, caretAtEnd: boolean = false): void => {
    const handledByList = handleListPageLineItemClickMaybe(visualElement, store);
    if (!forceEdit && handledByList) { return; }
    const itemPath = VeFns.veToPath(visualElement);
    if (!itemCanEdit(visualElement.displayItem)) {
      if (!handledByList) {
        store.history.setFocus(itemPath);
        arrangeNow(store, "text-focus-only");
      }
      return;
    }
    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Text });
    const editingDomId = itemPath + ":title";
    const el = document.getElementById(editingDomId)!;
    el.focus();
    const closestIdx = caretAtEnd ? el.innerText.length : closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    arrangeNow(store, "text-enter-edit-mode");
    const freshEl = document.getElementById(editingDomId)!;
    if (freshEl) {
      freshEl.focus();
      setCaretPosition(freshEl, caretAtEnd ? freshEl.innerText.length : closestIdx);
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

  cloneMeasurableFields: (text: TextMeasurable): TextMeasurable => {
    return ({
      itemType: text.itemType,
      spatialPositionGr: text.spatialPositionGr,
      spatialWidthGr: text.spatialWidthGr,
      title: text.title,
      computed_attachments: text.computed_attachments,
      flags: text.flags,
      emoji: text.emoji,
      iconMode: text.iconMode,
    });
  },

  debugSummary: (textItem: TextItem) => {
    return `[${textItem.itemType}] ` + textItem.title;
  },

  getFingerprint: (textItem: TextItem): string => {
    return textItem.title + "~~~!@#~~~" + (textItem.emoji || "") + "~~~!@#~~~" + textItem.iconMode +
      "~~~!@#~~~" + (textItem.documentWidthBl ?? "") +
      "~~~!@#~~~" + (textItem.documentShowTitle == null ? "" : textItem.documentShowTitle ? "1" : "0") +
      "~~~!@#~~~" + (textItem.clipboardTextCreateState ?? "");
  },

  iconRenderContextFromVisualElement,

  showsIcon: (text: TextMeasurable, context: ItemIconRenderContext = ItemIconRenderContext.Spatial): boolean => {
    return itemIconKind(text.iconMode, context, false) != ItemIconMode.None;
  },

  emoji: (text: TextMeasurable, context: ItemIconRenderContext = ItemIconRenderContext.Spatial): string | null => {
    if (itemIconKind(text.iconMode, context, false) != ItemIconMode.Symbol) { return null; }
    const emoji = text.emoji?.trim();
    return emoji && emoji != "" ? emoji : null;
  },
};


export function isText(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Text;
}

export function asTextItem(item: ItemTypeMixin): TextItem {
  if (item.itemType == ItemType.Text) { return item as TextItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a text.`);
}
