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
import { UserStoreContextModel } from '../../store/UserStoreProvider';
import { DesktopStoreContextModel } from '../../store/DesktopStoreProvider';
import { ItemGeometry } from '../../layout/item-geometry';
import { VisualElement } from '../../layout/visual-element';
import { asFileItem, asFileMeasurable, calcFileSizeForSpatialBl, calcGeometryOfFileItem_Attachment, calcGeometryOfFileItem_Desktop, calcGeometryOfFileItem_Cell, calcGeometryOfFileItem_ListItem, cloneFileMeasurableFields, fileFromObject, fileToObject, handleFileClick, isFile, fileDebugSummary, getFileItemMightBeDirty, calcGeometryOfFileItem_InComposite } from '../file-item';
import { asImageItem, asImageMeasurable, calcGeometryOfImageItem_Attachment, calcGeometryOfImageItem_Desktop, calcGeometryOfImageItem_Cell, calcGeometryOfImageItem_ListItem, calcImageSizeForSpatialBl, cloneImageMeasurableFields, handleImageClick, imageFromObject, imageToObject, isImage, imageDebugSummary, getImageItemMightBeDirty, calcGeometryOfImageItem_InComposite } from '../image-item';
import { asLinkItem, calcGeometryOfLinkItem_Attachment, calcGeometryOfLinkItem_Desktop, calcGeometryOfLinkItem_Cell, calcGeometryOfLinkItem_ListItem, calcLinkSizeForSpatialBl, isLink, linkFromObject, linkToObject, linkDebugSummary, getLinkItemMightBeDirty, calcGeometryOfLinkItem_InComposite } from '../link-item';
import { asNoteItem, asNoteMeasurable, calcGeometryOfNoteItem_Attachment, calcGeometryOfNoteItem_Desktop, calcGeometryOfNoteItem_Cell, calcGeometryOfNoteItem_ListItem, calcNoteSizeForSpatialBl, cloneNoteMeasurableFields, handleNoteClick, isNote, noteFromObject, noteToObject, noteDebugSummary, getNoteItemMightBeDirty, calcGeometryOfNoteItem_InComposite } from '../note-item';
import { asPageItem, asPageMeasurable, calcGeometryOfPageItem_Attachment, calcGeometryOfPageItem_Desktop, calcGeometryOfPageItem_Cell, calcGeometryOfPageItem_ListItem, calcPageSizeForSpatialBl, clonePageMeasurableFields, handlePageClick, handlePagePopupClick, isPage, pageFromObject, pageToObject, pageDebugSummary, getPageItemMightBeDirty, calcGeometryOfPageItem_InComposite } from '../page-item';
import { asRatingItem, asRatingMeasurable, calcGeometryOfRatingItem_Attachment, calcGeometryOfRatingItem_Desktop, calcGeometryOfRatingItem_Cell, calcGeometryOfRatingItem_ListItem, calcRatingSizeForSpatialBl, cloneRatingMeasurableFields, handleRatingClick, isRating, ratingFromObject, ratingToObject, ratingDebugSummary, getRatingItemMightBeDirty, calcGeometryOfRatingItem_InComposite } from '../rating-item';
import { asTableItem, asTableMeasurable, calcGeometryOfTableItem_Attachment, calcGeometryOfTableItem_Desktop, calcGeometryOfTableItem_Cell, calcGeometryOfTableItem_ListItem, calcTableSizeForSpatialBl, cloneTableMeasurableFields, isTable, tableFromObject, tableToObject, tableDebugSummary, getTableItemMightBeDirty, handleTableClick, calcGeometryOfTableItem_InComposite } from '../table-item';
import { EMPTY_ITEM, Item, Measurable, calcGeometryOfEmptyItem_ListItem } from './item';
import { asPlaceholderItem, calcGeometryOfPlaceholderItem_Attachment, calcGeometryOfPlaceholderItem_Desktop, calcGeometryOfPlaceholderItem_Cell, calcGeometryOfPlaceholderItem_ListItem, calcPlaceholderSizeForSpatialBl, clonePlaceholderMeasurableFields, isPlaceholder, placeholderFromObject, placeholderToObject, placeholderDebugSummary, getPlaceholderItemMightBeDirty, calcGeometryOfPlaceholderItem_InComposite } from '../placeholder-item';
import { asPasswordItem, asPasswordMeasurable, calcGeometryOfPasswordItem_Attachment, calcGeometryOfPasswordItem_Cell, calcGeometryOfPasswordItem_InComposite, calcGeometryOfPasswordItem_Desktop, calcGeometryOfPasswordItem_ListItem, calcPasswordSizeForSpatialBl, clonePasswordMeasurableFields, getPasswordItemMightBeDirty, handlePasswordClick, isPassword, passwordDebugSummary, passwordFromObject, passwordToObject } from '../password-item';
import { asCompositeItem, asCompositeMeasurable, calcCompositeSizeForSpatialBl, calcGeometryOfCompositeItem_Attachment, calcGeometryOfCompositeItem_Cell, calcGeometryOfCompositeItem_Desktop, calcGeometryOfCompositeItem_ListItem, cloneCompositeMeasurableFields, compositeDebugSummary, compositeFromObject, compositeToObject, getCompositeItemMightBeDirty, isComposite } from '../composite-item';


// Poor man's polymorphism

export function calcSizeForSpatialBl(measurable: Measurable): Dimensions {
  if (isPage(measurable)) { return calcPageSizeForSpatialBl(asPageMeasurable(measurable)); }
  if (isTable(measurable)) { return calcTableSizeForSpatialBl(asTableMeasurable(measurable)); }
  if (isComposite(measurable)) { return calcCompositeSizeForSpatialBl(asCompositeMeasurable(measurable)); }
  if (isNote(measurable)) { return calcNoteSizeForSpatialBl(asNoteMeasurable(measurable)); }
  if (isImage(measurable)) { return calcImageSizeForSpatialBl(asImageMeasurable(measurable)); }
  if (isFile(measurable)) { return calcFileSizeForSpatialBl(asFileMeasurable(measurable)); }
  if (isPassword(measurable)) { return calcPasswordSizeForSpatialBl(asPasswordMeasurable(measurable)); }
  if (isRating(measurable)) { return calcRatingSizeForSpatialBl(asRatingMeasurable(measurable)); }
  if (isLink(measurable)) { return calcLinkSizeForSpatialBl(asLinkItem(measurable)); }
  if (isPlaceholder(measurable)) { return calcPlaceholderSizeForSpatialBl(asPlaceholderItem(measurable)); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_Desktop(measurable: Measurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Desktop(asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Desktop(asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isComposite(measurable)) { return calcGeometryOfCompositeItem_Desktop(asCompositeMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Desktop(asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Desktop(asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Desktop(asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isPassword(measurable)) { return calcGeometryOfPasswordItem_Desktop(asPasswordMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Desktop(asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Desktop(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Desktop(asPlaceholderItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_Attachment(measurable: Measurable, parentBoundsPx: BoundingBox, parentSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Attachment(asPageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Attachment(asTableMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isComposite(measurable)) { return calcGeometryOfCompositeItem_Attachment(asCompositeMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Attachment(asNoteMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Attachment(asImageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Attachment(asFileMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isPassword(measurable)) { return calcGeometryOfPasswordItem_Attachment(asPasswordMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Attachment(asRatingMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Attachment(asLinkItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Attachment(asPlaceholderItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_ListItem(measurable: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number): ItemGeometry {
  if (measurable == EMPTY_ITEM()) { return calcGeometryOfEmptyItem_ListItem(measurable, blockSizePx, row, col, widthBl); }
  if (isPage(measurable)) { return calcGeometryOfPageItem_ListItem(asPageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_ListItem(asTableMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isComposite(measurable)) { return calcGeometryOfCompositeItem_ListItem(asCompositeMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_ListItem(asNoteMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_ListItem(asImageMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_ListItem(asFileMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isPassword(measurable)) { return calcGeometryOfPasswordItem_ListItem(asPasswordMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_ListItem(asRatingMeasurable(measurable), blockSizePx, row, col, widthBl); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_ListItem(asLinkItem(measurable), blockSizePx, row, col, widthBl); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_ListItem(asPlaceholderItem(measurable), blockSizePx, row, col, widthBl); }
  throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_InCell(measurable: Measurable, cellBoundsPx: BoundingBox): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_Cell(asPageMeasurable(measurable), cellBoundsPx); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_Cell(asTableMeasurable(measurable), cellBoundsPx); }
  if (isComposite(measurable)) { return calcGeometryOfCompositeItem_Cell(asCompositeMeasurable(measurable), cellBoundsPx); }
  if (isNote(measurable)) { return calcGeometryOfNoteItem_Cell(asNoteMeasurable(measurable), cellBoundsPx); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_Cell(asImageMeasurable(measurable), cellBoundsPx); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_Cell(asFileMeasurable(measurable), cellBoundsPx); }
  if (isPassword(measurable)) { return calcGeometryOfPasswordItem_Cell(asPasswordMeasurable(measurable), cellBoundsPx); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_Cell(asRatingMeasurable(measurable), cellBoundsPx); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_Cell(asLinkItem(measurable), cellBoundsPx); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_Cell(asPlaceholderItem(measurable), cellBoundsPx); }
  throw throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function calcGeometryOfItem_InComposite(measurable: Measurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry {
  if (isPage(measurable)) { return calcGeometryOfPageItem_InComposite(asPageMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isTable(measurable)) { return calcGeometryOfTableItem_InComposite(asTableMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isComposite(measurable)) { panic(); } // composite items are flattened, can't be embedded.
  if (isNote(measurable)) { return calcGeometryOfNoteItem_InComposite(asNoteMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isImage(measurable)) { return calcGeometryOfImageItem_InComposite(asImageMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isFile(measurable)) { return calcGeometryOfFileItem_InComposite(asFileMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isPassword(measurable)) { return calcGeometryOfPasswordItem_InComposite(asPasswordMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isRating(measurable)) { return calcGeometryOfRatingItem_InComposite(asRatingMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isLink(measurable)) { return calcGeometryOfLinkItem_InComposite(asLinkItem(measurable), blockSizePx, compositeWidthBl, topPx); }
  if (isPlaceholder(measurable)) { return calcGeometryOfPlaceholderItem_InComposite(asPlaceholderItem(measurable), blockSizePx, compositeWidthBl, topPx);}
  throw throwExpression(`Unknown item type: ${measurable.itemType}`);
}

export function getMightBeDirty(item: Item): string {
  if (isPage(item)) { return getPageItemMightBeDirty(asPageItem(item)); }
  if (isTable(item)) { return getTableItemMightBeDirty(asTableItem(item)); }
  if (isComposite(item)) { return getCompositeItemMightBeDirty(asCompositeItem(item)); }
  if (isNote(item)) { return getNoteItemMightBeDirty(asNoteItem(item)); }
  if (isImage(item)) { return getImageItemMightBeDirty(asImageItem(item)); }
  if (isFile(item)) { return getFileItemMightBeDirty(asFileItem(item)); }
  if (isPassword(item)) { return getPasswordItemMightBeDirty(asPasswordItem(item)); }
  if (isRating(item)) { return getRatingItemMightBeDirty(asRatingItem(item)); }
  if (isLink(item)) { return getLinkItemMightBeDirty(asLinkItem(item)); }
  if (isPlaceholder(item)) { return getPlaceholderItemMightBeDirty(asPlaceholderItem(item)); }
  throw throwExpression(`Unknown item type: ${item.itemType}`);
}

export function itemFromObject(o: any): Item {
  if (isPage(o)) { return pageFromObject(o); }
  if (isTable(o)) { return tableFromObject(o); }
  if (isComposite(o)) { return compositeFromObject(o); }
  if (isNote(o)) { return noteFromObject(o); }
  if (isImage(o)) { return imageFromObject(o); }
  if (isFile(o)) { return fileFromObject(o); }
  if (isPassword(o)) { return passwordFromObject(o); }
  if (isRating(o)) { return ratingFromObject(o); }
  if (isLink(o)) { return linkFromObject(o); }
  if (isPlaceholder(o)) { return placeholderFromObject(o); }
  throwExpression(`Unknown item type: ${o.itemType}`);
}

export function itemToObject(item: Item): object {
  if (isPage(item)) { return pageToObject(asPageItem(item)); }
  if (isTable(item)) { return tableToObject(asTableItem(item)); }
  if (isComposite(item)) { return compositeToObject(asCompositeItem(item)); }
  if (isNote(item)) { return noteToObject(asNoteItem(item)); }
  if (isImage(item)) { return imageToObject(asImageItem(item)); }
  if (isFile(item)) { return fileToObject(asFileItem(item)); }
  if (isPassword(item)) { return passwordToObject(asPasswordItem(item)); }
  if (isRating(item)) { return ratingToObject(asRatingItem(item)); }
  if (isLink(item)) { return linkToObject(asLinkItem(item)); }
  if (isPlaceholder(item)) { return placeholderToObject(asPlaceholderItem(item)); }
  throwExpression(`Unknown item type: ${item.itemType}`);
}

export function handleClick(visualElementSignal: VisualElementSignal, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  const item = visualElementSignal.get().displayItem;
  if (isPage(item)) { handlePageClick(visualElementSignal.get(), desktopStore, userStore); }
  else if (isTable(item)) { handleTableClick(visualElementSignal.get(), desktopStore, userStore); }
  else if (isComposite(item)) { } // TODO.
  else if (isNote(item)) { handleNoteClick(visualElementSignal.get(), desktopStore); }
  else if (isImage(item)) { handleImageClick(visualElementSignal.get(), desktopStore); }
  else if (isFile(item)) { handleFileClick(visualElementSignal.get(), desktopStore); }
  else if (isPassword(item)) { handlePasswordClick(visualElementSignal.get(), desktopStore); }
  else if (isRating(item)) { handleRatingClick(desktopStore, visualElementSignal); }
  else if (isLink(item)) { }
  else if (isPlaceholder(item)) { panic(); }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function handlePopupClick(visualElement: VisualElement, desktopStore: DesktopStoreContextModel, userStore: UserStoreContextModel): void {
  const item = visualElement.displayItem;
  if (isPage(item)) { handlePagePopupClick(visualElement, desktopStore, userStore); }
  else if (isTable(item)) { }
  else if (isComposite(item)) { }
  else if (isNote(item)) { }
  else if (isImage(item)) { }
  else if (isFile(item)) { }
  else if (isPassword(item)) { }
  else if (isRating(item)) { }
  else if (isLink(item)) { }
  else if (isPlaceholder(item)) { panic!() }
  else { throwExpression(`Unknown item type: ${item.itemType}`); }
}

export function cloneMeasurableFields(measurable: Measurable): Measurable {
  if (measurable == null) { panic(); }
  if (isPage(measurable)) { return clonePageMeasurableFields(asPageMeasurable(measurable)); }
  else if (isTable(measurable)) { return cloneTableMeasurableFields(asTableMeasurable(measurable)); }
  else if (isComposite(measurable)) { return cloneCompositeMeasurableFields(asCompositeMeasurable(measurable)); }
  else if (isNote(measurable)) { return cloneNoteMeasurableFields(asNoteMeasurable(measurable)); }
  else if (isImage(measurable)) { return cloneImageMeasurableFields(asImageMeasurable(measurable)); }
  else if (isFile(measurable)) { return cloneFileMeasurableFields(asFileMeasurable(measurable)); }
  else if (isPassword(measurable)) { return clonePasswordMeasurableFields(asPasswordMeasurable(measurable)); }
  else if (isRating(measurable)) { return cloneRatingMeasurableFields(asRatingMeasurable(measurable)); }
  else if (isLink(measurable)) { panic(); }
  else if (isPlaceholder(measurable)) { return clonePlaceholderMeasurableFields(asPlaceholderItem(measurable)); }
  else { throwExpression(`Unknown item type: ${measurable.itemType}`); }
}

export function debugSummary(item: Item): string {
  if (item == null) { return "null"; }
  if (isPage(item)) { return pageDebugSummary(asPageItem(item)); }
  if (isTable(item)) { return tableDebugSummary(asTableItem(item)); }
  if (isComposite(item)) { return compositeDebugSummary(asCompositeItem(item)); }
  if (isNote(item)) { return noteDebugSummary(asNoteItem(item)); }
  if (isFile(item)) { return fileDebugSummary(asFileItem(item)); }
  if (isPassword(item)) { return passwordDebugSummary(asPasswordItem(item)); }
  if (isRating(item)) { return ratingDebugSummary(asRatingItem(item)); }
  if (isImage(item)) { return imageDebugSummary(asImageItem(item)); }
  if (isPlaceholder(item)) { return placeholderDebugSummary(asPlaceholderItem(item)); }
  if (isLink(item)) { return linkDebugSummary(asLinkItem(item)); }
  return "[unknown]";
}
