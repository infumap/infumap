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

import { BoundingBox, Dimensions } from '../../util/geometry';
import { panic, throwExpression } from '../../util/lang';
import { VisualElementSignal } from '../../util/signals';
import { Uid } from '../../util/uid';
import { UserStoreContextModel } from '../../store/UserStoreProvider';
import { DesktopStoreContextModel } from '../../store/DesktopStoreProvider';
import { ItemGeometry } from '../../layout/item-geometry';
import { VisualElement } from '../../layout/visual-element';
import { asFileItem, asFileMeasurable, calcFileSizeForSpatialBl, calcGeometryOfFileItem_Attachment, calcGeometryOfFileItem_Desktop, calcGeometryOfFileItem_Cell, calcGeometryOfFileItem_ListItem, cloneFileMeasurableFields, fileFromObject, fileToObject, handleFileClick, isFile } from '../file-item';
import { asImageItem, asImageMeasurable, calcGeometryOfImageItem_Attachment, calcGeometryOfImageItem_Desktop, calcGeometryOfImageItem_Cell, calcGeometryOfImageItem_ListItem, calcImageSizeForSpatialBl, cloneImageMeasurableFields, handleImageClick, imageFromObject, imageToObject, isImage } from '../image-item';
import { asLinkItem, calcGeometryOfLinkItem_Attachment, calcGeometryOfLinkItem_Desktop, calcGeometryOfLinkItem_Cell, calcGeometryOfLinkItem_ListItem, calcLinkSizeForSpatialBl, isLink, linkFromObject, linkToObject } from '../link-item';
import { asNoteItem, asNoteMeasurable, calcGeometryOfNoteItem_Attachment, calcGeometryOfNoteItem_Desktop, calcGeometryOfNoteItem_Cell, calcGeometryOfNoteItem_ListItem, calcNoteSizeForSpatialBl, cloneNoteMeasurableFields, handleNoteClick, isNote, noteFromObject, noteToObject } from '../note-item';
import { asPageItem, asPageMeasurable, calcGeometryOfPageItem_Attachment, calcGeometryOfPageItem_Desktop, calcGeometryOfPageItem_Cell, calcGeometryOfPageItem_ListItem, calcPageSizeForSpatialBl, clonePageMeasurableFields, handlePageClick, handlePagePopupClick, isPage, pageFromObject, pageToObject } from '../page-item';
import { asRatingItem, asRatingMeasurable, calcGeometryOfRatingItem_Attachment, calcGeometryOfRatingItem_Desktop, calcGeometryOfRatingItem_Cell, calcGeometryOfRatingItem_ListItem, calcRatingSizeForSpatialBl, cloneRatingMeasurableFields, handleRatingClick, isRating, ratingFromObject, ratingToObject } from '../rating-item';
import { asTableItem, asTableMeasurable, calcGeometryOfTableItem_Attachment, calcGeometryOfTableItem_Desktop, calcGeometryOfTableItem_Cell, calcGeometryOfTableItem_ListItem, calcTableSizeForSpatialBl, cloneTableMeasurableFields, isTable, tableFromObject, tableToObject } from '../table-item';
import { EMPTY_ITEM, Item, Measurable, calcGeometryOfEmptyItem_ListItem } from './item';
import { asPlaceholderItem, calcGeometryOfPlaceholderItem_Attachment, calcGeometryOfPlaceholderItem_Desktop, calcGeometryOfPlaceholderItem_Cell, calcGeometryOfPlaceholderItem_ListItem, calcPlaceholderSizeForSpatialBl, clonePlaceholderMeasurableFields, isPlaceholder, placeholderFromObject, placeholderToObject } from '../placeholder-item';


// Poor man's polymorphism

export function calcSizeForSpatialBl(measurable: Measurable, getItem: (id: Uid) => (Item | null)): Dimensions {
  if (isPage(measurable)) { return calcPageSizeForSpatialBl(asPageMeasurable(measurable)); }
  if (isTable(measurable)) { return calcTableSizeForSpatialBl(asTableMeasurable(measurable)); }
  if (isNote(measurable)) { return calcNoteSizeForSpatialBl(asNoteMeasurable(measurable)); }
  if (isImage(measurable)) { return calcImageSizeForSpatialBl(asImageMeasurable(measurable)); }
  if (isFile(measurable)) { return calcFileSizeForSpatialBl(asFileMeasurable(measurable)); }
  if (isRating(measurable)) { return calcRatingSizeForSpatialBl(asRatingMeasurable(measurable)); }
  if (isLink(measurable)) { return calcLinkSizeForSpatialBl(asLinkItem(measurable), getItem); }
  if (isPlaceholder(measurable)) { return calcPlaceholderSizeForSpatialBl(asPlaceholderItem(measurable)); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_Desktop(measurable: Measurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Desktop(asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Desktop(asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Desktop(asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Desktop(asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Desktop(asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Desktop(asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Desktop(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, getItem); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Desktop(asPlaceholderItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_Attachment(measurable: Measurable, parentBoundsPx: BoundingBox, parentSizeBl: Dimensions, index: number, isSelected: boolean, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Attachment(asPageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Attachment(asTableMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Attachment(asNoteMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Attachment(asImageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Attachment(asFileMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Attachment(asRatingMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Attachment(asLinkItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Attachment(asPlaceholderItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected, getItem); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_ListItem(measurable: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (measurable == EMPTY_ITEM) { return calcGeometryOfEmptyItem_ListItem(measurable, blockSizePx, row, col, widthBl); }
  if (isPage(measurable)) { return calcGeometryOfPageItem_ListItem(asPageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_ListItem(asTableMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_ListItem(asNoteMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_ListItem(asImageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_ListItem(asFileMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_ListItem(asRatingMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_ListItem(asLinkItem(measurable), blockSizePx, row, col, widthBl, getItem); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_ListItem(asPlaceholderItem(measurable), blockSizePx, row, col, widthBl); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_Cell(measurable: Measurable, cellBoundsPx: BoundingBox, getItem: (id: Uid) => (Item | null)): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Cell(asPageMeasurable(measurable), cellBoundsPx); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Cell(asTableMeasurable(measurable), cellBoundsPx); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Cell(asNoteMeasurable(measurable), cellBoundsPx); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Cell(asImageMeasurable(measurable), cellBoundsPx); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Cell(asFileMeasurable(measurable), cellBoundsPx); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Cell(asRatingMeasurable(measurable), cellBoundsPx); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Cell(asLinkItem(measurable), cellBoundsPx, getItem); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Cell(asPlaceholderItem(measurable), cellBoundsPx); }
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
  if (isPlaceholder(o)) { return placeholderFromObject(o); }
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
  if (isPlaceholder(item)) { return placeholderToObject(asPlaceholderItem(item)); }
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
  else if (isPlaceholder(item)) { panic(); }
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
  else if (isPlaceholder(item)) { panic!() }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function cloneMeasurableFields(measurable: Measurable): Measurable {
  if (measurable == null) { panic(); }
  if (isPage(measurable)) { return clonePageMeasurableFields(asPageMeasurable(measurable)); }
  else if (isTable(measurable)) { return cloneTableMeasurableFields(asTableMeasurable(measurable)); }
  else if (isNote(measurable)) { return cloneNoteMeasurableFields(asNoteMeasurable(measurable)); }
  else if (isImage(measurable)) { return cloneImageMeasurableFields(asImageMeasurable(measurable)); }
  else if (isFile(measurable)) { return cloneFileMeasurableFields(asFileMeasurable(measurable)); }
  else if (isRating(measurable)) { return cloneRatingMeasurableFields(asRatingMeasurable(measurable)); }
  else if (isLink(measurable)) { panic(); }
  else if (isPlaceholder(measurable)) { return clonePlaceholderMeasurableFields(asPlaceholderItem(measurable)); }
  else { throwExpression(`Unknown item type: ${measurable.itemType}`); }
}
