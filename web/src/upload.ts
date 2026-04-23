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

import { GRID_SIZE } from "./constants";
import { HitInfoFns } from "./input/hit";
import { clearMouseOverState } from "./input/mouse_move";
import { HitboxFlags } from "./layout/hitbox";
import { RelationshipToParent } from "./layout/relationship-to-parent";
import { stackedInsertionIndexFromChildAreaPx, stackedInsertionIndexFromDesktopPx } from "./layout/stacked-insertion";
import { VesCache } from "./layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "./layout/visual-element";
import { asAttachmentsItem, AttachmentsItem, calcSpatialAttachmentInsertIndex, isAttachmentsItem } from "./items/base/attachments-item";
import { ItemType } from "./items/base/item";
import { ItemFns } from "./items/base/item-polymorphism";
import { asLinkItem, isLink, LinkFns } from "./items/link-item";
import { ArrangeAlgorithm, PageItem, asPageItem, isPage } from "./items/page-item";
import { PlaceholderFns, isPlaceholder } from "./items/placeholder-item";
import { asTableItem, isTable, TableFns } from "./items/table-item";
import { requestArrange } from "./layout/arrange";
import { server } from "./server";
import { itemState } from "./store/ItemState";
import { StoreContextModel } from "./store/StoreProvider";
import { TransientMessageType } from "./store/StoreProvider_Overlay";
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { Vector } from "./util/geometry";
import { sanitizeOriginalCreationDate } from "./util/time";


const MAX_EXTERNAL_UPLOAD_FILES = 10;

type UploadTarget =
  | { kind: "page-background", parent: PageItem }
  | { kind: "page-ordered", parent: PageItem, insertIndex: number }
  | { kind: "page-child-container", parent: PageItem }
  | { kind: "table-row", tableId: string, insertRow: number }
  | { kind: "table-cell-attachment", parent: AttachmentsItem, insertPosition: number }
  | { kind: "attach-hitbox", parent: AttachmentsItem, insertPosition: number };

type UploadPlacement = {
  parentId: string,
  relationshipToParent: string,
  ordering?: Uint8Array,
  pageParentMaybe: PageItem | null,
  useDropPosition: boolean,
};

let externalUploadMoveOverContainerPath: VisualElementPath | null = null;
let externalUploadAttachHitboxPath: VisualElementPath | null = null;
let externalUploadDropTarget: UploadTarget | null = null;


function showTransientMessage(
  store: StoreContextModel,
  text: string,
  type: TransientMessageType = TransientMessageType.Error,
  durationMs: number = 3000,
): void {
  store.overlay.toolbarTransientMessage.set({ text, type });
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get()?.text == text) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, durationMs);
}

function dataTransferContainsFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

function isAttachmentTarget(target: UploadTarget): boolean {
  return target.kind == "table-cell-attachment" || target.kind == "attach-hitbox";
}

function clearTableUploadHoverState(store: StoreContextModel, tablePath: VisualElementPath): void {
  store.perVe.setMoveOverRowNumber(tablePath, -1);
  store.perVe.setMoveOverColAttachmentNumber(tablePath, -1);
  store.perVe.setMoveOverChildContainerPath(tablePath, null);
}

function clearExternalUploadContainerHoverState(store: StoreContextModel, containerPath: VisualElementPath): void {
  clearTableUploadHoverState(store, containerPath);
  store.perVe.setMoveOverIndex(containerPath, -1);
  store.perVe.setMoveOverIndexAndPosition(containerPath, { index: -1, position: -1 });
}

function syncExternalUploadMoveOverContainer(store: StoreContextModel, nextPath: VisualElementPath | null): void {
  if (externalUploadMoveOverContainerPath != null && externalUploadMoveOverContainerPath != nextPath) {
    store.perVe.setMovingItemIsOver(externalUploadMoveOverContainerPath, false);
    clearExternalUploadContainerHoverState(store, externalUploadMoveOverContainerPath);
  }

  if (nextPath != null) {
    store.perVe.setMovingItemIsOver(nextPath, true);
  }

  externalUploadMoveOverContainerPath = nextPath;
}

function syncExternalUploadAttachHover(store: StoreContextModel, nextPath: VisualElementPath | null, insertIndex: number): void {
  if (externalUploadAttachHitboxPath != null && externalUploadAttachHitboxPath != nextPath) {
    store.perVe.setMovingItemIsOverAttach(externalUploadAttachHitboxPath, false);
    store.perVe.setMoveOverAttachmentIndex(externalUploadAttachHitboxPath, -1);
  }

  if (nextPath != null) {
    store.perVe.setMovingItemIsOverAttach(nextPath, true);
    store.perVe.setMoveOverAttachmentIndex(nextPath, insertIndex);
  }

  externalUploadAttachHitboxPath = nextPath;
}

function attachmentInsertIndexFromDesktopPx(store: StoreContextModel, attachVe: VisualElement, desktopPx: Vector): number {
  const attachVePath = VeFns.veToPath(attachVe);
  const attachItem = asAttachmentsItem(attachVe.displayItem);
  const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, attachVe);
  const innerSizeBl = ItemFns.calcSpatialDimensionsBl(attachVe.displayItem);
  const clampedIndex = calcSpatialAttachmentInsertIndex(
    veBoundsPx,
    innerSizeBl.w,
    desktopPx.x,
    attachItem.computed_attachments.length,
  );
  store.perVe.setMoveOverAttachmentIndex(attachVePath, clampedIndex);
  return clampedIndex;
}

function getTableCellAttachmentTarget(tableVe: VisualElement, insertRow: number): AttachmentsItem | null {
  const tableItem = asTableItem(tableVe.displayItem);
  if (insertRow < 0 || insertRow >= tableItem.computed_children.length) {
    return null;
  }

  const childId = tableItem.computed_children[insertRow];
  const child = itemState.get(childId);
  if (child == null) {
    return null;
  }

  const targetItem = isLink(child)
    ? itemState.get(LinkFns.getLinkToId(asLinkItem(child)))
    : child;

  return isAttachmentsItem(targetItem) ? asAttachmentsItem(targetItem!) : null;
}

function supportsOrderedPageExternalUpload(page: PageItem): boolean {
  return page.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
    page.arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
    page.arrangeAlgorithm == ArrangeAlgorithm.List ||
    page.arrangeAlgorithm == ArrangeAlgorithm.Document ||
    (page.arrangeAlgorithm == ArrangeAlgorithm.Justified && page.orderChildrenBy != "");
}

function orderedPageInsertIndexFromDesktopPx(
  store: StoreContextModel,
  pageVe: VisualElement,
  desktopPx: Vector,
): number {
  const page = asPageItem(pageVe.displayItem);
  if (page.orderChildrenBy != "" && page.arrangeAlgorithm != ArrangeAlgorithm.Document) {
    return 0;
  }

  switch (page.arrangeAlgorithm) {
    case ArrangeAlgorithm.Grid: {
      if (!pageVe.viewportBoundsPx || !pageVe.childAreaBoundsPx || !pageVe.cellSizePx) {
        return page.computed_children.length;
      }

      const xAdj = (pageVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) ||
        (pageVe.flags & VisualElementFlags.Popup)
        ? store.getCurrentDockWidthPx()
        : 0.0;
      const xOffsetPx = desktopPx.x - (pageVe.viewportBoundsPx.x + xAdj);
      const yOffsetPx = desktopPx.y - pageVe.viewportBoundsPx.y;
      const veid = VeFns.veidFromVe(pageVe);
      const scrollYPx = store.perItem.getPageScrollYProp(veid)
        * (pageVe.childAreaBoundsPx.h - pageVe.viewportBoundsPx.h);
      const scrollXPx = store.perItem.getPageScrollXProp(veid)
        * (pageVe.childAreaBoundsPx.w - pageVe.viewportBoundsPx.w);
      const cellX = Math.floor((xOffsetPx + scrollXPx) / pageVe.cellSizePx.w);
      const cellY = Math.floor((yOffsetPx + scrollYPx) / pageVe.cellSizePx.h);
      const rawIndex = cellY * page.gridNumberOfColumns + cellX;
      return Math.max(0, Math.min(rawIndex, page.computed_children.length));
    }

    case ArrangeAlgorithm.List:
      if (!pageVe.viewportBoundsPx || !pageVe.childAreaBoundsPx) {
        return page.computed_children.length;
      }

      {
        const pagePath = VeFns.veToPath(pageVe);
        const childVes = VesCache.render.getLineChildren(pagePath)().map((childVe) => childVe.get());
        const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, pageVe);
        const scrollVeid = VeFns.actualVeidFromVe(pageVe);
        const scrollYPx = Math.max(
          0,
          (pageVe.listChildAreaBoundsPx?.h ?? pageVe.childAreaBoundsPx.h) -
          (pageVe.listViewportBoundsPx?.h ?? pageVe.viewportBoundsPx.h),
        ) * store.perItem.getPageScrollYProp(scrollVeid);
        const childAreaYPx = desktopPx.y - viewportBoundsPx.y + scrollYPx;
        return stackedInsertionIndexFromChildAreaPx(childVes, childAreaYPx);
      }

    case ArrangeAlgorithm.Catalog:
    case ArrangeAlgorithm.Document: {
      const pagePath = VeFns.veToPath(pageVe);
      const childVes = VesCache.render.getNonMovingChildren(pagePath)().map((childVe) => childVe.get());
      return stackedInsertionIndexFromDesktopPx(store, childVes, desktopPx);
    }

    case ArrangeAlgorithm.Justified:
      return 0;

    default:
      return page.computed_children.length;
  }
}

function resolveExternalUploadTarget(
  store: StoreContextModel,
  desktopPx: Vector,
  syncHoverState: boolean,
): UploadTarget | null {
  const hitInfo = HitInfoFns.hit(store, desktopPx, [], false);
  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  const rootPageVeMaybe = isPage(hitInfo.rootVes.get().displayItem) ? hitInfo.rootVes.get() : null;
  const orderedPageTargetVeMaybe =
    tableContainerVeMaybe == null &&
      rootPageVeMaybe != null &&
      supportsOrderedPageExternalUpload(asPageItem(rootPageVeMaybe.displayItem))
      ? rootPageVeMaybe
      : null;
  const nextMoveOverContainerPath = tableContainerVeMaybe != null ? VeFns.veToPath(tableContainerVeMaybe) : null;
  const normalizedTableMoveDesktopPx = tableContainerVeMaybe != null
    ? TableFns.normalizeMoveOverDesktopPx(store, tableContainerVeMaybe, desktopPx)
    : desktopPx;
  const isOverTableRootAttach =
    !!(hitInfo.hitboxType & HitboxFlags.Attach) &&
    hitInfo.overVes != null &&
    isTable(hitInfo.overVes.get().displayItem);
  const shouldTreatTableHeaderAsFirstRow =
    isOverTableRootAttach &&
    tableContainerVeMaybe != null &&
    normalizedTableMoveDesktopPx.y != desktopPx.y;
  const tableChildContainerDropTargetPath =
    tableContainerVeMaybe != null &&
      hitInfo.overVes != null &&
      !!(hitInfo.hitboxType & HitboxFlags.OpenPopup) &&
      !!(hitInfo.overVes.get().flags & VisualElementFlags.InsideTable) &&
      isPage(hitInfo.overVes.get().displayItem)
      ? VeFns.veToPath(hitInfo.overVes.get())
      : null;
  const orderedPageTargetPath = orderedPageTargetVeMaybe != null ? VeFns.veToPath(orderedPageTargetVeMaybe) : null;

  if (syncHoverState) {
    clearMouseOverState(store);
    store.mouseOverTableHeaderColumnNumber.set(null);
    syncExternalUploadMoveOverContainer(store, nextMoveOverContainerPath ?? orderedPageTargetPath);
  }

  if (tableContainerVeMaybe == null) {
    if (orderedPageTargetVeMaybe != null) {
      const insertIndex = orderedPageInsertIndexFromDesktopPx(store, orderedPageTargetVeMaybe, desktopPx);
      if (syncHoverState) {
        store.perVe.setMoveOverIndex(orderedPageTargetPath!, insertIndex);
        syncExternalUploadAttachHover(store, null, -1);
        store.externalFileDragActive.set(true);
      }

      return {
        kind: "page-ordered",
        parent: asPageItem(orderedPageTargetVeMaybe.displayItem),
        insertIndex,
      };
    }

    if (syncHoverState) {
      syncExternalUploadAttachHover(store, null, -1);
      store.externalFileDragActive.set(false);
    }

    const hitItem = HitInfoFns.getHitVe(hitInfo).displayItem;
    return hitInfo.hitboxType == HitboxFlags.None && isPage(hitItem)
      ? { kind: "page-background", parent: asPageItem(hitItem) }
      : null;
  }

  let nextAttachHitboxPath: VisualElementPath | null = null;
  let nextAttachInsertIndex = -1;
  let target: UploadTarget;
  const tablePath = VeFns.veToPath(tableContainerVeMaybe);

  if (isOverTableRootAttach && !shouldTreatTableHeaderAsFirstRow && hitInfo.overVes != null) {
    nextAttachHitboxPath = VeFns.veToPath(hitInfo.overVes.get());
    nextAttachInsertIndex = attachmentInsertIndexFromDesktopPx(store, hitInfo.overVes.get(), desktopPx);
    target = {
      kind: "attach-hitbox",
      parent: asAttachmentsItem(hitInfo.overVes.get().displayItem),
      insertPosition: nextAttachInsertIndex,
    };
    if (syncHoverState) {
      clearTableUploadHoverState(store, tablePath);
    }
  } else {
    const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, tableContainerVeMaybe, desktopPx);
    const tableCellAttachmentTarget = getTableCellAttachmentTarget(tableContainerVeMaybe, insertRow);
    if (syncHoverState) {
      store.perVe.setMoveOverRowNumber(tablePath, insertRow);
      store.perVe.setMoveOverChildContainerPath(tablePath, tableChildContainerDropTargetPath);
      store.perVe.setMoveOverColAttachmentNumber(tablePath, tableCellAttachmentTarget != null ? attachmentPos : -1);
    }

    if (tableChildContainerDropTargetPath != null && hitInfo.overVes != null && isPage(hitInfo.overVes.get().displayItem)) {
      target = {
        kind: "page-child-container",
        parent: asPageItem(hitInfo.overVes.get().displayItem),
      };
    } else if (tableCellAttachmentTarget != null && attachmentPos >= 0) {
      target = {
        kind: "table-cell-attachment",
        parent: tableCellAttachmentTarget,
        insertPosition: attachmentPos,
      };
    } else {
      target = {
        kind: "table-row",
        tableId: tableContainerVeMaybe.displayItem.id,
        insertRow,
      };
    }
  }

  if (syncHoverState) {
    syncExternalUploadAttachHover(store, nextAttachHitboxPath, nextAttachInsertIndex);
    store.externalFileDragActive.set(true);
  }

  return target;
}

function handleStringTypeDataMaybe(dataTransfer: DataTransfer, desktopPx: Vector): void {
  for (let item of dataTransfer.items) {
    if (item.kind != "string") {
      continue;
    }
    if (item.type == "text/html") {
      item.getAsString((txt) => {
        console.debug("TODO: upload clippings", txt, desktopPx);
      });
    }
  }
}

function waitForBrowserAfterDrop(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function uploadPositionForPage(
  store: StoreContextModel,
  desktopPx: Vector,
  parent: PageItem,
  useDropPosition: boolean,
): Vector {
  if (!useDropPosition || parent.arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch) {
    return { x: 0.0, y: 0.0 };
  }

  const hitInfo = HitInfoFns.hit(store, desktopPx, [], false);
  if (hitInfo.overPositionGr != null) {
    return hitInfo.overPositionGr;
  }

  const hitVe = HitInfoFns.getHitVe(hitInfo);
  const propX = (desktopPx.x - hitVe.boundsPx.x) / hitVe.boundsPx.w;
  const propY = (desktopPx.y - hitVe.boundsPx.y) / hitVe.boundsPx.h;
  return {
    x: Math.floor(parent.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
    y: Math.floor(parent.innerSpatialWidthGr / GRID_SIZE / parent.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
  };
}

function createAttachmentPlaceholder(parent: AttachmentsItem, store: StoreContextModel): void {
  const placeholderItem = PlaceholderFns.create(
    parent.ownerId,
    parent.id,
    RelationshipToParent.Attachment,
    itemState.newOrderingAtEndOfAttachments(parent.id),
  );
  itemState.add(placeholderItem);
  server.addItem(placeholderItem, null, store.general.networkStatus);
}

function prepareTableCellAttachmentOrdering(parent: AttachmentsItem, store: StoreContextModel, insertPosition: number): Uint8Array {
  const numPlaceholdersToCreate = insertPosition > parent.computed_attachments.length
    ? insertPosition - parent.computed_attachments.length
    : 0;
  for (let i = 0; i < numPlaceholdersToCreate; ++i) {
    createAttachmentPlaceholder(parent, store);
  }

  if (insertPosition < parent.computed_attachments.length) {
    const overAttachmentId = parent.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      const ordering = placeholderToReplaceMaybe.ordering;
      itemState.delete(placeholderToReplaceMaybe.id);
      server.deleteItem(placeholderToReplaceMaybe.id, store.general.networkStatus);
      return ordering;
    }
  }

  return itemState.newOrderingAtAttachmentsPosition(parent.id, insertPosition);
}

function prepareAttachHitboxOrdering(parent: AttachmentsItem, store: StoreContextModel, insertPosition: number): Uint8Array {
  if (insertPosition < 0 || insertPosition >= parent.computed_attachments.length) {
    if (insertPosition > 0 && insertPosition - 1 < parent.computed_attachments.length) {
      const prevAttachmentId = parent.computed_attachments[insertPosition - 1];
      const prevPlaceholderMaybe = itemState.get(prevAttachmentId)!;
      if (isPlaceholder(prevPlaceholderMaybe)) {
        const ordering = prevPlaceholderMaybe.ordering;
        itemState.delete(prevPlaceholderMaybe.id);
        server.deleteItem(prevPlaceholderMaybe.id, store.general.networkStatus);
        return ordering;
      }
    }
    return itemState.newOrderingAtAttachmentsPosition(parent.id, insertPosition >= 0 ? insertPosition : parent.computed_attachments.length);
  }

  const overAttachmentId = parent.computed_attachments[insertPosition];
  const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
  if (isPlaceholder(placeholderToReplaceMaybe)) {
    const ordering = placeholderToReplaceMaybe.ordering;
    itemState.delete(placeholderToReplaceMaybe.id);
    server.deleteItem(placeholderToReplaceMaybe.id, store.general.networkStatus);
    return ordering;
  }

  if (insertPosition > 0) {
    const prevAttachmentId = parent.computed_attachments[insertPosition - 1];
    const prevPlaceholderMaybe = itemState.get(prevAttachmentId)!;
    if (isPlaceholder(prevPlaceholderMaybe)) {
      const ordering = prevPlaceholderMaybe.ordering;
      itemState.delete(prevPlaceholderMaybe.id);
      server.deleteItem(prevPlaceholderMaybe.id, store.general.networkStatus);
      return ordering;
    }
  }

  return itemState.newOrderingAtAttachmentsPosition(parent.id, insertPosition);
}

function placementForUploadTarget(
  store: StoreContextModel,
  target: UploadTarget,
  fileIndex: number,
): UploadPlacement {
  switch (target.kind) {
    case "page-background":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Child,
        pageParentMaybe: target.parent,
        useDropPosition: true,
      };

    case "page-ordered":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Child,
        ordering: itemState.newOrderingAtChildrenPosition(target.parent.id, target.insertIndex + fileIndex, null),
        pageParentMaybe: null,
        useDropPosition: false,
      };

    case "page-child-container":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Child,
        pageParentMaybe: target.parent,
        useDropPosition: false,
      };

    case "table-row":
      return {
        parentId: target.tableId,
        relationshipToParent: RelationshipToParent.Child,
        ordering: itemState.newOrderingAtChildrenPosition(target.tableId, target.insertRow + fileIndex, null),
        pageParentMaybe: null,
        useDropPosition: false,
      };

    case "table-cell-attachment":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Attachment,
        ordering: prepareTableCellAttachmentOrdering(target.parent, store, target.insertPosition),
        pageParentMaybe: null,
        useDropPosition: false,
      };

    case "attach-hitbox":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Attachment,
        ordering: prepareAttachHitboxOrdering(target.parent, store, target.insertPosition),
        pageParentMaybe: null,
        useDropPosition: false,
      };
  }
}

function spatialWidthGrForUpload(
  parent: PageItem | null,
  useDropPosition: boolean,
  posPx: Vector,
  defaultWidthGr: number,
): number {
  if (parent == null || !useDropPosition || parent.arrangeAlgorithm != ArrangeAlgorithm.SpatialStretch) {
    return defaultWidthGr;
  }

  let maxWidthBl = Math.floor((parent.innerSpatialWidthGr - posPx.x - GRID_SIZE / 2.0) / GRID_SIZE);
  if (maxWidthBl < 2) {
    maxWidthBl = 2;
  }
  const maxWidthGr = maxWidthBl * GRID_SIZE;
  return Math.min(defaultWidthGr, maxWidthGr);
}

function makeUploadPartialObject(
  file: File,
  placement: UploadPlacement,
  posPx: Vector,
  spatialWidthGr: number,
  itemType: ItemType,
): object {
  return {
    itemType,
    parentId: placement.parentId,
    relationshipToParent: placement.relationshipToParent,
    ordering: placement.ordering != null ? Array.from(placement.ordering) : undefined,
    title: file.name,
    spatialPositionGr: posPx,
    spatialWidthGr,
    originalCreationDate: sanitizeOriginalCreationDate(Math.round(file.lastModified / 1000.0), `uploading ${itemType} ${file.name}`),
    fileSizeBytes: file.size,
  };
}

async function uploadFilesToTarget(
  store: StoreContextModel,
  files: ReadonlyArray<File>,
  desktopPx: Vector,
  target: UploadTarget,
): Promise<void> {
  if (files.length > 0) {
    store.overlay.uploadOverlayInfo.set({
      currentFile: 0,
      totalFiles: files.length,
      currentFileName: files[0].name,
    });
  }

  for (let i = 0; i < files.length; ++i) {
    const file = files[i];
    const placement = placementForUploadTarget(store, target, i);
    const posPx = placement.pageParentMaybe != null
      ? uploadPositionForPage(store, desktopPx, placement.pageParentMaybe, placement.useDropPosition)
      : { x: 0.0, y: 0.0 };

    store.overlay.uploadOverlayInfo.set({
      currentFile: i + 1,
      totalFiles: files.length,
      currentFileName: file.name,
    });

    const base64Data = base64ArrayBuffer(await file.arrayBuffer());
    const isImageUpload = file.type == "image/jpeg" || file.type == "image/png";
    const itemType = isImageUpload ? ItemType.Image : ItemType.File;
    const defaultWidthGr = isImageUpload ? 4.0 * GRID_SIZE : 8.0 * GRID_SIZE;
    const spatialWidthGr = spatialWidthGrForUpload(
      placement.pageParentMaybe,
      placement.useDropPosition,
      posPx,
      defaultWidthGr,
    );
    const partialObject = makeUploadPartialObject(file, placement, posPx, spatialWidthGr, itemType);

    try {
      const returnedItem = await server.addItemFromPartialObject(partialObject, base64Data, store.general.networkStatus);
      itemState.add(ItemFns.fromObject(returnedItem, null));
      requestArrange(store, isImageUpload ? "upload-image" : "upload-file");
    } catch (error) {
      console.warn(`Failed to add ${file.name}:`, error);
    }
  }

  setTimeout(() => {
    store.overlay.uploadOverlayInfo.set(null);
  }, 300);
}

export function clearExternalUploadHover(store: StoreContextModel): void {
  syncExternalUploadMoveOverContainer(store, null);
  syncExternalUploadAttachHover(store, null, -1);
  clearMouseOverState(store);
  store.mouseOverTableHeaderColumnNumber.set(null);
  store.externalFileDragActive.set(false);
  externalUploadDropTarget = null;
}

export function updateExternalUploadHover(
  store: StoreContextModel,
  dataTransfer: DataTransfer,
  desktopPx: Vector,
): void {
  if (!dataTransferContainsFiles(dataTransfer)) {
    clearExternalUploadHover(store);
    return;
  }

  externalUploadDropTarget = resolveExternalUploadTarget(store, desktopPx, true);
}

export async function handleExternalUploadDrop(
  store: StoreContextModel,
  dataTransfer: DataTransfer,
  desktopPx: Vector,
): Promise<void> {
  const files = Array.from(dataTransfer.files);
  const target = externalUploadDropTarget ?? resolveExternalUploadTarget(store, desktopPx, false);

  try {
    await waitForBrowserAfterDrop();

    const fileCount = files.length;
    if (fileCount > MAX_EXTERNAL_UPLOAD_FILES) {
      showTransientMessage(store, `Can only drop up to ${MAX_EXTERNAL_UPLOAD_FILES} files at once.`);
      return;
    }

    if (target == null) {
      const hitInfo = HitInfoFns.hit(store, desktopPx, [], false);
      if (hitInfo.hitboxType != HitboxFlags.None) {
        showTransientMessage(store, "Must upload on background");
      } else {
        showTransientMessage(store, "Must upload on page");
      }
      return;
    }

    if (isAttachmentTarget(target) && fileCount != 1) {
      showTransientMessage(store, "Attachment drops only support a single file.");
      return;
    }

    await uploadFilesToTarget(store, files, desktopPx, target);
  } finally {
    clearExternalUploadHover(store);
  }
}

export async function handleUpload(
  store: StoreContextModel,
  dataTransfer: DataTransfer,
  desktopPx: Vector,
  parent: PageItem) {

  handleStringTypeDataMaybe(dataTransfer, desktopPx);
  await waitForBrowserAfterDrop();
  await uploadFilesToTarget(store, Array.from(dataTransfer.files), desktopPx, { kind: "page-background", parent });
}
