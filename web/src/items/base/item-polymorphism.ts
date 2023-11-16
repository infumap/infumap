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
import { panic } from '../../util/lang';
import { VisualElementSignal } from '../../util/signals';
import { DesktopStoreContextModel } from '../../store/DesktopStoreProvider';
import { ItemGeometry } from '../../layout/item-geometry';
import { VisualElement } from '../../layout/visual-element';
import { asFileItem, isFile, FileFns } from '../file-item';
import { asImageItem, isImage, ImageFns } from '../image-item';
import { asLinkItem, isLink, LinkFns } from '../link-item';
import { asNoteItem, isNote, NoteFns } from '../note-item';
import { asPageItem, isPage, PageFns } from '../page-item';
import { asRatingItem, isRating, RatingFns } from '../rating-item';
import { asTableItem, isTable, TableFns } from '../table-item';
import { EMPTY_ITEM, Item, Measurable } from './item';
import { asPlaceholderItem, isPlaceholder, PlaceholderFns } from '../placeholder-item';
import { asPasswordItem, isPassword, PasswordFns } from '../password-item';
import { asCompositeItem, isComposite, CompositeFns } from '../composite-item';
import { calcGeometryOfEmptyItem_ListItem } from './item-common-fns';
import { HitboxMeta } from '../../layout/hitbox';
import { DockFns, asDockItem, isDock } from '../dock-item';
import { TrashFns, asTrashItem, isTrash } from '../trash-item';


// Poor man's polymorphism
// In the original design, items were used as SolidJS signals and so could not be classes.
// Now, they are not and could be, however I don't necessarily mind sticking to the simpler subset of TS, even if it does result in this verbosity.

export const ItemFns = {
  calcSpatialDimensionsBl: (measurable: Measurable): Dimensions => {
    if (isPage(measurable)) { return PageFns.calcSpatialDimensionsBl(PageFns.asPageMeasurable(measurable)); }
    if (isTable(measurable)) { return TableFns.calcSpatialDimensionsBl(TableFns.asTableMeasurable(measurable)); }
    if (isComposite(measurable)) { return CompositeFns.calcSpatialDimensionsBl(CompositeFns.asCompositeMeasurable(measurable)); }
    if (isNote(measurable)) { return NoteFns.calcSpatialDimensionsBl(NoteFns.asNoteMeasurable(measurable)); }
    if (isImage(measurable)) { return ImageFns.calcSpatialDimensionsBl(ImageFns.asImageMeasurable(measurable)); }
    if (isFile(measurable)) { return FileFns.calcSpatialDimensionsBl(FileFns.asFileMeasurable(measurable)); }
    if (isPassword(measurable)) { return PasswordFns.calcSpatialDimensionsBl(PasswordFns.asPasswordMeasurable(measurable)); }
    if (isRating(measurable)) { return RatingFns.calcSpatialDimensionsBl(RatingFns.asRatingMeasurable(measurable)); }
    if (isLink(measurable)) { return LinkFns.calcSpatialDimensionsBl(asLinkItem(measurable)); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcSpatialDimensionsBl(PlaceholderFns.asPlaceholderMeasurable(measurable)); }
    panic(`calcSpatialDimensionsBl: unknown or unsupported item type: ${measurable.itemType}`);
  },

  calcGeometry_Spatial: (measurable: Measurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions, parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean, hasPendingChanges: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_Spatial(PageFns.asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasPendingChanges); }
    if (isTable(measurable)) { return TableFns.calcGeometry_Spatial(TableFns.asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_Spatial(CompositeFns.asCompositeMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_Spatial(NoteFns.asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_Spatial(ImageFns.asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isFile(measurable)) { return FileFns.calcGeometry_Spatial(FileFns.asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_Spatial(PasswordFns.asPasswordMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_Spatial(RatingFns.asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_Spatial(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasPendingChanges); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_Spatial(PlaceholderFns.asPlaceholderMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_Attachment: (measurable: Measurable, parentBoundsPx: BoundingBox, parentSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_Attachment(PageFns.asPageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isTable(measurable)) { return TableFns.calcGeometry_Attachment(TableFns.asTableMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_Attachment(CompositeFns.asCompositeMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_Attachment(NoteFns.asNoteMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_Attachment(ImageFns.asImageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isFile(measurable)) { return FileFns.calcGeometry_Attachment(FileFns.asFileMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_Attachment(PasswordFns.asPasswordMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_Attachment(RatingFns.asRatingMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_Attachment(asLinkItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_Attachment(PlaceholderFns.asPlaceholderMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_ListItem: (measurable: Measurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, parentIsPopup: boolean): ItemGeometry => {
    if (measurable == EMPTY_ITEM()) { return calcGeometryOfEmptyItem_ListItem(measurable, blockSizePx, row, col, widthBl); }
    if (isPage(measurable)) { return PageFns.calcGeometry_ListItem(PageFns.asPageMeasurable(measurable), blockSizePx, row, col, widthBl, parentIsPopup); }
    if (isTable(measurable)) { return TableFns.calcGeometry_ListItem(TableFns.asTableMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_ListItem(CompositeFns.asCompositeMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_ListItem(NoteFns.asNoteMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_ListItem(ImageFns.asImageMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isFile(measurable)) { return FileFns.calcGeometry_ListItem(FileFns.asFileMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_ListItem(PasswordFns.asPasswordMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_ListItem(RatingFns.asRatingMeasurable(measurable), blockSizePx, row, col, widthBl); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_ListItem(asLinkItem(measurable), blockSizePx, row, col, widthBl, parentIsPopup); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_ListItem(PlaceholderFns.asPlaceholderMeasurable(measurable), blockSizePx, row, col, widthBl); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_InCell: (measurable: Measurable, cellBoundsPx: BoundingBox, expandable: boolean, parentIsPopup: boolean, isPopup: boolean, hasPendingChanges: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_Cell(PageFns.asPageMeasurable(measurable), cellBoundsPx, expandable, parentIsPopup, isPopup, hasPendingChanges); }
    if (isTable(measurable)) { return TableFns.calcGeometry_Cell(TableFns.asTableMeasurable(measurable), cellBoundsPx); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_Cell(CompositeFns.asCompositeMeasurable(measurable), cellBoundsPx); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_Cell(NoteFns.asNoteMeasurable(measurable), cellBoundsPx); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_Cell(ImageFns.asImageMeasurable(measurable), cellBoundsPx); }
    if (isFile(measurable)) { return FileFns.calcGeometry_Cell(FileFns.asFileMeasurable(measurable), cellBoundsPx); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_Cell(PasswordFns.asPasswordMeasurable(measurable), cellBoundsPx); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_Cell(RatingFns.asRatingMeasurable(measurable), cellBoundsPx); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_Cell(asLinkItem(measurable), cellBoundsPx, expandable, parentIsPopup, isPopup, hasPendingChanges); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_Cell(PlaceholderFns.asPlaceholderMeasurable(measurable), cellBoundsPx); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_InComposite: (measurable: Measurable, blockSizePx: Dimensions, compositeWidthBl: number, topPx: number): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_InComposite(PageFns.asPageMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isTable(measurable)) { return TableFns.calcGeometry_InComposite(TableFns.asTableMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isComposite(measurable)) { panic("calcGeometry_InComposite: composite item."); } // composite items are flattened, can't be embedded.
    if (isNote(measurable)) { return NoteFns.calcGeometry_InComposite(NoteFns.asNoteMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_InComposite(ImageFns.asImageMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isFile(measurable)) { return FileFns.calcGeometry_InComposite(FileFns.asFileMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_InComposite(PasswordFns.asPasswordMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_InComposite(RatingFns.asRatingMeasurable(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_InComposite(asLinkItem(measurable), blockSizePx, compositeWidthBl, topPx); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_InComposite(PlaceholderFns.asPlaceholderMeasurable(measurable), blockSizePx, compositeWidthBl, topPx);}
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  /**
   * A string that uniquely represents rendered aspects of the item, excluding anything that
   * impacts properties of the visual element itself (i.e. the geometry).
   */
  getFingerprint: (item: Item): string => {
    if (isPage(item)) { return PageFns.getFingerprint(asPageItem(item)); }
    if (isTable(item)) { return TableFns.getFingerprint(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.getFingerprint(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.getFingerprint(asNoteItem(item)); }
    if (isImage(item)) { return ImageFns.getFingerprint(asImageItem(item)); }
    if (isFile(item)) { return FileFns.getFingerprint(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.getFingerprint(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.getFingerprint(asRatingItem(item)); }
    if (isLink(item)) { return LinkFns.getFingerprint(asLinkItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.getFingerprint(asPlaceholderItem(item)); }
    if (isDock(item)) { return DockFns.getFingerprint(asDockItem(item)); }
    if (isTrash(item)) { return TrashFns.getFingerprint(asTrashItem(item)); }
    panic(`Unknown item type: ${item.itemType}`);
  },

  fromObject: (o: any, origin: string | null): Item => {
    if (isPage(o)) { return PageFns.fromObject(o, origin); }
    if (isTable(o)) { return TableFns.fromObject(o, origin); }
    if (isComposite(o)) { return CompositeFns.fromObject(o, origin); }
    if (isNote(o)) { return NoteFns.fromObject(o, origin); }
    if (isImage(o)) { return ImageFns.fromObject(o, origin); }
    if (isFile(o)) { return FileFns.fromObject(o, origin); }
    if (isPassword(o)) { return PasswordFns.fromObject(o, origin); }
    if (isRating(o)) { return RatingFns.fromObject(o, origin); }
    if (isLink(o)) { return LinkFns.fromObject(o, origin); }
    if (isPlaceholder(o)) { return PlaceholderFns.fromObject(o, origin); }
    panic(`fromObject: Unknown or unsupported item type: ${o.itemType}`);
  },

  toObject: (item: Item): object => {
    if (isPage(item)) { return PageFns.toObject(asPageItem(item)); }
    if (isTable(item)) { return TableFns.toObject(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.toObject(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.toObject(asNoteItem(item)); }
    if (isImage(item)) { return ImageFns.toObject(asImageItem(item)); }
    if (isFile(item)) { return FileFns.toObject(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.toObject(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.toObject(asRatingItem(item)); }
    if (isLink(item)) { return LinkFns.toObject(asLinkItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.toObject(asPlaceholderItem(item)); }
    panic(`toObject: Unknown or unsupported item type: ${item.itemType}`);
  },

  handleClick: (visualElementSignal: VisualElementSignal, hitboxMeta: HitboxMeta | null, desktopStore: DesktopStoreContextModel): void => {
    const item = visualElementSignal.get().displayItem;
    if (isPage(item)) { PageFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isTable(item)) { TableFns.handleClick(visualElementSignal.get(), hitboxMeta, desktopStore); }
    else if (isComposite(item)) { CompositeFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isNote(item)) { NoteFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isImage(item)) { ImageFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isFile(item)) { FileFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isPassword(item)) { PasswordFns.handleClick(visualElementSignal.get(), desktopStore); }
    else if (isRating(item)) { RatingFns.handleClick(desktopStore, visualElementSignal); }
    else if (isLink(item)) { }
    else if (isPlaceholder(item)) { panic("handleClick: placeholder."); }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  handleLinkClick: (visualElement: VisualElement): void => {
    const item = visualElement.displayItem;
    if (isPage(item)) { panic("handleLinkClick: page"); }
    else if (isTable(item)) { panic("handleLinkClick: table"); }
    else if (isComposite(item)) { panic("handleLinkClick: composite"); }
    else if (isNote(item)) { NoteFns.handleLinkClick(visualElement); }
    else if (isImage(item)) { panic("handleLinkClick: image"); }
    else if (isFile(item)) { FileFns.handleLinkClick(visualElement); }
    else if (isPassword(item)) { panic("handleLinkClick: password"); }
    else if (isRating(item)) { panic("handleLinkClick: rating"); }
    else if (isLink(item)) { panic("handleLinkClick: link"); }
    else if (isPlaceholder(item)) { panic("handleLinkClick: placeholder"); }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  handlePopupClick: (visualElement: VisualElement, desktopStore: DesktopStoreContextModel): void => {
    const item = visualElement.displayItem;
    if (isPage(item)) { PageFns.handlePopupClick(visualElement, desktopStore); }
    else if (isTable(item)) { }
    else if (isComposite(item)) { }
    else if (isNote(item)) { }
    else if (isImage(item)) { }
    else if (isFile(item)) { }
    else if (isPassword(item)) { }
    else if (isRating(item)) { }
    else if (isLink(item)) { }
    else if (isPlaceholder(item)) { panic!("handlePopupClick: placeholder") }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  cloneMeasurableFields: (measurable: Measurable): Measurable => {
    if (measurable == null) { panic("measurable is null."); }
    if (isPage(measurable)) { return PageFns.cloneMeasurableFields(PageFns.asPageMeasurable(measurable)); }
    else if (isTable(measurable)) { return TableFns.cloneMeasurableFields(TableFns.asTableMeasurable(measurable)); }
    else if (isComposite(measurable)) { return CompositeFns.cloneMeasurableFields(CompositeFns.asCompositeMeasurable(measurable)); }
    else if (isNote(measurable)) { return NoteFns.cloneMeasurableFields(NoteFns.asNoteMeasurable(measurable)); }
    else if (isImage(measurable)) { return ImageFns.cloneMeasurableFields(ImageFns.asImageMeasurable(measurable)); }
    else if (isFile(measurable)) { return FileFns.cloneMeasurableFields(FileFns.asFileMeasurable(measurable)); }
    else if (isPassword(measurable)) { return PasswordFns.cloneMeasurableFields(PasswordFns.asPasswordMeasurable(measurable)); }
    else if (isRating(measurable)) { return RatingFns.cloneMeasurableFields(RatingFns.asRatingMeasurable(measurable)); }
    else if (isLink(measurable)) { return LinkFns.cloneMeasurableFields(LinkFns.asLinkMeasurable(measurable)); }
    else if (isPlaceholder(measurable)) { return PlaceholderFns.cloneMeasurableFields(PlaceholderFns.asPlaceholderMeasurable(measurable)); }
    else { panic(`cloneMeasurableFields: Unknown or unsupported item type: ${measurable.itemType}`); }
  },

  debugSummary: (item: Item): string => {
    if (item == null) { return "null"; }
    if (isPage(item)) { return PageFns.debugSummary(asPageItem(item)); }
    if (isTable(item)) { return TableFns.debugSummary(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.debugSummary(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.debugSummary(asNoteItem(item)); }
    if (isFile(item)) { return FileFns.debugSummary(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.debugSummary(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.debugSummary(asRatingItem(item)); }
    if (isImage(item)) { return ImageFns.debugSummary(asImageItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.debugSummary(asPlaceholderItem(item)); }
    if (isLink(item)) { return LinkFns.debugSummary(asLinkItem(item)); }
    if (isDock(item)) { return DockFns.debugSummary(asDockItem(item)); }
    if (isTrash(item)) { return TrashFns.debugSummary(asTrashItem(item)); }
    return "[unknown]";
  }
};
