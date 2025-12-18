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

import { ANCHOR_BOX_SIZE_PX, ATTACH_AREA_SIZE_PX, NATURAL_BLOCK_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, ITEM_BORDER_WIDTH_PX, RESIZE_BOX_SIZE_PX, PAGE_POPUP_TITLE_HEIGHT_BL, PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL, LIST_PAGE_TOP_PADDING_PX, PADDING_PROP, CONTAINER_IN_COMPOSITE_PADDING_PX, LINE_HEIGHT_PX, ANCHOR_OFFSET_PX } from '../constants';
import { HitboxFlags, HitboxFns, HitboxMeta } from '../layout/hitbox';
import { BoundingBox, cloneBoundingBox, cloneDimensions, Dimensions, Vector, zeroBoundingBoxTopLeft } from '../util/geometry';
import { currentUnixTimeSeconds, panic } from '../util/lang';
import { EMPTY_UID, newUid, UMBRELLA_PAGE_UID, Uid, SOLO_ITEM_HOLDER_PAGE_UID } from '../util/uid';
import { AttachmentsItem, calcGeometryOfAttachmentItemImpl } from './base/attachments-item';
import { ContainerItem } from './base/container-item';
import { Item, ItemTypeMixin, ItemType } from './base/item';
import { TitledItem } from './base/titled-item';
import { XSizableItem, XSizableMixin } from './base/x-sizeable-item';
import { ItemGeometry } from '../layout/item-geometry';
import { StoreContextModel } from '../store/StoreProvider';
import { PositionalMixin } from './base/positional-item';
import { VisualElement, VisualElementFlags, VeFns, Veid, EMPTY_VEID } from '../layout/visual-element';
import { VesCache } from '../layout/ves-cache';
import { PermissionFlags, PermissionFlagsMixin } from './base/permission-flags-item';
import { calcBoundsInCell, handleListPageLineItemClickMaybe } from './base/item-common-fns';
import { switchToPage } from '../layout/navigation';
import { fullArrange } from '../layout/arrange';
import { itemState } from '../store/ItemState';
import { InfuTextStyle, getTextStyleForNote, measureWidthBl } from '../layout/text';
import { FlagsMixin, NoteFlags, PageFlags } from './base/flags-item';
import { serverOrRemote } from '../server';
import { ItemFns } from './base/item-polymorphism';
import { isTable } from './table-item';
import { RelationshipToParent } from '../layout/relationship-to-parent';
import { compareOrderings, newOrdering, newOrderingAfter } from '../util/ordering';
import { closestCaretPositionToClientPx, setCaretPosition } from '../util/caret';
import { CursorEventState, MouseActionState } from '../input/state';
import { TabularItem, TabularMixin } from './base/tabular-item';
import { ColorableMixin } from './base/colorable-item';
import { AspectItem, AspectMixin } from './base/aspect-item';
import { markChildrenLoadAsInitiatedOrComplete } from '../layout/load';


export const ArrangeAlgorithm = {
  None: "none",
  SpatialStretch: "spatial-stretch",
  Grid: "grid",
  Justified: "justified",
  List: "list",
  Document: "document",
  Dock: "dock",
  Composite: "composite",
  SingleCell: "single-cell",
  Calendar: "calendar",
};

export interface PageItem extends PageMeasurable, TabularItem, XSizableItem, ContainerItem, AttachmentsItem, TitledItem, PermissionFlagsMixin, ColorableMixin, AspectItem, Item {
  innerSpatialWidthGr: number;
  arrangeAlgorithm: string;
  gridNumberOfColumns: number;
  gridCellAspect: number;
  docWidthBl: number;
  justifiedRowAspect: number;
  calendarDayRowHeightBl: number;
  defaultPopupPositionGr: Vector;
  defaultPopupWidthGr: number;
  popupPositionGr: Vector | null;
  popupWidthGr: number | null;

  pendingPopupPositionGr: Vector | null;
  pendingPopupWidthGr: number | null;

  defaultCellPopupPositionNorm: Vector;
  defaultCellPopupWidthNorm: number;
  cellPopupPositionNorm: Vector | null;
  cellPopupWidthNorm: number | null;
  pendingCellPopupPositionNorm: Vector | null;
  pendingCellPopupWidthNorm: number | null;
}

export interface PageMeasurable extends ItemTypeMixin, PositionalMixin, XSizableMixin, FlagsMixin, TabularMixin, AspectMixin {
  innerSpatialWidthGr: number;
  arrangeAlgorithm: string;
  id: Uid;
  gridNumberOfColumns: number;
  gridCellAspect: number;
  docWidthBl: number,
  justifiedRowAspect: number;
  calendarDayRowHeightBl: number;

  childrenLoaded: boolean;
  computed_children: Array<Uid>;
}


export const PageFns = {
  findOutermostListPage: (visualElement: VisualElement): VisualElement => {
    let targetVe = visualElement;
    let currVe: VisualElement | null = visualElement;
    while (currVe != null) {
      if (isPage(currVe.displayItem) && asPageItem(currVe.displayItem).arrangeAlgorithm === ArrangeAlgorithm.List) {
        targetVe = currVe;
      }
      if (currVe.flags & VisualElementFlags.Popup) {
        break;
      }
      currVe = currVe.parentPath ? VesCache.get(currVe.parentPath)?.get() ?? null : null;
    }
    return targetVe;
  },

  switchToOutermostListPageMaybe: (visualElement: VisualElement, store: StoreContextModel): void => {
    const targetVe = PageFns.findOutermostListPage(visualElement);
    // If the target is currently rendered as a popup and doesn't already have focus,
    // don't switch pages - just let focus be set on the popup.
    // But if it already has focus (user clicking again), make it the root.
    if ((targetVe.flags & VisualElementFlags.Popup) && !(targetVe.flags & VisualElementFlags.HasToolbarFocus)) {
      return;
    }
    const targetVeid = VeFns.actualVeidFromVe(targetVe);
    const currentVeid = store.history.currentPageVeid();
    if (isPage(targetVe.displayItem) && (targetVeid.itemId !== currentVeid?.itemId || targetVeid.linkIdMaybe !== currentVeid?.linkIdMaybe)) {
      let focusPath = VeFns.computeFocusPathRelativeToRoot(visualElement, targetVeid);

      // If we're clicking directly on the root list page (not through a nested child),
      // restore focus to a previously focused page or the deepest selected page.
      const clickedVeid = VeFns.actualVeidFromVe(visualElement);
      if (clickedVeid.itemId === targetVeid.itemId && clickedVeid.linkIdMaybe === targetVeid.linkIdMaybe) {
        // First check if there's a saved focused page for this list page
        const savedFocusedVeid = store.perItem.getFocusedListPageItem(targetVeid);
        let targetFocusVeid: Veid | null = null;

        if (savedFocusedVeid && savedFocusedVeid !== EMPTY_VEID && savedFocusedVeid.itemId !== "") {
          // Use the saved focused page
          targetFocusVeid = savedFocusedVeid;
          // Clear the saved focus after using it
          store.perItem.clearFocusedListPageItem(targetVeid);
        } else {
          // No saved focus - walk down the selected items chain to find the deepest selected page
          let currentVeid = targetVeid;
          const MAX_DEPTH = 10;

          for (let i = 0; i < MAX_DEPTH; i++) {
            const selectedVeid = store.perItem.getSelectedListPageItem(currentVeid);
            if (!selectedVeid || selectedVeid === EMPTY_VEID || selectedVeid.itemId === "") {
              break;
            }

            const selectedItem = itemState.get(selectedVeid.itemId);
            // Only track pages as potential focus targets (non-pages won't be in topTitledPages)
            if (selectedItem && isPage(selectedItem)) {
              targetFocusVeid = selectedVeid;
            }

            // Only continue walking if it's a list page (has nested selections)
            if (!selectedItem || !isPage(selectedItem) || asPageItem(selectedItem).arrangeAlgorithm !== ArrangeAlgorithm.List) {
              break;
            }
            currentVeid = selectedVeid;
          }
        }

        // Switch to page with default focus (so arrange runs and creates VEs)
        switchToPage(store, targetVeid, true, false, false, focusPath);

        // After arrange, find the correct path from topTitledPages for the target focus
        if (targetFocusVeid) {
          const topPages = store.topTitledPages.get();

          // Find the path in topTitledPages that matches targetFocusVeid
          let targetPath: string | null = null;
          for (const pagePath of topPages) {
            const pageVeid = VeFns.veidFromPath(pagePath);
            if (pageVeid.itemId === targetFocusVeid.itemId) {
              targetPath = pagePath;
              break;
            }
          }

          if (targetPath) {
            store.history.setFocus(targetPath);
            fullArrange(store);
            store.touchToolbar();
          }
        }
      } else {
        switchToPage(store, targetVeid, true, false, false, focusPath);
      }
    } else if (isPage(targetVe.displayItem) && isPage(visualElement.displayItem) &&
      !(visualElement.flags & VisualElementFlags.ListPageRoot)) {
      // The outermost list page is already the current page, but we clicked on a nested page
      // (e.g., a page inside a spatial page displayed in the selectedVes area of the list).
      // In this case, switch to the clicked page directly.
      // But don't switch if we clicked on the selectedVes page itself (ListPageRoot) - that
      // should just receive focus, not become the new root.
      const clickedVeid = VeFns.actualVeidFromVe(visualElement);
      if (clickedVeid.itemId !== currentVeid?.itemId || clickedVeid.linkIdMaybe !== currentVeid?.linkIdMaybe) {
        switchToPage(store, clickedVeid, true, false, false);
      }
    }
  },



  /**
   * The absolute top level page.
   */
  umbrellaPage: () => umbrellaPage(),

  /**
   * A page to hold an item when the user navigates to the URL of a non-page item.
   */
  soloItemHolderPage: () => soloItemHolderPage(),

  /**
   * Create a page item.
   */
  create: (ownerId: Uid, parentId: Uid, relationshipToParent: string, title: string, ordering: Uint8Array): PageItem => {
    let id = newUid();
    markChildrenLoadAsInitiatedOrComplete(id);
    return ({
      origin: null,
      itemType: ItemType.Page,
      ownerId,
      id,
      parentId,
      relationshipToParent,
      creationDate: currentUnixTimeSeconds(),
      lastModifiedDate: currentUnixTimeSeconds(),
      dateTime: currentUnixTimeSeconds(),
      ordering,
      title,
      spatialPositionGr: { x: 0.0, y: 0.0 },


      spatialWidthGr: 4.0 * GRID_SIZE,

      naturalAspect: 2.0,
      backgroundColorIndex: 0,

      innerSpatialWidthGr: 60.0 * GRID_SIZE,
      arrangeAlgorithm: ArrangeAlgorithm.SpatialStretch,
      defaultPopupPositionGr: { x: 30.0 * GRID_SIZE, y: 15.0 * GRID_SIZE },
      defaultPopupWidthGr: 10.0 * GRID_SIZE,
      popupPositionGr: null,
      popupWidthGr: null,
      gridNumberOfColumns: 6,
      gridCellAspect: 1.5,
      docWidthBl: 36,
      justifiedRowAspect: 7.0,
      calendarDayRowHeightBl: 1.0,

      orderChildrenBy: "title[ASC]",

      flags: PageFlags.None,
      permissionFlags: PermissionFlags.None,

      tableColumns: [{
        name: "Title",
        widthGr: 8 * GRID_SIZE,
      }],

      numberOfVisibleColumns: 1,
      computed_children: [],
      computed_attachments: [],
      childrenLoaded: false,

      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,

      defaultCellPopupPositionNorm: { x: 0.5, y: 0.5 },
      defaultCellPopupWidthNorm: 0.6,
      cellPopupPositionNorm: null,
      cellPopupWidthNorm: null,
      pendingCellPopupPositionNorm: null,
      pendingCellPopupWidthNorm: null,
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
      dateTime: o.dateTime,
      ordering: new Uint8Array(o.ordering),
      title: o.title,
      spatialPositionGr: o.spatialPositionGr,


      spatialWidthGr: o.spatialWidthGr,

      naturalAspect: o.naturalAspect,
      backgroundColorIndex: o.backgroundColorIndex,

      innerSpatialWidthGr: o.innerSpatialWidthGr,
      arrangeAlgorithm: o.arrangeAlgorithm,
      defaultPopupPositionGr: o.defaultPopupPositionGr,
      defaultPopupWidthGr: o.defaultPopupWidthGr,
      popupPositionGr: o.popupPositionGr ?? null,
      popupWidthGr: o.popupWidthGr ?? null,
      gridNumberOfColumns: o.gridNumberOfColumns,
      gridCellAspect: o.gridCellAspect,
      docWidthBl: o.docWidthBl,
      justifiedRowAspect: o.justifiedRowAspect,
      calendarDayRowHeightBl: o.calendarDayRowHeightBl,

      orderChildrenBy: o.orderChildrenBy,

      flags: o.flags,
      permissionFlags: o.permissionFlags,

      tableColumns: o.tableColumns,
      numberOfVisibleColumns: o.numberOfVisibleColumns,

      computed_children: [],
      computed_attachments: [],

      childrenLoaded: false,

      pendingPopupPositionGr: null,
      pendingPopupWidthGr: null,

      defaultCellPopupPositionNorm: o.defaultCellPopupPositionNorm ?? { x: 0.5, y: 0.5 },
      defaultCellPopupWidthNorm: o.defaultCellPopupWidthNorm ?? 0.6,
      cellPopupPositionNorm: o.cellPopupPositionNorm ?? null,
      cellPopupWidthNorm: o.cellPopupWidthNorm ?? null,
      pendingCellPopupPositionNorm: null,
      pendingCellPopupWidthNorm: null,
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
      dateTime: p.dateTime,
      ordering: Array.from(p.ordering),
      title: p.title,
      spatialPositionGr: p.spatialPositionGr,


      spatialWidthGr: p.spatialWidthGr,

      naturalAspect: p.naturalAspect,
      backgroundColorIndex: p.backgroundColorIndex,

      innerSpatialWidthGr: p.innerSpatialWidthGr,
      arrangeAlgorithm: p.arrangeAlgorithm,
      defaultPopupPositionGr: p.defaultPopupPositionGr,
      defaultPopupWidthGr: p.defaultPopupWidthGr,
      gridNumberOfColumns: p.gridNumberOfColumns,
      gridCellAspect: p.gridCellAspect,
      docWidthBl: p.docWidthBl,
      justifiedRowAspect: p.justifiedRowAspect,
      calendarDayRowHeightBl: p.calendarDayRowHeightBl,

      orderChildrenBy: p.orderChildrenBy,

      permissionFlags: p.permissionFlags,
      flags: p.flags,

      tableColumns: p.tableColumns,
      numberOfVisibleColumns: p.numberOfVisibleColumns,
      popupPositionGr: p.popupPositionGr ?? undefined,
      popupWidthGr: p.popupWidthGr ?? undefined,
      defaultCellPopupPositionNorm: p.defaultCellPopupPositionNorm,
      defaultCellPopupWidthNorm: p.defaultCellPopupWidthNorm,
      cellPopupPositionNorm: p.cellPopupPositionNorm ?? undefined,
      cellPopupWidthNorm: p.cellPopupWidthNorm ?? undefined,
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
    parentIsPopup: boolean, emitHitboxes: boolean, isPopup: boolean,
    hasChildChanges: boolean, hasDefaultChanges: boolean, smallScreenMode: boolean): ItemGeometry => {

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
        : {
          x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
          w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0
        };
      const result = ({
        boundsPx,
        blockSizePx,
        viewportBoundsPx: boundsPx,
        hitboxes: !emitHitboxes ? [] : [
          HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
          HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
          HitboxFns.create(HitboxFlags.ContentEditable, innerBoundsPx),
        ],
      });
      if (!smallScreenMode) {
        result.hitboxes.push(HitboxFns.create(HitboxFlags.ShowPointer, popupClickBoundsPx));
        result.hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, popupClickBoundsPx));
      }
      result.hitboxes.push(HitboxFns.create(HitboxFlags.Attach, { x: innerBoundsPx.w - ATTACH_AREA_SIZE_PX + 2, y: 0.0, w: ATTACH_AREA_SIZE_PX, h: ATTACH_AREA_SIZE_PX }));
      result.hitboxes.push(HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }));
      return result;
    }

    let headerHeightBl = isPopup ? PAGE_POPUP_TITLE_HEIGHT_BL : PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL;
    let viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h = boundsPx.h + headerHeightBl * blockSizePx.h;
    viewportBoundsPx.y = viewportBoundsPx.y + headerHeightBl * blockSizePx.h;

    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    const hitboxes = [
      HitboxFns.create(HitboxFlags.Move | HitboxFlags.Click | HitboxFlags.ContentEditable, { x: 0, y: 0, h: blockSizePx.h * headerHeightBl, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: blockSizePx.h * headerHeightBl, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
      HitboxFns.create(HitboxFlags.Move, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
      HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX + 2, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX + 2, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }),
    ];
    // Don't add left side move hitbox for list pages - it interferes with list item interaction.
    if (page.arrangeAlgorithm != ArrangeAlgorithm.List) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }));
    }

    if (isPopup) {
      const scale = blockSizePx.h / LINE_HEIGHT_PX * PAGE_POPUP_TITLE_HEIGHT_BL;
      let rightOffset = ANCHOR_OFFSET_PX * scale;
      if (hasChildChanges) {
        const anchorChildBoundsPx = {
          x: 1 + innerBoundsPx.w - ANCHOR_BOX_SIZE_PX * scale - rightOffset,
          y: 1 + ANCHOR_OFFSET_PX * scale / 3 * 2,
          w: ANCHOR_BOX_SIZE_PX * scale,
          h: ANCHOR_BOX_SIZE_PX * scale
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorChild, anchorChildBoundsPx));
        rightOffset += ANCHOR_BOX_SIZE_PX * scale + ANCHOR_OFFSET_PX * scale;
      }
      if (hasDefaultChanges) {
        const anchorDefaultBoundsPx = {
          x: 1 + innerBoundsPx.w - ANCHOR_BOX_SIZE_PX * scale - rightOffset,
          y: 1 + ANCHOR_OFFSET_PX * scale / 3 * 2,
          w: ANCHOR_BOX_SIZE_PX * scale,
          h: ANCHOR_BOX_SIZE_PX * scale
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorDefault, anchorDefaultBoundsPx));
      }
    }

    const result = {
      boundsPx,
      viewportBoundsPx,
      blockSizePx,
      hitboxes: !emitHitboxes ? [] : hitboxes,
    };

    return result;
  },

  calcGeometry_InCell: (
    page: PageMeasurable, cellBoundsPx: BoundingBox,
    expandable: boolean, parentIsPopup: boolean,
    parentIsDock: boolean, isPopup: boolean,
    hasChildChanges: boolean, hasDefaultChanges: boolean,
    ignoreCellHeight: boolean, smallScreenMode: boolean): ItemGeometry => {

    if (!isPopup && !(page.flags & PageFlags.EmbeddedInteractive)) {
      const sizeBl = PageFns.calcSpatialDimensionsBl(page);
      let boundsPx;
      if (ignoreCellHeight) {
        const aspect = sizeBl.w / sizeBl.h;
        boundsPx = {
          x: cellBoundsPx.x,
          w: cellBoundsPx.w,
          h: Math.round(cellBoundsPx.w / aspect),
          y: Math.round(cellBoundsPx.y + (cellBoundsPx.h - (cellBoundsPx.w / aspect)) / 2.0)
        };
      } else {
        boundsPx = calcBoundsInCell(sizeBl, cellBoundsPx);
      }
      const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

      if (expandable) {
        const hitboxes = [
          HitboxFns.create(HitboxFlags.ShiftLeft, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
          HitboxFns.create(HitboxFlags.ShiftLeft, { x: 0, y: 0, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
          HitboxFns.create(HitboxFlags.ShiftLeft, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
          HitboxFns.create(HitboxFlags.ShiftLeft, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
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
        : {
          x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
          w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0
        };

      const hitboxes = [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, innerBoundsPx),
      ];

      if (!smallScreenMode) {
        hitboxes.push(HitboxFns.create(HitboxFlags.ShowPointer, popupClickBoundsPx));
        hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, popupClickBoundsPx));
      }

      return ({
        boundsPx: cloneBoundingBox(boundsPx)!,
        viewportBoundsPx: cloneBoundingBox(boundsPx)!,
        blockSizePx: NATURAL_BLOCK_SIZE_PX,
        hitboxes,
      });
    }

    // page types with a header.

    const headerHeightBl = isPopup ? PAGE_POPUP_TITLE_HEIGHT_BL : PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL;
    const adjustedCellBoundsPx = cloneBoundingBox(cellBoundsPx)!;
    adjustedCellBoundsPx.h -= headerHeightBl * NATURAL_BLOCK_SIZE_PX.h;
    if (adjustedCellBoundsPx.h < 10) { adjustedCellBoundsPx.h = 10; } // TODO (LOW): better behavior for small sizing.

    const sizeBl = PageFns.calcSpatialDimensionsBl(page);

    let boundsPx;
    if (ignoreCellHeight) {
      const aspect = sizeBl.w / sizeBl.h;
      boundsPx = {
        x: adjustedCellBoundsPx.x,
        w: adjustedCellBoundsPx.w,
        h: Math.round(adjustedCellBoundsPx.w / aspect),
        y: Math.round(adjustedCellBoundsPx.y + (adjustedCellBoundsPx.h - (adjustedCellBoundsPx.w / aspect)) / 2.0)
      };
    } else {
      boundsPx = calcBoundsInCell(sizeBl, adjustedCellBoundsPx);
    }

    const viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h += headerHeightBl * NATURAL_BLOCK_SIZE_PX.h;
    viewportBoundsPx.y += headerHeightBl * NATURAL_BLOCK_SIZE_PX.h
    const innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    const blockSizePx = cloneDimensions(NATURAL_BLOCK_SIZE_PX)!;

    const hitboxes: Array<{ type: HitboxFlags, boundsPx: BoundingBox, meta: HitboxMeta | null }> = [];

    if (isPopup) {
      const scale = blockSizePx.h / LINE_HEIGHT_PX * headerHeightBl;
      let anchorRightOffset = ANCHOR_OFFSET_PX * scale;

      hitboxes.push(
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ContentEditable | HitboxFlags.Click, { x: 0, y: 0, h: NATURAL_BLOCK_SIZE_PX.h * headerHeightBl, w: innerBoundsPx.w })
      );
      hitboxes.push(
        HitboxFns.create(HitboxFlags.Move, { x: 0, y: NATURAL_BLOCK_SIZE_PX.h * headerHeightBl, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
        HitboxFns.create(HitboxFlags.Move, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX })
      );
      // Don't add left side move hitbox for list pages - it interferes with list item interaction.
      if (page.arrangeAlgorithm != ArrangeAlgorithm.List) {
        hitboxes.push(HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }));
      }

      if (!parentIsDock) {
        hitboxes.push(HitboxFns.create(HitboxFlags.Move, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }));
        hitboxes.push(HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }));
      }

      if (parentIsDock) {
        hitboxes.push(HitboxFns.create(HitboxFlags.VerticalResize, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }));
      }

      if (hasChildChanges) {
        const anchorChildBoundsPx = {
          x: 1 + innerBoundsPx.w - ANCHOR_BOX_SIZE_PX * scale - anchorRightOffset,
          y: 1 + ANCHOR_OFFSET_PX * scale / 3 * 2,
          w: ANCHOR_BOX_SIZE_PX * scale,
          h: ANCHOR_BOX_SIZE_PX * scale
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorChild, anchorChildBoundsPx));
        anchorRightOffset += ANCHOR_BOX_SIZE_PX * scale + ANCHOR_OFFSET_PX * scale;
      }
      if (hasDefaultChanges) {
        const anchorDefaultBoundsPx = {
          x: 1 + innerBoundsPx.w - ANCHOR_BOX_SIZE_PX * scale - anchorRightOffset,
          y: 1 + ANCHOR_OFFSET_PX * scale / 3 * 2,
          w: ANCHOR_BOX_SIZE_PX * scale,
          h: ANCHOR_BOX_SIZE_PX * scale
        };
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorDefault, anchorDefaultBoundsPx));
      }
    } else {
      hitboxes.push(
        HitboxFns.create(HitboxFlags.Move | HitboxFlags.ContentEditable | HitboxFlags.Click, { x: 0, y: 0, h: NATURAL_BLOCK_SIZE_PX.h * headerHeightBl, w: innerBoundsPx.w })
      );
      hitboxes.push(
        HitboxFns.create(HitboxFlags.Move, { x: 0, y: NATURAL_BLOCK_SIZE_PX.h * headerHeightBl, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }),
        HitboxFns.create(HitboxFlags.Move, { x: 0, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX }),
        HitboxFns.create(HitboxFlags.Move, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: 0, h: innerBoundsPx.h, w: RESIZE_BOX_SIZE_PX })
      );

      if (!parentIsDock) {
        hitboxes.push(HitboxFns.create(HitboxFlags.Move, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }));
        hitboxes.push(HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX }));
      }

      if (parentIsDock) {
        hitboxes.push(HitboxFns.create(HitboxFlags.VerticalResize, { x: 0, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX, w: innerBoundsPx.w }));
      }
      let anchorRightOffset = RESIZE_BOX_SIZE_PX;
      if (hasChildChanges) {
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorChild, { x: innerBoundsPx.w - ANCHOR_BOX_SIZE_PX - anchorRightOffset, y: innerBoundsPx.h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, w: ANCHOR_BOX_SIZE_PX, h: ANCHOR_BOX_SIZE_PX }));
        anchorRightOffset += ANCHOR_BOX_SIZE_PX;
      }
      if (hasDefaultChanges) {
        hitboxes.push(HitboxFns.create(HitboxFlags.AnchorDefault, { x: innerBoundsPx.w - ANCHOR_BOX_SIZE_PX - anchorRightOffset, y: innerBoundsPx.h - ANCHOR_BOX_SIZE_PX - RESIZE_BOX_SIZE_PX, w: ANCHOR_BOX_SIZE_PX, h: ANCHOR_BOX_SIZE_PX }));
      }
    }

    const result = {
      boundsPx,
      blockSizePx,
      viewportBoundsPx,
      hitboxes,
    };

    return result;
  },

  calcGeometry_InComposite: (
    measurable: PageMeasurable, blockSizePx: Dimensions,
    compositeWidthBl: number, leftMarginBl: number,
    topPx: number, smallScreenMode: boolean): ItemGeometry => {

    let cloned = PageFns.asPageMeasurable(ItemFns.cloneMeasurableFields(measurable));
    if (cloned.spatialWidthGr > compositeWidthBl * GRID_SIZE) {
      cloned.spatialWidthGr = compositeWidthBl * GRID_SIZE;
    }
    const sizeBl = PageFns.calcSpatialDimensionsBl(cloned);
    const boundsPx = {
      x: leftMarginBl * blockSizePx.w + CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: topPx,
      w: (cloned.spatialWidthGr / GRID_SIZE) * blockSizePx.w - (CONTAINER_IN_COMPOSITE_PADDING_PX * 2) - 2,
      h: sizeBl.h * blockSizePx.h
    };
    let innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);
    const popupClickBoundsPx =
    {
      x: innerBoundsPx.w / 3.0, y: innerBoundsPx.h / 3.0,
      w: innerBoundsPx.w / 3.0, h: innerBoundsPx.h / 3.0
    };
    const moveBoundsPx = {
      x: innerBoundsPx.w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      y: innerBoundsPx.y + COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: innerBoundsPx.h - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
    };
    if (!(measurable.flags & PageFlags.EmbeddedInteractive)) {
      const result = ({
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
          HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
        ]
      });

      if (!smallScreenMode) {
        result.hitboxes.push(HitboxFns.create(HitboxFlags.ShowPointer, popupClickBoundsPx));
        result.hitboxes.push(HitboxFns.create(HitboxFlags.OpenPopup, popupClickBoundsPx));
      }

      return result;
    }

    let headerHeightBl = PAGE_EMBEDDED_INTERACTIVE_TITLE_HEIGHT_BL;
    let viewportBoundsPx = cloneBoundingBox(boundsPx)!;
    boundsPx.h = boundsPx.h + headerHeightBl * blockSizePx.h;
    viewportBoundsPx.y = viewportBoundsPx.y + headerHeightBl * blockSizePx.h;
    innerBoundsPx = zeroBoundingBoxTopLeft(boundsPx);

    return {
      boundsPx,
      blockSizePx,
      viewportBoundsPx,
      hitboxes: [
        HitboxFns.create(HitboxFlags.Click, innerBoundsPx),
        HitboxFns.create(HitboxFlags.Move, moveBoundsPx),
        HitboxFns.create(HitboxFlags.AttachComposite, {
          x: innerBoundsPx.w / 4,
          y: innerBoundsPx.h - ATTACH_AREA_SIZE_PX,
          w: innerBoundsPx.w / 2,
          h: ATTACH_AREA_SIZE_PX,
        }),
        HitboxFns.create(HitboxFlags.Resize, { x: innerBoundsPx.w - RESIZE_BOX_SIZE_PX, y: innerBoundsPx.h - RESIZE_BOX_SIZE_PX, w: RESIZE_BOX_SIZE_PX, h: RESIZE_BOX_SIZE_PX })
      ]
    };
  },

  calcGeometry_Attachment: (page: PageMeasurable, parentBoundsPx: BoundingBox, parentInnerSizeBl: Dimensions, index: number, isSelected: boolean): ItemGeometry => {
    return calcGeometryOfAttachmentItemImpl(page, parentBoundsPx, parentInnerSizeBl, index, isSelected, true);
  },

  calcGeometry_ListItem: (_page: PageMeasurable, blockSizePx: Dimensions, row: number, col: number, widthBl: number, parentIsPopup: boolean, padTop: boolean, expandable: boolean): ItemGeometry => {
    const scale = blockSizePx.h / LINE_HEIGHT_PX;
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
      x: blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w * (widthBl - 1),
      h: blockSizePx.h
    };
    const popupClickAreaBoundsPx = { x: 0.0, y: 0.0, w: blockSizePx.w, h: blockSizePx.h };
    const expandAreaBoundsPx = {
      x: boundsPx.w - blockSizePx.w,
      y: 0.0,
      w: blockSizePx.w,
      h: blockSizePx.h
    };
    const hitboxes = [
      HitboxFns.create(HitboxFlags.Click, clickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.ShowPointer, clickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.OpenPopup, popupClickAreaBoundsPx),
      HitboxFns.create(HitboxFlags.Move, innerBoundsPx)
    ];
    if (expandable) {
      hitboxes.push(HitboxFns.create(HitboxFlags.Expand, expandAreaBoundsPx));
    }
    return ({
      boundsPx,
      blockSizePx,
      viewportBoundsPx: null,
      hitboxes
    });
  },

  asPageMeasurable: (item: ItemTypeMixin): PageMeasurable => {
    if (item.itemType == ItemType.Page) { return item as PageMeasurable; }
    panic("not page measurable.");
  },

  handleClick: (visualElement: VisualElement, hitboxFlags: HitboxFlags, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    if ((asPageItem(visualElement.displayItem).flags & PageFlags.EmbeddedInteractive) && (hitboxFlags & HitboxFlags.ContentEditable)) {
      PageFns.handleEditTitleClick(visualElement, store);
    } else {
      const focusPath = VeFns.veToPath(visualElement);
      store.history.setFocus(focusPath);

      // Find the outermost list page in the current hierarchy (e.g. if in a popup).
      // If it's different from the current page, switch to it.
      PageFns.switchToOutermostListPageMaybe(visualElement, store);
    }
  },

  handleLinkClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    if (handleListPageLineItemClickMaybe(visualElement, store)) { return; }
    const focusPath = VeFns.veToPath(visualElement);
    store.history.setFocus(focusPath);
    PageFns.switchToOutermostListPageMaybe(visualElement, store);
  },

  handleEditTitleClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    let itemPath = VeFns.veToPath(visualElement);
    handleListPageLineItemClickMaybe(visualElement, store);
    store.overlay.setTextEditInfo(store.history, { itemPath, itemType: ItemType.Page });
    const editingPath = itemPath + ":title";
    const el = document.getElementById(editingPath)!;
    el.focus();
    const closestIdx = closestCaretPositionToClientPx(el, CursorEventState.getLatestClientPx());
    fullArrange(store);
    const freshEl = document.getElementById(editingPath)!;
    if (freshEl) {
      freshEl.focus();
      setCaretPosition(freshEl, closestIdx);
    }
  },

  handleOpenPopupClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const parentVe = VesCache.get(visualElement.parentPath!)!.get();

    // line item in list page.
    const parentItem = parentVe.displayItem;
    if ((visualElement.flags & VisualElementFlags.LineItem) &&
      !(parentVe.flags & VisualElementFlags.DockItem) &&
      isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
      // If Click hitbox was also hit (click on title area), select the item instead of popping up
      const hitboxType = MouseActionState.get()?.hitboxTypeOnMouseDown ?? 0;
      if (hitboxType & HitboxFlags.Click) {
        handleListPageLineItemClickMaybe(visualElement, store);
        return;
      }
      if (parentVe.flags & VisualElementFlags.Popup) {
        store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      } else {
        store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      }
      fullArrange(store);
      return;
    }

    // inside a popup.
    let insidePopup = parentVe.flags & VisualElementFlags.Popup ? true : false;
    if (isTable(parentVe.displayItem)) {
      const parentParentVe = VesCache.get(parentVe.parentPath!)!.get();
      if (parentParentVe.flags & VisualElementFlags.Popup) { insidePopup = true; }
    }
    if (insidePopup) {
      store.history.pushPopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
      return;
    }

    // not inside popup.
    store.history.replacePopup({ actualVeid: VeFns.actualVeidFromVe(visualElement), vePath: VeFns.veToPath(visualElement) });
    fullArrange(store);
  },

  handleAnchorChildClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const popupPage = asPageItem(visualElement.displayItem);
    const parentId = popupPage.parentId;
    const parentPage = itemState.get(parentId);
    const isCellPopup = parentPage && isPage(parentPage) && asPageItem(parentPage).arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch;

    if (isCellPopup) {
      if (popupPage.pendingCellPopupPositionNorm != null) {
        popupPage.cellPopupPositionNorm = popupPage.pendingCellPopupPositionNorm!;
        popupPage.pendingCellPopupPositionNorm = null;
      }
      if (popupPage.pendingCellPopupWidthNorm != null) {
        popupPage.cellPopupWidthNorm = popupPage.pendingCellPopupWidthNorm;
        popupPage.pendingCellPopupWidthNorm = null;
      }
    } else {
      if (popupPage.pendingPopupPositionGr != null) {
        popupPage.popupPositionGr = popupPage.pendingPopupPositionGr!;
        popupPage.pendingPopupPositionGr = null;
      }
      if (popupPage.pendingPopupWidthGr != null) {
        popupPage.popupWidthGr = popupPage.pendingPopupWidthGr;
        popupPage.pendingPopupWidthGr = null;
      }
    }
    serverOrRemote.updateItem(popupPage, store.general.networkStatus);
    fullArrange(store);
  },

  handleAnchorDefaultClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const popupPage = asPageItem(visualElement.displayItem);
    const parentId = visualElement.parentPath ? VeFns.itemIdFromPath(visualElement.parentPath) : popupPage.parentId;
    const parentPage = itemState.get(parentId);
    if (!parentPage || !isPage(parentPage)) { return; }
    const parentPageItem = asPageItem(parentPage);

    const isCellPopup = parentPageItem.arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch;

    if (isCellPopup) {
      const currentPos = popupPage.pendingCellPopupPositionNorm ?? popupPage.cellPopupPositionNorm ?? parentPageItem.defaultCellPopupPositionNorm;
      const currentWidth = popupPage.pendingCellPopupWidthNorm ?? popupPage.cellPopupWidthNorm ?? parentPageItem.defaultCellPopupWidthNorm;

      parentPageItem.defaultCellPopupPositionNorm = { x: currentPos.x, y: currentPos.y };
      parentPageItem.defaultCellPopupWidthNorm = currentWidth;

      popupPage.pendingCellPopupPositionNorm = null;
      popupPage.pendingCellPopupWidthNorm = null;

      if (popupPage.cellPopupPositionNorm != null || popupPage.cellPopupWidthNorm != null) {
        popupPage.cellPopupPositionNorm = null;
        popupPage.cellPopupWidthNorm = null;
        serverOrRemote.updateItem(popupPage, store.general.networkStatus);
      }

      for (const childId of parentPageItem.computed_children) {
        const child = itemState.get(childId);
        if (child && isPage(child)) {
          const childPage = asPageItem(child);
          if (childPage.cellPopupPositionNorm != null || childPage.cellPopupWidthNorm != null) {
            childPage.cellPopupPositionNorm = null;
            childPage.cellPopupWidthNorm = null;
            childPage.pendingCellPopupPositionNorm = null;
            childPage.pendingCellPopupWidthNorm = null;
            serverOrRemote.updateItem(childPage, store.general.networkStatus);
          }
        }
      }
    } else {
      const currentPos = popupPage.pendingPopupPositionGr ?? popupPage.popupPositionGr ?? parentPageItem.defaultPopupPositionGr;
      const currentWidth = popupPage.pendingPopupWidthGr ?? popupPage.popupWidthGr ?? parentPageItem.defaultPopupWidthGr;

      parentPageItem.defaultPopupPositionGr = { x: currentPos.x, y: currentPos.y };
      parentPageItem.defaultPopupWidthGr = currentWidth;

      popupPage.pendingPopupPositionGr = null;
      popupPage.pendingPopupWidthGr = null;

      for (const childId of parentPageItem.computed_children) {
        const child = itemState.get(childId);
        if (child && isPage(child)) {
          const childPage = asPageItem(child);
          if (childPage.popupPositionGr != null || childPage.popupWidthGr != null) {
            childPage.popupPositionGr = null;
            childPage.popupWidthGr = null;
            childPage.pendingPopupPositionGr = null;
            childPage.pendingPopupWidthGr = null;
            serverOrRemote.updateItem(childPage, store.general.networkStatus);
          }
        }
      }
    }

    serverOrRemote.updateItem(parentPageItem, store.general.networkStatus);
    fullArrange(store);
  },

  handleShiftLeftClick: (visualElement: VisualElement, store: StoreContextModel): void => {
    const parentVeid = VeFns.actualVeidFromPath(visualElement.parentPath!);
    const selectedVeid = store.perItem.getSelectedListPageItem(parentVeid);

    // Check if we're in a popup context by traversing up the parent chain
    let currentPath = visualElement.parentPath;
    let isInPopup = false;
    while (currentPath) {
      const parentVes = VesCache.get(currentPath);
      if (parentVes) {
        const parentVe = parentVes.get();
        if (parentVe.flags & VisualElementFlags.Popup) {
          isInPopup = true;
          break;
        }
      }
      currentPath = VeFns.parentPath(currentPath);
    }

    if (isInPopup) {
      // Push to history so user can go back to current popup state
      store.history.pushPopup({ actualVeid: selectedVeid, vePath: VeFns.veToPath(visualElement) });
      fullArrange(store);
    } else {
      // Switch to the page as the main application page
      switchToPage(store, selectedVeid, true, false, false);
    }
  },

  handleCalendarOverflowClick: (visualElement: VisualElement, store: StoreContextModel, meta: HitboxMeta | null): void => {
    if (!meta || !meta.calendarYear || !meta.calendarMonth || !meta.calendarDay) { return; }

    const pageItem = asPageItem(visualElement.displayItem);
    const targetYear = meta.calendarYear;
    const targetMonth = meta.calendarMonth;
    const targetDay = meta.calendarDay;

    const itemsForDate: Array<Item> = [];
    for (const childId of pageItem.computed_children) {
      const item = itemState.get(childId);
      if (!item) continue;
      const d = new Date(item.dateTime * 1000);
      if (d.getFullYear() === targetYear &&
        d.getMonth() + 1 === targetMonth &&
        d.getDate() === targetDay) {
        itemsForDate.push(item);
      }
    }

    if (itemsForDate.length <= 1) { return; }

    itemsForDate.sort((a, b) => {
      const cmp = compareOrderings(a.ordering, b.ordering);
      if (cmp !== 0) return cmp;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    const firstItem = itemsForDate[0];
    const lastItem = itemsForDate[itemsForDate.length - 1];
    firstItem.ordering = newOrderingAfter(lastItem.ordering);

    itemState.sortChildren(pageItem.id);
    serverOrRemote.updateItem(firstItem, store.general.networkStatus);
    fullArrange(store);
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
      calendarDayRowHeightBl: page.calendarDayRowHeightBl,
      childrenLoaded: page.childrenLoaded,
      computed_children: page.computed_children,
      flags: page.flags,
      tableColumns: page.tableColumns,
      numberOfVisibleColumns: page.numberOfVisibleColumns,
    });
  },

  debugSummary: (pageItem: PageItem) => {
    return "[page] " + pageItem.title;
  },

  getPopupPositionGr: (pageItem: PageItem): Vector => {
    if (pageItem.pendingPopupPositionGr != null) {
      return pageItem.pendingPopupPositionGr;
    }
    if (pageItem.popupPositionGr != null) {
      return pageItem.popupPositionGr;
    }
    return pageItem.defaultPopupPositionGr;
  },

  getPopupWidthGr: (pageItem: PageItem): number => {
    if (pageItem.pendingPopupWidthGr != null) {
      return pageItem.pendingPopupWidthGr;
    }
    if (pageItem.popupWidthGr != null) {
      return pageItem.popupWidthGr;
    }
    return pageItem.defaultPopupWidthGr;
  },

  getPopupPositionGrForParent: (parentPage: PageItem, childPage: PageItem): Vector => {
    if (childPage.pendingPopupPositionGr != null) {
      return childPage.pendingPopupPositionGr;
    }
    if (childPage.popupPositionGr != null) {
      return childPage.popupPositionGr;
    }
    return parentPage.defaultPopupPositionGr;
  },

  getPopupWidthGrForParent: (parentPage: PageItem, childPage: PageItem): number => {
    if (childPage.pendingPopupWidthGr != null) {
      return childPage.pendingPopupWidthGr;
    }
    if (childPage.popupWidthGr != null) {
      return childPage.popupWidthGr;
    }
    return parentPage.defaultPopupWidthGr;
  },

  childPopupPositioningHasChanged: (parentPage: PageItem | null, childPage?: PageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (childPage == null) { return false; }
    if (childPage.pendingPopupPositionGr != null) {
      const anchorPos = childPage.popupPositionGr ?? parentPage.defaultPopupPositionGr;
      if (childPage.pendingPopupPositionGr!.x != anchorPos.x ||
        childPage.pendingPopupPositionGr!.y != anchorPos.y) {
        return true;
      }
    }
    if (childPage.pendingPopupWidthGr != null) {
      const anchorWidth = childPage.popupWidthGr ?? parentPage.defaultPopupWidthGr;
      if (childPage.pendingPopupWidthGr != anchorWidth) {
        return true;
      }
    }
    return false;
  },

  defaultPopupPositioningHasChanged: (parentPage: PageItem | null, childPage?: PageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (childPage == null) { return false; }
    const currentPos = childPage.pendingPopupPositionGr ?? childPage.popupPositionGr ?? parentPage.defaultPopupPositionGr;
    const currentWidth = childPage.pendingPopupWidthGr ?? childPage.popupWidthGr ?? parentPage.defaultPopupWidthGr;
    if (currentPos.x != parentPage.defaultPopupPositionGr.x ||
      currentPos.y != parentPage.defaultPopupPositionGr.y) {
      return true;
    }
    if (currentWidth != parentPage.defaultPopupWidthGr) {
      return true;
    }
    return false;
  },

  getCellPopupPositionNormForParent: (parentPage: PageItem, childPage: PageItem): Vector => {
    if (childPage.pendingCellPopupPositionNorm != null) {
      return childPage.pendingCellPopupPositionNorm;
    }
    if (childPage.cellPopupPositionNorm != null) {
      return childPage.cellPopupPositionNorm;
    }
    return parentPage.defaultCellPopupPositionNorm;
  },

  getCellPopupWidthNormForParent: (parentPage: PageItem, childPage: PageItem): number => {
    if (childPage.pendingCellPopupWidthNorm != null) {
      return childPage.pendingCellPopupWidthNorm;
    }
    if (childPage.cellPopupWidthNorm != null) {
      return childPage.cellPopupWidthNorm;
    }
    return parentPage.defaultCellPopupWidthNorm;
  },

  childCellPopupPositioningHasChanged: (parentPage: PageItem | null, childPage?: PageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (childPage == null) { return false; }
    if (childPage.pendingCellPopupPositionNorm != null) {
      const anchorPos = childPage.cellPopupPositionNorm ?? parentPage.defaultCellPopupPositionNorm;
      if (childPage.pendingCellPopupPositionNorm!.x != anchorPos.x ||
        childPage.pendingCellPopupPositionNorm!.y != anchorPos.y) {
        return true;
      }
    }
    if (childPage.pendingCellPopupWidthNorm != null) {
      const anchorWidth = childPage.cellPopupWidthNorm ?? parentPage.defaultCellPopupWidthNorm;
      if (childPage.pendingCellPopupWidthNorm != anchorWidth) {
        return true;
      }
    }
    return false;
  },

  defaultCellPopupPositioningHasChanged: (parentPage: PageItem | null, childPage?: PageItem | null): boolean => {
    if (parentPage == null) { return false; }
    if (childPage == null) { return false; }
    const currentPos = childPage.pendingCellPopupPositionNorm ?? childPage.cellPopupPositionNorm ?? parentPage.defaultCellPopupPositionNorm;
    const currentWidth = childPage.pendingCellPopupWidthNorm ?? childPage.cellPopupWidthNorm ?? parentPage.defaultCellPopupWidthNorm;
    if (currentPos.x != parentPage.defaultCellPopupPositionNorm.x ||
      currentPos.y != parentPage.defaultCellPopupPositionNorm.y) {
      return true;
    }
    if (currentWidth != parentPage.defaultCellPopupWidthNorm) {
      return true;
    }
    return false;
  },

  getFingerprint: (pageItem: PageItem): string => {
    return pageItem.backgroundColorIndex + "~~~!@#~~~" + pageItem.title + "~~!@#~~~" + pageItem.arrangeAlgorithm + "~~!@#~~~" + pageItem.flags + "~~!@#~~~" + pageItem.permissionFlags;
  },

  setDefaultListPageSelectedItemMaybe: (store: StoreContextModel, itemVeid: Veid): void => {
    if (store.perItem.getSelectedListPageItem(itemVeid) != EMPTY_VEID) { return; }
    const item = itemState.get(itemVeid.itemId)!;
    if (isPage(item)) {
      const page = asPageItem(item);
      if (page.arrangeAlgorithm == ArrangeAlgorithm.List) {
        if (page.computed_children.length > 0) {
          const firstItemId = page.computed_children[0];
          const veid = VeFns.veidFromId(firstItemId);
          store.perItem.setSelectedListPageItem(itemVeid, veid);
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

const umbrellaPage = () => {
  const result = PageFns.create(EMPTY_UID, EMPTY_UID, RelationshipToParent.NoParent, "", newOrdering());
  result.id = UMBRELLA_PAGE_UID;
  return result;
}

const soloItemHolderPage = () => {
  const result = PageFns.create(EMPTY_UID, EMPTY_UID, RelationshipToParent.NoParent, "", newOrdering());
  result.arrangeAlgorithm = ArrangeAlgorithm.SingleCell;
  result.gridNumberOfColumns = 1;
  result.id = SOLO_ITEM_HOLDER_PAGE_UID;

  result.computed_children = [];
  result.computed_attachments = [];
  result.childrenLoaded = true;
  result.pendingPopupPositionGr = null;
  result.pendingPopupWidthGr = null;
  result.pendingCellPopupPositionNorm = null;
  result.pendingCellPopupWidthNorm = null;

  return result;
}
