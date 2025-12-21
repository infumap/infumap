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

import { BoundingBox, Dimensions, Vector } from '../../util/geometry';
import { assert, panic } from '../../util/lang';
import { VisualElementSignal } from '../../util/signals';
import { StoreContextModel } from '../../store/StoreProvider';
import { ItemGeometry } from '../../layout/item-geometry';
import { VisualElement } from '../../layout/visual-element';
import { asFileItem, isFile, FileFns } from '../file-item';
import { asImageItem, isImage, ImageFns } from '../image-item';
import { asLinkItem, isLink, LinkFns } from '../link-item';
import { asNoteItem, isNote, NoteFns } from '../note-item';
import { asPageItem, isPage, PageFns } from '../page-item';
import { asRatingItem, isRating, RatingFns } from '../rating-item';
import { asTableItem, isTable, TableFns } from '../table-item';
import { EMPTY_ITEM, Item, Measurable, isEmptyItem } from './item';
import { asPlaceholderItem, isPlaceholder, PlaceholderFns } from '../placeholder-item';
import { asPasswordItem, isPassword, PasswordFns } from '../password-item';
import { asCompositeItem, isComposite, CompositeFns } from '../composite-item';
import { calcGeometryOfEmptyItem_ListItem } from './item-common-fns';
import { HitboxFlags, HitboxMeta } from '../../layout/hitbox';
import { ExpressionFns, asExpressionItem, isExpression } from '../expression-item';
import { LINE_HEIGHT_PX } from '../../constants';
import { asFlipCardItem, FlipCardFns, isFlipCard } from '../flipcard-item';
import { hashStringToUid, hashI64ToUid, hashF64ToUid, hashU8VecToUid, combineHashes } from '../../util/hash';
import { Uid } from '../../util/uid';
import { isContainer } from './container-item';
import { isPositionalItem } from './positional-item';
import { isXSizableItem } from './x-sizeable-item';
import { isYSizableItem } from './y-sizeable-item';
import { isTitledItem } from './titled-item';
import { isDataItem } from './data-item';
import { isTabularItem } from './tabular-item';
import { isFlagsItem } from './flags-item';
import { isFormatItem } from './format-item';
import { isPermissionFlagsItem } from './permission-flags-item';
import { isColorableItem } from './colorable-item';
import { isAspectItem } from './aspect-item';


// Poor man's polymorphism

export const ItemFns = {

  calcSpatialDimensionsBl: (measurable: Measurable, adjustBl?: Dimensions): Dimensions => {
    if (isPage(measurable)) { return PageFns.calcSpatialDimensionsBl(PageFns.asPageMeasurable(measurable), adjustBl); }
    if (isLink(measurable)) { return LinkFns.calcSpatialDimensionsBl(asLinkItem(measurable), adjustBl); }
    assert(!adjustBl, "spatial dimensions adjustment only expected for page item types");
    if (isTable(measurable)) { return TableFns.calcSpatialDimensionsBl(TableFns.asTableMeasurable(measurable)); }
    if (isComposite(measurable)) { return CompositeFns.calcSpatialDimensionsBl(CompositeFns.asCompositeMeasurable(measurable)); }
    if (isNote(measurable)) { return NoteFns.calcSpatialDimensionsBl(NoteFns.asNoteMeasurable(measurable)); }
    if (isExpression(measurable)) { return ExpressionFns.calcSpatialDimensionsBl(ExpressionFns.asExpressionMeasurable(measurable)); }
    if (isImage(measurable)) { return ImageFns.calcSpatialDimensionsBl(ImageFns.asImageMeasurable(measurable)); }
    if (isFile(measurable)) { return FileFns.calcSpatialDimensionsBl(FileFns.asFileMeasurable(measurable)); }
    if (isPassword(measurable)) { return PasswordFns.calcSpatialDimensionsBl(PasswordFns.asPasswordMeasurable(measurable)); }
    if (isRating(measurable)) { return RatingFns.calcSpatialDimensionsBl(RatingFns.asRatingMeasurable(measurable)); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcSpatialDimensionsBl(PlaceholderFns.asPlaceholderMeasurable(measurable)); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcSpatialDimensionsBl(FlipCardFns.asFlipCardMeasurable(measurable)); }
    panic(`calcSpatialDimensionsBl: unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_Spatial: (
    measurable: Measurable,
    containerBoundsPx: BoundingBox,
    containerInnerSizeBl: Dimensions,
    parentIsPopup: boolean,
    emitHitboxes: boolean,
    isPopup: boolean,
    hasChildChanges: boolean,
    hasDefaultChanges: boolean,
    editing: boolean,
    smallScreenMode: boolean,
  ): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_Spatial(PageFns.asPageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasChildChanges, hasDefaultChanges, smallScreenMode); }
    if (isTable(measurable)) { return TableFns.calcGeometry_Spatial(TableFns.asTableMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_Spatial(CompositeFns.asCompositeMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_Spatial(NoteFns.asNoteMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isExpression(measurable)) { return ExpressionFns.calcGeometry_Spatial(ExpressionFns.asExpressionMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_Spatial(ImageFns.asImageMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasChildChanges, hasDefaultChanges); }
    if (isFile(measurable)) { return FileFns.calcGeometry_Spatial(FileFns.asFileMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_Spatial(PasswordFns.asPasswordMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_Spatial(RatingFns.asRatingMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_Spatial(asLinkItem(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, isPopup, hasChildChanges, hasDefaultChanges, editing, smallScreenMode); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_Spatial(PlaceholderFns.asPlaceholderMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcGeometry_Spatial(FlipCardFns.asFlipCardMeasurable(measurable), containerBoundsPx, containerInnerSizeBl, parentIsPopup, emitHitboxes, editing); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_Attachment: (
    measurable: Measurable,
    parentBoundsPx: BoundingBox,
    parentSizeBl: Dimensions,
    index: number,
    isSelected: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_Attachment(PageFns.asPageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isTable(measurable)) { return TableFns.calcGeometry_Attachment(TableFns.asTableMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_Attachment(CompositeFns.asCompositeMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_Attachment(NoteFns.asNoteMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isExpression(measurable)) { return ExpressionFns.calcGeometry_Attachment(ExpressionFns.asExpressionMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_Attachment(ImageFns.asImageMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isFile(measurable)) { return FileFns.calcGeometry_Attachment(FileFns.asFileMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_Attachment(PasswordFns.asPasswordMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_Attachment(RatingFns.asRatingMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_Attachment(asLinkItem(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_Attachment(PlaceholderFns.asPlaceholderMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcGeometry_Attachment(FlipCardFns.asFlipCardMeasurable(measurable), parentBoundsPx, parentSizeBl, index, isSelected); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_ListItem: (
    measurable: Measurable,
    blockSizePx: Dimensions,
    row: number,
    col: number,
    widthBl: number,
    parentIsPopup: boolean,
    padTop: boolean,
    expandable: boolean,
    inTable: boolean): ItemGeometry => {
    if (measurable == EMPTY_ITEM()) { return calcGeometryOfEmptyItem_ListItem(measurable, blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isPage(measurable)) { return PageFns.calcGeometry_ListItem(PageFns.asPageMeasurable(measurable), blockSizePx, row, col, widthBl, parentIsPopup, padTop, expandable); }
    if (isTable(measurable)) { return TableFns.calcGeometry_ListItem(TableFns.asTableMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_ListItem(CompositeFns.asCompositeMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_ListItem(NoteFns.asNoteMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isExpression(measurable)) { return ExpressionFns.calcGeometry_ListItem(ExpressionFns.asExpressionMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_ListItem(ImageFns.asImageMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable, inTable); }
    if (isFile(measurable)) { return FileFns.calcGeometry_ListItem(FileFns.asFileMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_ListItem(PasswordFns.asPasswordMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_ListItem(RatingFns.asRatingMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_ListItem(asLinkItem(measurable), blockSizePx, row, col, widthBl, parentIsPopup, padTop, expandable, inTable); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_ListItem(PlaceholderFns.asPlaceholderMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcGeometry_ListItem(FlipCardFns.asFlipCardMeasurable(measurable), blockSizePx, row, col, widthBl, padTop, expandable); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_InCell: (
    measurable: Measurable,
    cellBoundsPx: BoundingBox,
    expandable: boolean,
    parentIsPopup: boolean,
    parentIsDock: boolean,
    isPopup: boolean,
    hasChildChanges: boolean,
    hasDefaultChanges: boolean,
    maximize: boolean,
    ignoreCellHeight: boolean,
    smallScreenMode: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_InCell(PageFns.asPageMeasurable(measurable), cellBoundsPx, expandable, parentIsPopup, parentIsDock, isPopup, hasChildChanges, hasDefaultChanges, ignoreCellHeight, smallScreenMode); }
    if (isTable(measurable)) { return TableFns.calcGeometry_InCell(TableFns.asTableMeasurable(measurable), cellBoundsPx, maximize); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_InCell(CompositeFns.asCompositeMeasurable(measurable), cellBoundsPx, maximize); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_InCell(NoteFns.asNoteMeasurable(measurable), cellBoundsPx, maximize); }
    if (isExpression(measurable)) { return ExpressionFns.calcGeometry_InCell(ExpressionFns.asExpressionMeasurable(measurable), cellBoundsPx, maximize); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_InCell(ImageFns.asImageMeasurable(measurable), cellBoundsPx, isPopup, hasChildChanges, hasDefaultChanges); }
    if (isFile(measurable)) { return FileFns.calcGeometry_InCell(FileFns.asFileMeasurable(measurable), cellBoundsPx, maximize); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_InCell(PasswordFns.asPasswordMeasurable(measurable), cellBoundsPx, maximize); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_InCell(RatingFns.asRatingMeasurable(measurable), cellBoundsPx, maximize); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_InCell(asLinkItem(measurable), cellBoundsPx, expandable, parentIsPopup, parentIsDock, isPopup, hasChildChanges, hasDefaultChanges, maximize, ignoreCellHeight, smallScreenMode); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_InCell(PlaceholderFns.asPlaceholderMeasurable(measurable), cellBoundsPx); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcGeometry_InCell(FlipCardFns.asFlipCardMeasurable(measurable), cellBoundsPx, maximize); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  calcGeometry_Natural: (measurable: Measurable, desktopPx: Vector): ItemGeometry => {
    const sizeBl = ItemFns.calcSpatialDimensionsBl(measurable);
    const blockSizePx = {
      w: LINE_HEIGHT_PX,
      h: LINE_HEIGHT_PX
    };
    const boundsPx = {
      x: desktopPx.x,
      y: desktopPx.y,
      w: sizeBl.w * LINE_HEIGHT_PX,
      h: sizeBl.h * LINE_HEIGHT_PX
    };
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: boundsPx,
      hitboxes: []
    })
  },

  calcGeometry_InComposite: (
    measurable: Measurable,
    blockSizePx: Dimensions,
    compositeWidthBl: number,
    leftMarginBl: number,
    topPx: number,
    smallScreenMode: boolean): ItemGeometry => {
    if (isPage(measurable)) { return PageFns.calcGeometry_InComposite(PageFns.asPageMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx, smallScreenMode); }
    if (isTable(measurable)) { return TableFns.calcGeometry_InComposite(TableFns.asTableMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isComposite(measurable)) { return CompositeFns.calcGeometry_InComposite(CompositeFns.asCompositeMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isNote(measurable)) { return NoteFns.calcGeometry_InComposite(NoteFns.asNoteMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isExpression(measurable)) { return ExpressionFns.calcGeometry_InComposite(ExpressionFns.asExpressionMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isImage(measurable)) { return ImageFns.calcGeometry_InComposite(ImageFns.asImageMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isFile(measurable)) { return FileFns.calcGeometry_InComposite(FileFns.asFileMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isPassword(measurable)) { return PasswordFns.calcGeometry_InComposite(PasswordFns.asPasswordMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isRating(measurable)) { return RatingFns.calcGeometry_InComposite(RatingFns.asRatingMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isLink(measurable)) { return LinkFns.calcGeometry_InComposite(asLinkItem(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx, smallScreenMode); }
    if (isPlaceholder(measurable)) { return PlaceholderFns.calcGeometry_InComposite(PlaceholderFns.asPlaceholderMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    if (isFlipCard(measurable)) { return FlipCardFns.calcGeometry_InComposite(FlipCardFns.asFlipCardMeasurable(measurable), blockSizePx, compositeWidthBl, leftMarginBl, topPx); }
    panic(`Unknown item type: ${measurable.itemType}`);
  },

  /**
   * A string that uniquely represents rendered aspects of the item, excluding anything that
   * impacts properties of the visual element itself (i.e. the geometry).
   */
  getFingerprint: (item: Item): string => {
    if (isEmptyItem(item)) { return ""; }
    if (isPage(item)) { return PageFns.getFingerprint(asPageItem(item)); }
    if (isTable(item)) { return TableFns.getFingerprint(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.getFingerprint(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.getFingerprint(asNoteItem(item)); }
    if (isExpression(item)) { return ExpressionFns.getFingerprint(asExpressionItem(item)); }
    if (isImage(item)) { return ImageFns.getFingerprint(asImageItem(item)); }
    if (isFile(item)) { return FileFns.getFingerprint(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.getFingerprint(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.getFingerprint(asRatingItem(item)); }
    if (isLink(item)) { return LinkFns.getFingerprint(asLinkItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.getFingerprint(asPlaceholderItem(item)); }
    if (isFlipCard(item)) { return FlipCardFns.getFingerprint(asFlipCardItem(item)); }
    panic(`Unknown item type: ${item.itemType}`);
  },

  fromObject: (o: any, origin: string | null): Item => {
    if (isPage(o)) { return PageFns.fromObject(o, origin); }
    if (isTable(o)) { return TableFns.fromObject(o, origin); }
    if (isComposite(o)) { return CompositeFns.fromObject(o, origin); }
    if (isNote(o)) { return NoteFns.fromObject(o, origin); }
    if (isExpression(o)) { return ExpressionFns.fromObject(o, origin); }
    if (isImage(o)) { return ImageFns.fromObject(o, origin); }
    if (isFile(o)) { return FileFns.fromObject(o, origin); }
    if (isPassword(o)) { return PasswordFns.fromObject(o, origin); }
    if (isRating(o)) { return RatingFns.fromObject(o, origin); }
    if (isLink(o)) { return LinkFns.fromObject(o, origin); }
    if (isPlaceholder(o)) { return PlaceholderFns.fromObject(o, origin); }
    if (isFlipCard(o)) { return FlipCardFns.fromObject(o, origin); }
    panic(`fromObject: Unknown item type: ${o.itemType}`);
  },

  toObject: (item: Item): object => {
    if (isPage(item)) { return PageFns.toObject(asPageItem(item)); }
    if (isTable(item)) { return TableFns.toObject(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.toObject(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.toObject(asNoteItem(item)); }
    if (isExpression(item)) { return ExpressionFns.toObject(asExpressionItem(item)); }
    if (isImage(item)) { return ImageFns.toObject(asImageItem(item)); }
    if (isFile(item)) { return FileFns.toObject(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.toObject(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.toObject(asRatingItem(item)); }
    if (isLink(item)) { return LinkFns.toObject(asLinkItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.toObject(asPlaceholderItem(item)); }
    if (isFlipCard(item)) { return FlipCardFns.toObject(asFlipCardItem(item)); }
    panic(`toObject: Unknown item type: ${item.itemType}`);
  },

  handleClick: (visualElementSignal: VisualElementSignal, hitboxMeta: HitboxMeta | null, hitboxFlags: HitboxFlags, store: StoreContextModel): void => {
    const item = visualElementSignal.get().displayItem;
    if (isPage(item)) { PageFns.handleClick(visualElementSignal.get(), hitboxFlags, store); }
    else if (isTable(item)) { TableFns.handleClick(visualElementSignal.get(), hitboxMeta, store); }
    else if (isComposite(item)) { CompositeFns.handleClick(visualElementSignal.get(), store); }
    else if (isNote(item)) { NoteFns.handleClick(visualElementSignal.get(), store); }
    else if (isExpression(item)) { ExpressionFns.handleClick(visualElementSignal.get(), store); }
    else if (isImage(item)) { ImageFns.handleClick(visualElementSignal.get(), store); }
    else if (isFile(item)) { FileFns.handleClick(visualElementSignal.get(), store); }
    else if (isPassword(item)) { PasswordFns.handleClick(visualElementSignal.get(), store); }
    else if (isRating(item)) { RatingFns.handleClick(store, visualElementSignal); }
    else if (isLink(item)) { }
    else if (isPlaceholder(item)) { panic("handleClick: placeholder."); }
    else if (isFlipCard(item)) { }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  handleLinkClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const item = visualElement.displayItem;
    if (isPage(item)) { PageFns.handleLinkClick(visualElement, store); }
    else if (isTable(item)) { panic("handleLinkClick: table"); }
    else if (isComposite(item)) { panic("handleLinkClick: composite"); }
    else if (isNote(item)) { NoteFns.handleLinkClick(visualElement); }
    else if (isExpression(item)) { ExpressionFns.handleLinkClick(visualElement); }
    else if (isImage(item)) { ImageFns.handleLinkClick(visualElement, store); }
    else if (isFile(item)) { FileFns.handleLinkClick(visualElement); }
    else if (isPassword(item)) { panic("handleLinkClick: password"); }
    else if (isRating(item)) { panic("handleLinkClick: rating"); }
    else if (isLink(item)) { panic("handleLinkClick: link"); }
    else if (isPlaceholder(item)) { panic("handleLinkClick: placeholder"); }
    else if (isFlipCard(item)) { panic("handleLinkClick: flipcard"); }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  handleOpenPopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const item = visualElement.displayItem;
    if (isPage(item)) { PageFns.handleOpenPopupClick(visualElement, store); }
    else if (isTable(item)) { TableFns.handlePopupClick(visualElement, store); }
    else if (isComposite(item)) { CompositeFns.handlePopupClick(visualElement, store); }
    else if (isNote(item)) { NoteFns.handlePopupClick(visualElement, store); }
    else if (isExpression(item)) { ExpressionFns.handlePopupClick(visualElement, store); }
    else if (isImage(item)) { ImageFns.handleOpenPopupClick(visualElement, store); }
    else if (isFile(item)) { FileFns.handlePopupClick(visualElement, store); }
    else if (isPassword(item)) { PasswordFns.handlePopupClick(visualElement, store); }
    else if (isRating(item)) { }
    else if (isLink(item)) { }
    else if (isPlaceholder(item)) { panic("handleOpenPopupClick: placeholder"); }
    else if (isFlipCard(item)) { panic("handleOpenPopupClick: flipcard"); }
    else { panic(`Unknown item type: ${item.itemType}`); }
  },

  cloneMeasurableFields: (measurable: Measurable): Measurable => {
    if (measurable == null) { panic("measurable is null."); }
    if (isPage(measurable)) { return PageFns.cloneMeasurableFields(PageFns.asPageMeasurable(measurable)); }
    else if (isTable(measurable)) { return TableFns.cloneMeasurableFields(TableFns.asTableMeasurable(measurable)); }
    else if (isComposite(measurable)) { return CompositeFns.cloneMeasurableFields(CompositeFns.asCompositeMeasurable(measurable)); }
    else if (isNote(measurable)) { return NoteFns.cloneMeasurableFields(NoteFns.asNoteMeasurable(measurable)); }
    else if (isExpression(measurable)) { return ExpressionFns.cloneMeasurableFields(ExpressionFns.asExpressionMeasurable(measurable)); }
    else if (isImage(measurable)) { return ImageFns.cloneMeasurableFields(ImageFns.asImageMeasurable(measurable)); }
    else if (isFile(measurable)) { return FileFns.cloneMeasurableFields(FileFns.asFileMeasurable(measurable)); }
    else if (isPassword(measurable)) { return PasswordFns.cloneMeasurableFields(PasswordFns.asPasswordMeasurable(measurable)); }
    else if (isRating(measurable)) { return RatingFns.cloneMeasurableFields(RatingFns.asRatingMeasurable(measurable)); }
    else if (isLink(measurable)) { return LinkFns.cloneMeasurableFields(LinkFns.asLinkMeasurable(measurable)); }
    else if (isPlaceholder(measurable)) { return PlaceholderFns.cloneMeasurableFields(PlaceholderFns.asPlaceholderMeasurable(measurable)); }
    else if (isFlipCard(measurable)) { return FlipCardFns.cloneMeasurableFields(FlipCardFns.asFlipCardMeasurable(measurable)); }
    else { panic(`cloneMeasurableFields: Unknown item type: ${measurable.itemType}`); }
  },

  debugSummary: (item: Item): string => {
    if (item == null) { return "null"; }
    if (isPage(item)) { return PageFns.debugSummary(asPageItem(item)); }
    if (isTable(item)) { return TableFns.debugSummary(asTableItem(item)); }
    if (isComposite(item)) { return CompositeFns.debugSummary(asCompositeItem(item)); }
    if (isNote(item)) { return NoteFns.debugSummary(asNoteItem(item)); }
    if (isExpression(item)) { return ExpressionFns.debugSummary(asExpressionItem(item)); }
    if (isFile(item)) { return FileFns.debugSummary(asFileItem(item)); }
    if (isPassword(item)) { return PasswordFns.debugSummary(asPasswordItem(item)); }
    if (isRating(item)) { return RatingFns.debugSummary(asRatingItem(item)); }
    if (isImage(item)) { return ImageFns.debugSummary(asImageItem(item)); }
    if (isPlaceholder(item)) { return PlaceholderFns.debugSummary(asPlaceholderItem(item)); }
    if (isLink(item)) { return LinkFns.debugSummary(asLinkItem(item)); }
    if (isFlipCard(item)) { return FlipCardFns.debugSummary(asFlipCardItem(item)); }
    return "[unknown]";
  },

  /**
   * Computes a hash of the item including only properties relevant for the item type
   */
  hash: (item: Item): Uid => {
    const hashes: Uid[] = [];

    // Base properties (always included)
    hashes.push(hashStringToUid(item.itemType));
    hashes.push(hashStringToUid(item.id));
    hashes.push(hashStringToUid(item.ownerId));
    hashes.push(hashStringToUid(item.parentId || "null"));
    hashes.push(hashStringToUid(item.relationshipToParent));
    hashes.push(hashI64ToUid(item.creationDate));
    hashes.push(hashI64ToUid(item.lastModifiedDate));
    hashes.push(hashI64ToUid(item.dateTime));
    hashes.push(hashU8VecToUid(item.ordering));

    // Container properties
    if (isContainer(item)) {
      const containerItem = item as any;
      if (containerItem.orderChildrenBy) {
        hashes.push(hashStringToUid(containerItem.orderChildrenBy));
      }
    }

    // Positional properties
    if (isPositionalItem(item)) {
      const positionalItem = item as any;
      if (positionalItem.spatialPositionGr) {
        const posStr = `${positionalItem.spatialPositionGr.x},${positionalItem.spatialPositionGr.y}`;
        hashes.push(hashStringToUid(posStr));
      }
    }

    // X-sizeable properties
    if (isXSizableItem(item) || isLink(item)) {
      const xSizableItem = item as any;
      if (xSizableItem.spatialWidthGr !== undefined) {
        hashes.push(hashI64ToUid(xSizableItem.spatialWidthGr));
      }
    }

    // Y-sizeable properties
    if (isYSizableItem(item) || isLink(item)) {
      const ySizableItem = item as any;
      if (ySizableItem.spatialHeightGr !== undefined) {
        hashes.push(hashI64ToUid(ySizableItem.spatialHeightGr));
      }
    }

    // Titled properties
    if (isTitledItem(item)) {
      const titledItem = item as any;
      if (titledItem.title) {
        hashes.push(hashStringToUid(titledItem.title));
      }
    }

    // Data properties
    if (isDataItem(item)) {
      const dataItem = item as any;
      if (dataItem.originalCreationDate !== undefined) {
        hashes.push(hashI64ToUid(dataItem.originalCreationDate));
      }
      if (dataItem.mimeType) {
        hashes.push(hashStringToUid(dataItem.mimeType));
      }
      if (dataItem.fileSizeBytes !== undefined) {
        hashes.push(hashI64ToUid(dataItem.fileSizeBytes));
      }
    }

    // Tabular properties
    if (isTabularItem(item)) {
      const tabularItem = item as any;
      if (tabularItem.tableColumns) {
        const columnsStr = tabularItem.tableColumns
          .map((col: any) => `${col.widthGr}:${col.name}`)
          .join(';');
        hashes.push(hashStringToUid(columnsStr));
      }
      if (tabularItem.numberOfVisibleColumns !== undefined) {
        hashes.push(hashI64ToUid(tabularItem.numberOfVisibleColumns));
      }
    }

    // Flags properties
    if (isFlagsItem(item)) {
      const flagsItem = item as any;
      if (flagsItem.flags !== undefined) {
        hashes.push(hashI64ToUid(flagsItem.flags));
      }
    }

    // Format properties
    if (isFormatItem(item)) {
      const formatItem = item as any;
      if (formatItem.format) {
        hashes.push(hashStringToUid(formatItem.format));
      }
    }

    // Permission flags properties
    if (isPermissionFlagsItem(item)) {
      const permissionFlagsItem = item as any;
      if (permissionFlagsItem.permissionFlags !== undefined) {
        hashes.push(hashI64ToUid(permissionFlagsItem.permissionFlags));
      }
    }

    // Colorable properties
    if (isColorableItem(item)) {
      const colorableItem = item as any;
      if (colorableItem.backgroundColorIndex !== undefined) {
        hashes.push(hashI64ToUid(colorableItem.backgroundColorIndex));
      }
    }

    // Aspect properties
    if (isAspectItem(item)) {
      const aspectItem = item as any;
      if (aspectItem.naturalAspect !== undefined) {
        hashes.push(hashF64ToUid(aspectItem.naturalAspect));
      }
    }

    // Page-specific properties
    if (isPage(item)) {
      const pageItem = item as any;
      if (pageItem.innerSpatialWidthGr !== undefined) {
        hashes.push(hashI64ToUid(pageItem.innerSpatialWidthGr));
      }
      if (pageItem.arrangeAlgorithm) {
        hashes.push(hashStringToUid(pageItem.arrangeAlgorithm));
      }
      if (pageItem.defaultPopupPositionGr) {
        const posStr = `${pageItem.defaultPopupPositionGr.x},${pageItem.defaultPopupPositionGr.y}`;
        hashes.push(hashStringToUid(posStr));
      }
      if (pageItem.defaultPopupWidthGr !== undefined) {
        hashes.push(hashI64ToUid(pageItem.defaultPopupWidthGr));
      }
      if (pageItem.popupPositionGr) {
        const posStr = `${pageItem.popupPositionGr.x},${pageItem.popupPositionGr.y}`;
        hashes.push(hashStringToUid(posStr));
      }
      if (pageItem.popupWidthGr !== undefined && pageItem.popupWidthGr !== null) {
        hashes.push(hashI64ToUid(pageItem.popupWidthGr));
      }
      if (pageItem.defaultCellPopupPositionNorm) {
        const posStr = `${pageItem.defaultCellPopupPositionNorm.x},${pageItem.defaultCellPopupPositionNorm.y}`;
        hashes.push(hashStringToUid(posStr));
      }
      if (pageItem.defaultCellPopupWidthNorm !== undefined) {
        hashes.push(hashF64ToUid(pageItem.defaultCellPopupWidthNorm));
      }
      if (pageItem.cellPopupPositionNorm) {
        const posStr = `${pageItem.cellPopupPositionNorm.x},${pageItem.cellPopupPositionNorm.y}`;
        hashes.push(hashStringToUid(posStr));
      }
      if (pageItem.cellPopupWidthNorm !== undefined && pageItem.cellPopupWidthNorm !== null) {
        hashes.push(hashF64ToUid(pageItem.cellPopupWidthNorm));
      }
      if (pageItem.gridNumberOfColumns !== undefined) {
        hashes.push(hashI64ToUid(pageItem.gridNumberOfColumns));
      }
      if (pageItem.gridCellAspect !== undefined) {
        hashes.push(hashF64ToUid(pageItem.gridCellAspect));
      }
      if (pageItem.docWidthBl !== undefined) {
        hashes.push(hashI64ToUid(pageItem.docWidthBl));
      }
      if (pageItem.justifiedRowAspect !== undefined) {
        hashes.push(hashF64ToUid(pageItem.justifiedRowAspect));
      }
      if (pageItem.calendarDayRowHeightBl !== undefined) {
        hashes.push(hashF64ToUid(pageItem.calendarDayRowHeightBl));
      }
    }

    // Note-specific properties
    if (isNote(item)) {
      const noteItem = item as any;
      if (noteItem.url) {
        hashes.push(hashStringToUid(noteItem.url));
      }
    }

    // Password-specific properties
    if (isPassword(item)) {
      const passwordItem = item as any;
      if (passwordItem.text) {
        hashes.push(hashStringToUid(passwordItem.text));
      }
    }

    // Image-specific properties
    if (isImage(item)) {
      const imageItem = item as any;
      if (imageItem.imageSizePx) {
        const sizeStr = `${imageItem.imageSizePx.w},${imageItem.imageSizePx.h}`;
        hashes.push(hashStringToUid(sizeStr));
      }
      if (imageItem.thumbnail) {
        hashes.push(hashStringToUid(imageItem.thumbnail));
      }
    }

    // Rating-specific properties
    if (isRating(item)) {
      const ratingItem = item as any;
      if (ratingItem.rating !== undefined) {
        hashes.push(hashI64ToUid(ratingItem.rating));
      }
      if (ratingItem.ratingType) {
        hashes.push(hashStringToUid(ratingItem.ratingType));
      }
    }

    // Link-specific properties
    if (isLink(item)) {
      const linkItem = item as any;
      if (linkItem.linkTo) {
        hashes.push(hashStringToUid(linkItem.linkTo));
      }
    }

    // FlipCard-specific properties
    if (isFlipCard(item)) {
      const flipCardItem = item as any;
      if (flipCardItem.scale !== undefined) {
        hashes.push(hashF64ToUid(flipCardItem.scale));
      }
    }

    // Combine all hashes
    return combineHashes(hashes);
  }
};
