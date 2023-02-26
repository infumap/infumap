/*
  Copyright (C) 2023 The Infumap Authors
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

import { BoundingBox, Dimensions } from '../../../../util/geometry';
import { panic, throwExpression } from '../../../../util/lang';
import { Uid } from '../../../../util/uid';
import { UserStoreContextModel } from '../../../UserStoreProvider';
import { DesktopStoreContextModel } from '../../DesktopStoreProvider';
import { ItemGeometry } from '../../item-geometry';
import { asFileItem, asFileMeasurable, calcFileSizeForSpatialBl, calcGeometryOfFileAttachmentItem, calcGeometryOfFileItem, calcGeometryOfFileItemInCell, calcGeometryOfFileItemInTable, cloneFileMeasurableFields, handleFileClick, isFile, setFileDefaultComputed } from '../file-item';
import { asImageItem, asImageMeasurable, calcGeometryOfImageAttachmentItem, calcGeometryOfImageItem, calcGeometryOfImageItemInCell, calcGeometryOfImageItemInTable, calcImageSizeForSpatialBl, cloneImageMeasurableFields, handleImageClick, isImage, setImageDefaultComputed } from '../image-item';
import { asLinkItem, calcGeometryOfLinkAttachmentItem, calcGeometryOfLinkItem, calcGeometryOfLinkItemInCell, calcGeometryOfLinkItemInTable, calcLinkSizeForSpatialBl, isLink, setLinkDefaultComputed } from '../link-item';
import { asNoteItem, asNoteMeasurable, calcGeometryOfNoteAttachmentItem, calcGeometryOfNoteItem, calcGeometryOfNoteItemInCell, calcGeometryOfNoteItemInTable, calcNoteSizeForSpatialBl, cloneNoteMeasurableFields, handleNoteClick, isNote, setNoteDefaultComputed } from '../note-item';
import { asPageItem, asPageMeasurable, calcGeometryOfPageAttachmentItem, calcGeometryOfPageItem, calcGeometryOfPageItemInCell, calcGeometryOfPageItemInTable, calcPageSizeForSpatialBl, clonePageMeasurableFields, handlePageClick, handlePagePopupClick, isPage, setPageDefaultComputed } from '../page-item';
import { asRatingItem, asRatingMeasurable, calcGeometryOfRatingAttachmentItem, calcGeometryOfRatingItem, calcGeometryOfRatingItemInCell, calcGeometryOfRatingItemInTable, calcRatingSizeForSpatialBl, cloneRatingMeasurableFields, isRating, setRatingDefaultComputed } from '../rating-item';
import { asTableItem, asTableMeasurable, calcGeometryOfTableAttachmentItem, calcGeometryOfTableItem, calcGeometryOfTableItemInCell, calcGeometryOfTableItemInTable, calcTableSizeForSpatialBl, cloneTableMeasurableFields, isTable, setTableDefaultComputed } from '../table-item';
import { Item, Measurable } from './item';


// Poor man's polymorphism

export function calcSizeForSpatialBl(measurable: Measurable, getItem: (id: Uid) => (Item | null)): Dimensions {
  if (isPage(measurable)) { return calcPageSizeForSpatialBl(asPageMeasurable(measurable), getItem); }
  if (isTable(measurable)) { return calcTableSizeForSpatialBl(asTableMeasurable(measurable), getItem); }
  if (isNote(measurable)) { return calcNoteSizeForSpatialBl(asNoteMeasurable(measurable), getItem); }
  if (isImage(measurable)) { return calcImageSizeForSpatialBl(asImageMeasurable(measurable), getItem); }
  if (isFile(measurable)) { return calcFileSizeForSpatialBl(asFileMeasurable(measurable), getItem); }
  if (isRating(measurable)) { return calcRatingSizeForSpatialBl(asRatingMeasurable(measurable), getItem); }
  if (isLink(measurable)) { return calcLinkSizeForSpatialBl(asLinkItem(measurable), getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInPage(measurable: Measurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem(asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableItem(asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem(asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageItem(asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileItem(asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem(asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfAttachmentItem(measurable: Measurable, containerBoundsPx: BoundingBox, index: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageAttachmentItem(asPageMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableAttachmentItem(asTableMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteAttachmentItem(asNoteMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageAttachmentItem(asImageMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileAttachmentItem(asFileMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingAttachmentItem(asRatingMeasurable(measurable), containerBoundsPx, index, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkAttachmentItem(asLinkItem(measurable), containerBoundsPx, index, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInTable(measurable: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItemInTable(asPageMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableItemInTable(asTableMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteItemInTable(asNoteMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageItemInTable(asImageMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileItemInTable(asFileMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingItemInTable(asRatingMeasurable(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkItemInTable(asLinkItem(measurable), blockSizePx, row, col, widthBl, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInCell(measurable: Measurable, cellBoundsPx: BoundingBox, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItemInCell(asPageMeasurable(measurable), cellBoundsPx, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableItemInCell(asTableMeasurable(measurable), cellBoundsPx, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteItemInCell(asNoteMeasurable(measurable), cellBoundsPx, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageItemInCell(asImageMeasurable(measurable), cellBoundsPx, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileItemInCell(asFileMeasurable(measurable), cellBoundsPx, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingItemInCell(asRatingMeasurable(measurable), cellBoundsPx, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkItemInCell(asLinkItem(measurable), cellBoundsPx, getItem); }
  throw throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function setDefaultComputed(item: Item): void {
  if (isPage(item)) { setPageDefaultComputed(asPageItem(item)); return; }
  if (isTable(item)) { setTableDefaultComputed(asTableItem(item)); return; }
  if (isNote(item)) { setNoteDefaultComputed(asNoteItem(item)); return; }
  if (isImage(item)) { setImageDefaultComputed(asImageItem(item)); return; }
  if (isFile(item)) { setFileDefaultComputed(asFileItem(item)); return; }
  if (isRating(item)) { setRatingDefaultComputed(asRatingItem(item)); return; }
  if (isLink(item)) { setLinkDefaultComputed(asLinkItem(item)); return; }
  throwExpression(`Unknown item type: ${item.itemType}`);
}

export function handleClick(item: Item, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  if (isPage(item)) { handlePageClick(asPageItem(item), desktopStore, userStore); }
  else if (isTable(item)) { }
  else if (isNote(item)) { handleNoteClick(asNoteItem(item)); }
  else if (isImage(item)) { handleImageClick(asImageItem(item)); }
  else if (isFile(item)) { handleFileClick(asFileItem(item)); }
  else if (isRating(item)) { }
  else if (isLink(item)) { }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function handlePopupClick(item: Item, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  if (isPage(item)) { handlePagePopupClick(asPageItem(item), desktopStore, userStore); }
  else if (isTable(item)) { }
  else if (isNote(item)) { }
  else if (isImage(item)) { }
  else if (isFile(item)) { }
  else if (isRating(item)) { }
  else if (isLink(item)) { }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function cloneMeasurableFields(measurable: Measurable): Measurable {
  if (isPage(measurable)) { return clonePageMeasurableFields(asPageMeasurable(measurable)); }
  else if (isTable(measurable)) { return cloneTableMeasurableFields(asTableMeasurable(measurable)); }
  else if (isNote(measurable)) { return cloneNoteMeasurableFields(asNoteMeasurable(measurable)); }
  else if (isImage(measurable)) { return cloneImageMeasurableFields(asImageMeasurable(measurable)); }
  else if (isFile(measurable)) { return cloneFileMeasurableFields(asFileMeasurable(measurable)); }
  else if (isRating(measurable)) { return cloneRatingMeasurableFields(asRatingMeasurable(measurable)); }
  else if (isLink(measurable)) { panic(); }
  else { throwExpression(`Unknown item type: ${measurable.itemType}`); }
}
