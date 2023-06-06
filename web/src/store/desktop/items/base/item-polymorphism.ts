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
import { VisualElementSignal } from '../../../../util/signals';
import { Uid } from '../../../../util/uid';
import { UserStoreContextModel } from '../../../UserStoreProvider';
import { DesktopStoreContextModel } from '../../DesktopStoreProvider';
import { ItemGeometry } from '../../item-geometry';
import { VisualElement } from '../../visual-element';
import { asFileItem, asFileMeasurable, calcFileSizeForSpatialBl, calcGeometryOfFileAttachmentItem, calcGeometryOfFileItem, calcGeometryOfFileItemInCell, calcGeometryOfFileItemInTable, cloneFileMeasurableFields, fileFromObject, fileToObject, handleFileClick, isFile } from '../file-item';
import { asImageItem, asImageMeasurable, calcGeometryOfImageAttachmentItem, calcGeometryOfImageItem, calcGeometryOfImageItemInCell, calcGeometryOfImageItemInTable, calcImageSizeForSpatialBl, cloneImageMeasurableFields, handleImageClick, imageFromObject, imageToObject, isImage } from '../image-item';
import { asLinkItem, calcGeometryOfLinkAttachmentItem, calcGeometryOfLinkItem, calcGeometryOfLinkItemInCell, calcGeometryOfLinkItemInTable, calcLinkSizeForSpatialBl, isLink, linkFromObject, linkToObject } from '../link-item';
import { asNoteItem, asNoteMeasurable, calcGeometryOfNoteAttachmentItem, calcGeometryOfNoteItem, calcGeometryOfNoteItemInCell, calcGeometryOfNoteItemInTable, calcNoteSizeForSpatialBl, cloneNoteMeasurableFields, handleNoteClick, isNote, noteFromObject, noteToObject } from '../note-item';
import { asPageItem, asPageMeasurable, calcGeometryOfPageAttachmentItem, calcGeometryOfPageItem, calcGeometryOfPageItemInCell, calcGeometryOfPageItemInTable, calcPageSizeForSpatialBl, clonePageMeasurableFields, handlePageClick, handlePagePopupClick, isPage, pageFromObject, pageToObject } from '../page-item';
import { asRatingItem, asRatingMeasurable, calcGeometryOfRatingAttachmentItem, calcGeometryOfRatingItem, calcGeometryOfRatingItemInCell, calcGeometryOfRatingItemInTable, calcRatingSizeForSpatialBl, cloneRatingMeasurableFields, handleRatingClick, isRating, ratingFromObject, ratingToObject } from '../rating-item';
import { asTableItem, asTableMeasurable, calcGeometryOfTableAttachmentItem, calcGeometryOfTableItem, calcGeometryOfTableItemInCell, calcGeometryOfTableItemInTable, calcTableSizeForSpatialBl, cloneTableMeasurableFields, isTable, tableFromObject, tableToObject } from '../table-item';
import { Item, Measurable } from './item';


// Poor man's polymorphism

export function calcSizeForSpatialBl(measurable: Measurable, getItem: (id: Uid) => (Item | null)): Dimensions {
  if (isPage(measurable)) { return calcPageSizeForSpatialBl(asPageMeasurable(measurable)); }
  if (isTable(measurable)) { return calcTableSizeForSpatialBl(asTableMeasurable(measurable)); }
  if (isNote(measurable)) { return calcNoteSizeForSpatialBl(asNoteMeasurable(measurable)); }
  if (isImage(measurable)) { return calcImageSizeForSpatialBl(asImageMeasurable(measurable)); }
  if (isFile(measurable)) { return calcFileSizeForSpatialBl(asFileMeasurable(measurable)); }
  if (isRating(measurable)) { return calcRatingSizeForSpatialBl(asRatingMeasurable(measurable)); }
  if (isLink(measurable)) { return calcLinkSizeForSpatialBl(asLinkItem(measurable), getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInPage(measurable: Measurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, emitHitboxes: boolean, parentIsPopup: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem(asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isTable(measurable)) { return calcGeometryOfTableItem(asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem(asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isImage(measurable)) { return calcGeometryOfImageItem(asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isFile(measurable)) { return calcGeometryOfFileItem(asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem(asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, emitHitboxes, parentIsPopup, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfAttachmentItem(measurable: Measurable, parentBoundsPx: BoundingBox, parentSizeBl: Dimensions, index: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageAttachmentItem(asPageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableAttachmentItem(asTableMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteAttachmentItem(asNoteMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageAttachmentItem(asImageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileAttachmentItem(asFileMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingAttachmentItem(asRatingMeasurable(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkAttachmentItem(asLinkItem(measurable), parentBoundsPx, parentSizeBl, index, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInTable(measurable: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItemInTable(asPageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isTable(measurable)) { return calcGeometryOfTableItemInTable(asTableMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isNote(measurable)) { return calcGeometryOfNoteItemInTable(asNoteMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isImage(measurable)) { return calcGeometryOfImageItemInTable(asImageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isFile(measurable)) { return calcGeometryOfFileItemInTable(asFileMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isRating(measurable)) { return calcGeometryOfRatingItemInTable(asRatingMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isLink(measurable)) { return calcGeometryOfLinkItemInTable(asLinkItem(measurable), blockSizePx, row, col, widthBl, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItemInCell(measurable: Measurable, cellBoundsPx: BoundingBox, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItemInCell(asPageMeasurable(measurable), cellBoundsPx); }
  if (isTable(measurable)) { return calcGeometryOfTableItemInCell(asTableMeasurable(measurable), cellBoundsPx); }
  if (isNote(measurable)) { return calcGeometryOfNoteItemInCell(asNoteMeasurable(measurable), cellBoundsPx); }
  if (isImage(measurable)) { return calcGeometryOfImageItemInCell(asImageMeasurable(measurable), cellBoundsPx); }
  if (isFile(measurable)) { return calcGeometryOfFileItemInCell(asFileMeasurable(measurable), cellBoundsPx); }
  if (isRating(measurable)) { return calcGeometryOfRatingItemInCell(asRatingMeasurable(measurable), cellBoundsPx); }
  if (isLink(measurable)) { return calcGeometryOfLinkItemInCell(asLinkItem(measurable), cellBoundsPx, getItem); }
  throw throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function itemFromObject(o: any): Item {
  if (isPage(o)) { return pageFromObject(o); }
  if (isTable(o)) { return tableFromObject(o); }
  if (isNote(o)) { return noteFromObject(o); }
  if (isImage(o)) { return imageFromObject(o); }
  if (isFile(o)) { return fileFromObject(o); }
  if (isRating(o)) { return ratingFromObject(o); }
  if (isLink(o)) { return linkFromObject(o); }
  throwExpression(`Unknown item type: ${o.itemType}`);
}

export function itemToObject(item: Item): object {
  if (isPage(item)) { return pageToObject(asPageItem(item)); }
  if (isTable(item)) { return tableToObject(asTableItem(item)); }
  if (isNote(item)) { return noteToObject(asNoteItem(item)); }
  if (isImage(item)) { return imageToObject(asImageItem(item)); }
  if (isFile(item)) { return fileToObject(asFileItem(item)); }
  if (isRating(item)) { return ratingToObject(asRatingItem(item)); }
  if (isLink(item)) { return linkToObject(asLinkItem(item)); }
  throwExpression(`Unknown item type: ${item.itemType}`);
}

export function handleClick(visualElementSignal: VisualElementSignal, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  const item = visualElementSignal.get().item;
  if (isPage(item)) { handlePageClick(visualElementSignal.get(), desktopStore, userStore); }
  else if (isTable(item)) { }
  else if (isNote(item)) { handleNoteClick(asNoteItem(item)); }
  else if (isImage(item)) { handleImageClick(asImageItem(item)); }
  else if (isFile(item)) { handleFileClick(asFileItem(item)); }
  else if (isRating(item)) { handleRatingClick(desktopStore, visualElementSignal); }
  else if (isLink(item)) { }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function handlePopupClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  const item = visualElement.item;
  if (isPage(item)) { handlePagePopupClick(visualElement, desktopStore, userStore); }
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
