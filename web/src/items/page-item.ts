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

import { ANCHOR_BOX_SIZE_PX, ATTACH_AREA_SIZE_PX, NATURAL_BLOCK_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, LINE_HEIGHT_PX, RESIZE_BOX_SIZE_PX, PAGE_POPUP_TITLE_HEIGHT_BL, PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL } from '../constants';
import { HitboxFlags, HitboxFns } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, cloneDimensions, Dimensions, Vector, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, TOP_LEVEL_PAGE_UID, Uid } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemTypeMixin, ItemType } from './base/item';
import { TitledItem } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { StoreContextModel } from '../store/StoreProvider';
import { PositionalMixin } from './base/positional-item';
import { VisualElement, VisualElementFlags, VeFns, Veid } from '../layout/visual-element';
import { VesCache } from '../layout/ves-cache';
import { PermissionFlags, PermissionFlagsMixin } from './base/permission-flags-item';
import { calcBoundsInCell, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { switchToPage } from '../layout/navigation';
import { arrange } from '../layout/arrange';
import { itemState } from '../store/ItemState';
import { InfuTextStyle, getTextStyleForNote, measureWidthBl } from '../layout/text';
import { FlagsMixin, NoteFlags, PageFlags } from './base/flags-item';
import { server } from '../server';
import { ItemFns } from './base/item-polymorphism';
import { isTable } from './table-item';
import { PopupType } from '../store/StoreProvider_History';
import { RelationshipToParent } from '../layout/relationship-to-parent';
import { newOrdering } from '../util/ordering';


export const ArrangeAlgorithm = {
  SpatialStretch: "spatial-stretch",
  Grid: "grid",
  Justified: "justified",
  List: "list",
  Document: "document",
  Dock: "dock",
};

export interface PageItem extends PageMeasurable, XSizableItem, ContainerItem, AttachmentsItem, TitledItem, PermissionFlagsMixin, Item {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  backgroundColorIndex: number;
  arrangeAlgorithm: string;
  gridNumberOfColumns: number;
  gridCellAspect: number;
  docWidthBl: number;
  justifiedRowAspect: number;
  popupPositionGr: Vector;
  popupAlignmentPoint: string;
  popupWidthGr: number;

  pendingPopupPositionGr: Vector | null;
  pendingPopupWidthGr: number | null;
  pendingPopupAlignmentPoint: string | null;
}

export interface PageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin {
  innerSpatialWidthGr: number;
  naturalAspect: number;
  arrangeAlgorithm: string;
  id: Uid;
  childrenLoaded: boolean;
  gridNumberOfColumns: number;
  gridCellAspect: number;
  docWidthBl: number,
  justifiedRowAspect: number;
  computed_children: Array<Uid>;
}


export const PageFns = {
  topLevelPage: () => topLevelPage(),

  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): PageItem => {
    return ({
      origin: null,
      itemType: ItemType.Page,
      ownerId,
      id: newUid(),
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      ordering,
      title,
      spatialPositionGr: { x: 0.0, y: 0.0 },

      spatialWidthGr: 4.0 * GRID_SIZE,

      innerSpatialWidthGr: 60.0 * GRID_SIZE,
      naturalAspect: 2.0,
      backgroundColorIndex: 0,
      arrangeAlgorithm: ArrangeAlgorithm.SpatialStretch,
      popupPositionGr: { x: 30.0 * GRID_SIZE, y: 15.0 * GRID_SIZE },
      popupAlignmentPoint: "center",
      popupWidthGr: 10.0 * GRID_SIZE,
      gridNumberOfColumns: 6,
      gridCellAspect: 1.5,
      docWidthBl: 36,
      justifiedRowAspect: 6.0,

      orderChildrenBy: "title[ASC]",

      flags: PageFlags.None,
      permissionFlags: PermissionFlags.None,

      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,

      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,
      pendingPopupAlignmentPoint: null,
    });
  },

  fromObject: (o: any, origin: string | null): PageItem => {
    // TODO: dynamic type check of o.
    return ({
      origin,
      itemType: o.itemType,
      ownerId: o.ownerId,
      id: o.id,
      parentId: o.parentId ? o.parentId : null,
      relationshipToParent: o.relationshipToParent,
      creationDate: o.creationDate,
      lastModifiedDate: o.lastModifiedDate,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,

      spatialWidthGr: o.spatialWidthGr,

      innerSpatialWidthGr: o.innerSpatialWidthGr,
      naturalAspect: o.naturalAspect,
      backgroundColorIndex: o.backgroundColorIndex,
      arrangeAlgorithm: o.arrangeAlgorithm,
      popupPositionGr: o.popupPositionGr,
      popupAlignmentPoint: o.popupAlignmentPoint,
      popupWidthGr: o.popupWidthGr,
      gridNumberOfColumns: o.gridNumberOfColumns,
      gridCellAspect: o.gridCellAspect,
      docWidthBl: o.docWidthBl,
      justifiedRowAspect: o.justifiedRowAspect,

      orderChildrenBy: o.orderChildrenBy,

      flags: o.flags,
      permissionFlags: o.permissionFlags,

      computed_children: [],
      computed_attachments: [],

      childrenLoaded: false,

      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,
      pendingPopupAlignmentPoint: null,
    });
  },

  toObject: (p: PageItem): object => {
    return ({
      itemType: p.itemType,
      ownerId: p.ownerId,
      id: p.id,
      parentId: p.parentId == EMPTY_UID ? null : p.parentId,
      relationshipToParent: p.relationshipToParent,
      creationDate: p.creationDate,
      lastModifiedDate: p.lastModifiedDate,
      ordering: Array.from(p.ordering),
      title: p.title,
      spatialPositionGr: p.spatialPositionGr,

      spatialWidthGr: p.spatialWidthGr,

      innerSpatialWidthGr: p.innerSpatialWidthGr,
      naturalAspect: p.naturalAspect,
      backgroundColorIndex: p.backgroundColorIndex,
      arrangeAlgorithm: p.arrangeAlgorithm,
      popupPositionGr: p.popupPositionGr,
      popupAlignmentPoint: p.popupAlignmentPoint,
      popupWidthGr: p.popupWidthGr,
      gridNumberOfColumns: p.gridNumberOfColumns,
      gridCellAspect: p.gridCellAspect,
      docWidthBl: p.docWidthBl,
      justifiedRowAspect: p.justifiedRowAspect,

      orderChildrenBy: p.orderChildrenBy,

      permissionFlags: p.permissionFlags,
      flags: p.flags,
    });
  },

  pageTitleStyle: (): InfuTextStyle => {
    const flags = NoteFlags.Heading2;
    return getTextStyleForNote(flags);
  },

  pageTitleStyle_List: (): InfuTextStyle => {
    const flags = NoteFlags.Heading3;
    return getTextStyleForNote(flags);
  },

  calcTitleSpatialDimensionsBl: (page: PageItem): Dimensions => {
    const style = PageFns.pageTitleStyle();
    const widthBl = measureWidthBl(page.title, style);
    return { w: widthBl, h: style.lineHeightMultiplier };
  },

  calcSpatialDimensionsBl: (page: PageMeasurable, adjustBl?: Dimensions): Dimensions => {
    let bh = Math.round(page.spatialWidthGr / GRID_SIZE / page.naturalAspect * 2.0) / 2.0;
    const result = { w: page.spatialWidthGr / GRID_SIZE, h: bh < 0.5 ? 0.5 : bh };
    if (adjustBl) {
      result.h += adjustBl.h;
      result.w += adjustBl.w;
    }
    return result;
  },

  calcInnerSpatialDimensionsBl: (page: PageMeasurable): Dimensions => {
    return ({
      w: page.innerSpatialWidthGr / GRID_SIZE,
      h: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect)
    });
  },

  calcGeometry_Spatial: (
      page: PageMeasurable, containerBoundsPx: BoundingBox, containerInnerSizeBl: Dimensions,
      parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean, hasPendingChanges: boolean): ItemGeometry => {

    const sizeBl = PageFns.calcSpatialDimensionsBl(page);
    const blockSizePx = {
      w: containerBoundsPx.w / containerInnerSizeBl.w,
      h: containerBoundsPx.h / containerInnerSizeBl.h
    };
    const boundsPx = {
      x: (page.spatialPositionGr.x / GRID_SIZE) * blockSizePx.w + containerBoundsPx.x,
      y: (page.spatialPositionGr.y / GRID_SIZE) * blockSizePx.h + containerBoundsPx.y,
      w: sizeBl.w * blockSizePx.w + ITEM_BORDER_WIDTH_PX,
      h: sizeBl.h * blockSizePx.h + ITEM_BORDER_WIDTH_PX,
    };

    if (!isPopup && !(page.flags & PageFlags.EmbeddedInteractive)) {
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
      const popupClickBoundsPx = parentIsPopup
        ? cloneBoundingBox(innerBoundsPx)!
        : { x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
            w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0 };
      return ({
        boundsPx,
        blockSizePx,
        viewportBoundsPx: boundsPx,
        hitboxes: !emitHitboxes ? [] : [
          HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
          HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
          HitboxFns.create(HitboxFlags.OpenPopup, popupClickBoundsPx),
          HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }),
          HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
        ],
      });
    }

    let headerHeightBl = isPopup ? PAGE_POPUP_TITLE_HEIGHT_BL : PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL;
    let viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h = boundsPx.h + headerHeightBl * blockSizePx.h;
    viewportBoundsPx.y = viewportBoundsPx.y + headerHeightBl * blockSizePx.h;

    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    const hitboxes = [
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX + blockSizePx.h * headerHeightBl, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
    ];

    if (hasPendingChanges && isPopup) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Anchor, { x: innerBoundsPx.w - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, w: ANCHOR_BOX_SIZE_PX, h: ANCHOR_BOX_SIZE_PX }));
    }

    const result = {
      boundsPx,
      viewportBoundsPx,
      blockSizePx,
      hitboxes: !emitHitboxes ? [] : hitboxes,
    };

    return result;
  },

  calcGeometry_InCell: (page: PageMeasurable, cellBoundsPx: BoundingBox, expandable: boolean, parentIsPopup: boolean, isPopup: boolean, hasPendingChanges: boolean): ItemGeometry => {
    const sizeBl = PageFns.calcSpatialDimensionsBl(page);
    const boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    if (!isPopup && !(page.flags & PageFlags.EmbeddedInteractive)) {
      if (expandable) {
        const hitboxes = [
          HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
          HitboxFns.create(HitboxFlags.Expand, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
          HitboxFns.create(HitboxFlags.Expand, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
          HitboxFns.create(HitboxFlags.Expand, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
        ];
        return ({
          boundsPx: cloneBoundingBox(boundsPx)!,
          blockSizePx: NATURAL_BLOCK_SIZE_PX,
          viewportBoundsPx: boundsPx,
          hitboxes
        });
      }

      const popupClickBoundsPx = parentIsPopup
        ? cloneBoundingBox(innerBoundsPx)!
        : { x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
            w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0 };

      const hitboxes = [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, popupClickBoundsPx),
      ];

      return ({
        boundsPx: cloneBoundingBox(boundsPx)!,
        viewportBoundsPx: cloneBoundingBox(boundsPx)!,
        blockSizePx: NATURAL_BLOCK_SIZE_PX,
        hitboxes,
      });
    }

    // TODO (HIGH): this is not what is needed, but will do as a placeholder for now.
    let blockSizePx = cloneDimensions(NATURAL_BLOCK_SIZE_PX)!;
    let headerHeightBl = isPopup ? PAGE_POPUP_TITLE_HEIGHT_BL : PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL;
    let viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h = boundsPx.h + headerHeightBl * blockSizePx.h;
    viewportBoundsPx.y = viewportBoundsPx.y + headerHeightBl * blockSizePx.h;

    const hitboxes = [
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
    ];

    if (hasPendingChanges) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Anchor, { x: innerBoundsPx.w - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, w: ANCHOR_BOX_SIZE_PX, h: ANCHOR_BOX_SIZE_PX }));
    }

    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx,
      hitboxes,
    });
  },

  calcGeometry_InComposite: (measurable: PageMeasurable, blockSizePx: Dimensions, compositeWidthBl: number, leftMarginBl: number, topPx: number): ItemGeometry => {
    let cloned = PageFns.asPageMeasurable(ItemFns.cloneMeasurableFields(measurable));
    cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    const sizeBl = PageFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w,
      y: topPx,
      w: compositeWidthBl * blockSizePx.w,
      h: sizeBl.h * blockSizePx.h
    };
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx: boundsPx,
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

  calcGeometry_Attachment: (page: PageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(page, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_page: PageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, parentIsPopup: boolean): ItemGeometry => {
    const innerBoundsPx = {
      x: 0.0,
      y: 0.0,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const boundsPx = {
      x: blockSizePx.w * col,
      y: blockSizePx.h * row,
      w: blockSizePx.w * widthBl,
      h: blockSizePx.h
    };
    const clickAreaBoundsPx = {
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = parentIsPopup
      ? { x: 0.0, y: 0.0, w: boundsPx.w, h: boundsPx.h }
      : { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
      ]
    });
  },

  asPageMeasurable: (item: ItemTypeMixin): PageMeasurable => {
    if (item.itemType == ItemType.Page) { return item as PageMeasurable; }
    panic("not page measurable.");
  },

  handleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    switchToPage(store, VeFns.actualVeidFromVe(visualElement), true, false);
  },

  handleOpenPopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const parentVe = VesCache.get(visualElement.parentPath!)!.get();

    // line item in list page.
    const parentItem = parentVe.displayItem;
    if ((visualElement.flags & VisualElementFlags.LineItem) && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
      store.perItem.setSelectedListPageItem(VeFns.veidFromPath(visualElement.parentPath!), VeFns.veToPath(visualElement));
      arrange(store);
      return;
    }

    // inside a popup.
    let insidePopup = parentVe.flags & VisualElementFlags.Popup ? true : false;
    if (isTable(parentVe.displayItem)) {
      const parentParentVe = VesCache.get(parentVe.parentPath!)!.get();
      if (parentParentVe.flags & VisualElementFlags.Popup) { insidePopup = true; }
    }
    if (insidePopup) {
      store.history.pushPopup({ type: PopupType.Page, vePath: VeFns.veToPath(visualElement) });
      arrange(store);
      return;
    }

    // not inside popup.
    store.history.replacePopup({ type: PopupType.Page, vePath: VeFns.veToPath(visualElement) });
    arrange(store);
  },

  handleAnchorClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const popupParentPage = asPageItem(itemState.get(VesCache.get(visualElement.parentPath!)!.get().displayItem.id)!);
    if (popupParentPage.pendingPopupPositionGr != null) {
      popupParentPage.popupPositionGr = popupParentPage.pendingPopupPositionGr!;
    }
    if (popupParentPage.pendingPopupWidthGr != null) {
      popupParentPage.popupWidthGr = popupParentPage.pendingPopupWidthGr;
    }
    if (popupParentPage.pendingPopupAlignmentPoint != null) {
      popupParentPage.popupAlignmentPoint = popupParentPage.pendingPopupAlignmentPoint;
    }
    server.updateItem(popupParentPage);
    arrange(store);
  },

  handleExpandClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const parentVeid = VeFns.veidFromPath(visualElement.parentPath!);
    const selectedPath = store.perItem.getSelectedListPageItem(parentVeid);
    const selectedVeid = VeFns.veidFromPath(selectedPath);
    switchToPage(store, selectedVeid, true, false);
  },

  cloneMeasurableFields: (page: PageMeasurable): PageMeasurable => {
    return ({
      itemType: page.itemType,
      id: page.id,
      spatialPositionGr: page.spatialPositionGr,
      spatialWidthGr: page.spatialWidthGr,
      naturalAspect: page.naturalAspect,
      innerSpatialWidthGr: page.innerSpatialWidthGr,
      arrangeAlgorithm: page.arrangeAlgorithm,
      gridNumberOfColumns: page.gridNumberOfColumns,
      gridCellAspect: page.gridCellAspect,
      docWidthBl: page.docWidthBl,
      justifiedRowAspect: page.justifiedRowAspect,
      childrenLoaded: page.childrenLoaded,
      computed_children: page.computed_children,
      flags: page.flags,
    });
  },

  debugSummary: (pageItem: PageItem) => {
    return "[page] " + pageItem.title;
  },

  getPopupPositionGr: (pageItem: PageItem): Vector => {
    if (pageItem.pendingPopupPositionGr != null) {
      return pageItem.pendingPopupPositionGr;
    }
    return pageItem.popupPositionGr;
  },

  getPopupWidthGr: (pageItem: PageItem): number => {
    if (pageItem.pendingPopupWidthGr != null) {
      return pageItem.pendingPopupWidthGr;
    }
    return pageItem.popupWidthGr;
  },

  popupPositioningHasChanged: (pageItem: PageItem): boolean => {
    if (pageItem.pendingPopupPositionGr != null) {
      if (pageItem.pendingPopupPositionGr!.x != pageItem.popupPositionGr.x ||
          pageItem.pendingPopupPositionGr!.y != pageItem.popupPositionGr.y) {
        return true;
      }
    }
    if (pageItem.pendingPopupWidthGr != null) {
      if (pageItem.pendingPopupWidthGr != pageItem.popupWidthGr) {
        return true;
      }
    }
    return false;
  },

  getFingerprint: (pageItem: PageItem): string => {
    return pageItem.backgroundColorIndex + "~~~!@#~~~" + pageItem.title + "~~!@#~~~" + pageItem.arrangeAlgorithm + "~~!@#~~~" + pageItem.flags + "~~!@#~~~" + pageItem.permissionFlags;
  },

  setDefaultListPageSelectedItemMaybe: (store: StoreContextModel, itemVeid: Veid): void => {
    if (store.perItem.getSelectedListPageItem(itemVeid) != "") { return; }
    const item = itemState.get(itemVeid.itemId)!;
    if (isPage(item)) {
      const page = asPageItem(item);
      if (page.arrangeAlgorithm == ArrangeAlgorithm.List) {
        if (page.computed_children.length > 0) {
          const firstItemId = page.computed_children[0];
          const veid = VeFns.veidFromId(firstItemId);
          const path = VeFns.addVeidToPath(veid, page.id);
          store.perItem.setSelectedListPageItem(itemVeid, path);
        }
      }
    }
  }
};


export function isPage(item: ItemTypeMixin | null): boolean {
  if (item == null) { return false; }
  return item.itemType == ItemType.Page;
}

export function asPageItem(item: ItemTypeMixin): PageItem {
  if (item.itemType == ItemType.Page) { return item as PageItem; }
  const item_any: any = item;
  const id = item_any["id"] ? item_any["id"] : "[unknown]";
  panic(`item (id: ${id}) is a '${item.itemType}', not a page.`);
}

const topLevelPage = () => {
  const result = PageFns.create(EMPTY_UID, EMPTY_UID, RelationshipToParent.NoParent, "", newOrdering());
  result.id = TOP_LEVEL_PAGE_UID;
  return result;
}
