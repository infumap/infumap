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
import { HitInfo, HitInfoFns } from "./input/hit";
import { clearMouseOverState } from "./input/mouse_move";
import { CursorEventState } from "./input/state";
import { HitboxFlags } from "./layout/hitbox";
import { RelationshipToParent } from "./layout/relationship-to-parent";
import { JustifiedInsertion, justifiedInsertionFromDesktopPx } from "./layout/justified-insertion";
import { stackedInsertionIndexFromDesktopPx } from "./layout/stacked-insertion";
import { catalogInsertionIndexFromDesktopPx } from "./layout/catalog-display";
import { VesCache } from "./layout/ves-cache";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "./layout/visual-element";
import { asAttachmentsItem, AttachmentsItem, attachmentAnchorRightPxForVe, attachmentBlockSizePxForVe, calcSpatialAttachmentInsertIndex, isAttachmentsItem } from "./items/base/attachments-item";
import { isComposite } from "./items/composite-item";
import { itemCanEdit } from "./items/base/capabilities-item";
import { itemCanAcceptManualChildren } from "./items/base/flags-item";
import { ItemType } from "./items/base/item";
import { ItemFns } from "./items/base/item-polymorphism";
import { parseSortOrder } from "./items/base/sort-order";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./items/page-item";
import { PlaceholderFns, isPlaceholder } from "./items/placeholder-item";
import { isTable, TableFns } from "./items/table-item";
import { requestArrange } from "./layout/arrange";
import { calcJustifiedPagePaddingPx } from "./layout/arrange/justified_metrics";
import { server } from "./server";
import { itemState } from "./store/ItemState";
import { StoreContextModel } from "./store/StoreProvider";
import { TransientMessageType } from "./store/StoreProvider_Overlay";
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { Vector } from "./util/geometry";
import { formatBytes } from "./util/item-metadata";
import { sanitizeOriginalCreationDate } from "./util/time";


const EXTERNAL_UPLOAD_CONFIRMATION_FILE_THRESHOLD = 10;
const EXTERNAL_UPLOAD_CONFIRMATION_FILE_BYTES = 10 * 1024 * 1024;
// Text files become text items, which are shown in full when opened. Pasted text is capped at this size
// (MAX_CLIPBOARD_TEXT_BYTES); a dropped file isn't, as it is stored unmodified, but larger ones need confirming.
const TEXT_UPLOAD_CONFIRMATION_FILE_BYTES = 1024 * 1024;
const MAX_EXTERNAL_UPLOAD_FILES = 100;
// Files are sent base64 encoded in a JSON command, which the server caps at 256 MiB (COMMAND_REQUEST_MAX_BYTES).
// Refusing larger files up front avoids reading and encoding them only to be rejected, and keeps the base64 string
// well below the browser's maximum string length, which would otherwise throw part way through a drop.
const MAX_EXTERNAL_UPLOAD_FILE_BYTES = 190 * 1024 * 1024;
const TEXT_UPLOAD_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const TEXT_UPLOAD_EXTENSIONS = new Set(["txt", "md", "markdown"]);
// HEIC and CR2 display requests use JPEG renditions on the server, including at full display size. Other formats must
// be browser-readable because their original bytes are served at full size.
const IMAGE_UPLOAD_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/heic", "image/heif",
  "image/x-canon-cr2", "image/svg+xml",
]);
// Browsers may leave the MIME type empty or use a generic type for these formats (including image/tiff for CR2).
const SERVER_DECODED_IMAGE_EXTENSIONS = new Set(["heic", "heif", "hif", "cr2", "svg"]);

function normalizedUploadMimeType(file: File): string {
  return file.type.trim().toLowerCase().split(";")[0];
}

function uploadExtension(file: File): string {
  const idx = file.name.lastIndexOf(".");
  return idx < 0 ? "" : file.name.substring(idx + 1).trim().toLowerCase();
}

function uploadItemTypeForFile(file: File): ItemType {
  const mimeType = normalizedUploadMimeType(file);
  if (IMAGE_UPLOAD_MIME_TYPES.has(mimeType) || SERVER_DECODED_IMAGE_EXTENSIONS.has(uploadExtension(file))) {
    return ItemType.Image;
  }
  if (TEXT_UPLOAD_MIME_TYPES.has(mimeType) || TEXT_UPLOAD_EXTENSIONS.has(uploadExtension(file))) {
    return ItemType.Text;
  }
  return ItemType.File;
}

type UploadTarget =
  // Appended to the page's children. posGr is where they go if the page is spatial: the drop position when the page
  // shows its contents there (the page itself, or a translucent child page), otherwise its top left.
  | { kind: "page-position", parent: PageItem, posGr: Vector }
  | { kind: "page-ordered", parent: PageItem, insertIndex: number }
  | { kind: "container-row", parentId: string, insertIndex: number }
  | { kind: "table-cell-attachment", parent: AttachmentsItem, insertPosition: number }
  | { kind: "attach-hitbox", parent: AttachmentsItem, insertPosition: number };

type UploadPlacement = {
  parentId: string,
  relationshipToParent: string,
  ordering?: Uint8Array,
  // Set if the parent is a spatial page.
  spatialPageParentMaybe: PageItem | null,
  posGr: Vector,
};

// Files dropped together on a spatial page are cascaded, a block apart, so none ends up hidden exactly under another.
// Each run of CASCADE_RUN_LENGTH starts a further CASCADE_RUN_OFFSET_BL to the right, keeping all positions distinct.
const CASCADE_RUN_LENGTH = 10;
const CASCADE_RUN_OFFSET_BL = 2;

let externalUploadMoveOverContainerPath: VisualElementPath | null = null;
let externalUploadAttachHitboxPath: VisualElementPath | null = null;
let externalUploadDropTarget: UploadTarget | null = null;
// The upload overlay is outside the desktop, so a drop on it still reaches the window drop listener. A second batch
// running alongside the first would share (and prematurely clear) the overlay, so drops are refused until it is done.
let externalUploadInProgress = false;

// Added to drags that start in this page, so they aren't taken for drags from another page.
const PAGE_DRAG_TYPE = "application/x-infumap-page-drag";
const DRAG_HINT_INTERVAL_MS = 3000;
// A file drag is refused for this long before saying why, so passing over a refusing spot on the way somewhere else
// doesn't flash a message.
const REFUSED_FILE_DRAG_HINT_DELAY_MS = 400;
let lastDragHint: { text: string, ms: number } | null = null;
// dragover fires every ~50ms while the pointer is over the page, so a longer gap means the drag left and came back.
const REFUSED_FILE_DRAG_GAP_MS = 250;
let refusedFileDragSince: { text: string, ms: number, lastMs: number } | null = null;


function showTransientMessage(
  store: StoreContextModel,
  text: string,
  type: TransientMessageType = TransientMessageType.Error,
  durationMs: number = 3000,
): void {
  const message = { text, type };
  store.overlay.toolbarTransientMessage.set(message);
  // By identity, so the timer of an earlier showing of the same text doesn't cut a later one short.
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, durationMs);
}

export function dataTransferContainsFiles(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  if (dataTransfer == null) {
    return false;
  }

  return Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some(item => item.kind == "file") ||
    dataTransfer.files.length > 0;
}

/** Called on dragstart, which fires only for drags that start in this page. */
export function markPageDrag(dataTransfer: DataTransfer | null): void {
  dataTransfer?.setData(PAGE_DRAG_TYPE, "");
}

/**
 * A drag of an image (or link) from another web page has its URL, not its data. The data can only be fetched from the
 * page if the image's server allows it (CORS), which few do. Fetching it on the server was tried, but bot protection
 * (e.g. Cloudflare) and hotlink checks made that unreliable, so these drags are refused, and this says how to copy and
 * paste the image instead, which does give the page its data (see pasteFilesMaybe).
 */
export function showWebPageDragMessageMaybe(store: StoreContextModel, dataTransfer: DataTransfer): void {
  const types = Array.from(dataTransfer.types);
  if (!types.includes("text/uri-list") || types.includes(PAGE_DRAG_TYPE) || dataTransferContainsFiles(dataTransfer)) {
    return;
  }
  showDragHintMaybe(store, "Can't drop from web pages. To add an image, right-click it, choose Copy image, and paste here");
}

/**
 * Says why a drag is refused: a refused drag gets no drop event, so this is the only chance. Called on every dragover,
 * so it is shown again just before it expires, which keeps it up for as long as the drag stays refused.
 */
function showDragHintMaybe(store: StoreContextModel, text: string): void {
  const nowMs = performance.now();
  if (lastDragHint != null && lastDragHint.text == text && nowMs - lastDragHint.ms < DRAG_HINT_INTERVAL_MS) {
    return;
  }
  lastDragHint = { text, ms: nowMs };
  showTransientMessage(store, text, TransientMessageType.Info, DRAG_HINT_INTERVAL_MS + 1500);
}

function showRefusedFileDragHintMaybe(store: StoreContextModel, text: string | null): void {
  if (text == null) {
    refusedFileDragSince = null;
    return;
  }
  const nowMs = performance.now();
  if (refusedFileDragSince == null || refusedFileDragSince.text != text ||
    nowMs - refusedFileDragSince.lastMs > REFUSED_FILE_DRAG_GAP_MS) {
    refusedFileDragSince = { text, ms: nowMs, lastMs: nowMs };
  }
  refusedFileDragSince.lastMs = nowMs;
  if (nowMs - refusedFileDragSince.ms >= REFUSED_FILE_DRAG_HINT_DELAY_MS) {
    showDragHintMaybe(store, text);
  }
}

function isAttachmentTarget(target: UploadTarget): boolean {
  return target.kind == "table-cell-attachment" || target.kind == "attach-hitbox";
}

function parentChainAcceptsManualChildAdd(parentId: string): boolean {
  let current = itemState.get(parentId);
  while (current != null) {
    if (isPage(current)) {
      return current.clientOnly !== true && itemCanEdit(current) && itemCanAcceptManualChildren(current);
    }
    current = current.parentId != null ? itemState.get(current.parentId) : null;
  }
  return true;
}

function uploadTargetAcceptsManualChildAdd(target: UploadTarget): boolean {
  switch (target.kind) {
    case "page-position":
    case "page-ordered":
      return target.parent.clientOnly !== true &&
        itemCanEdit(target.parent) &&
        itemCanAcceptManualChildren(target.parent);
    case "container-row":
      return parentChainAcceptsManualChildAdd(target.parentId);
    case "table-cell-attachment":
    case "attach-hitbox":
      return parentChainAcceptsManualChildAdd(target.parent.id);
  }
}

function uploadTargetParentId(target: UploadTarget): string {
  return target.kind == "container-row" ? target.parentId : target.parent.id;
}

/**
 * Why files can't be put in the target, or null if they can. fileCount is 0 if not known, which it may not be while
 * dragging (see updateExternalUploadHover).
 */
function uploadTargetRefusalMessage(
  store: StoreContextModel,
  target: UploadTarget | null,
  fileCount: number,
  noTargetMessage: string,
): string | null {
  if (target == null) {
    return noTargetMessage;
  }
  const parentId = uploadTargetParentId(target);
  // Uploads go to this server, so can't be added to an item that is shown from another.
  if (itemState.get(parentId)?.origin != null) {
    return "Can't add files to an item from another server";
  }
  // Items are moved to the trash to delete them. A file dropped on its icon in the dock is far more likely a slip.
  if (parentId == store.user.getUserMaybe()?.trashPageId) {
    return "Can't upload files to the trash";
  }
  if (!uploadTargetAcceptsManualChildAdd(target)) {
    return "Can't add items to this page";
  }
  if (isAttachmentTarget(target) && fileCount > 1) {
    return "Only one file can be attached at a time";
  }
  return null;
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
  const attachItem = asAttachmentsItem(attachVe.displayItem);
  // Attachments are laid out along the top of the item, which (unlike the contents of a page) doesn't scroll.
  const veBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, attachVe);
  const clampedIndex = calcSpatialAttachmentInsertIndex(
    veBoundsPx,
    attachmentAnchorRightPxForVe(attachVe, veBoundsPx.w),
    attachmentBlockSizePxForVe(attachVe, veBoundsPx.w),
    desktopPx.x,
    attachItem.computed_attachments.length,
  );
  return clampedIndex;
}

function getTableCellAttachmentTarget(store: StoreContextModel, tableVe: VisualElement, insertRow: number): AttachmentsItem | null {
  return TableFns.tableAttachmentTargetAtRow(store, tableVe, insertRow);
}

function supportsOrderedPageExternalUpload(page: PageItem): boolean {
  return page.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
    page.arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
    page.arrangeAlgorithm == ArrangeAlgorithm.List ||
    page.arrangeAlgorithm == ArrangeAlgorithm.Document ||
    page.arrangeAlgorithm == ArrangeAlgorithm.Justified;
}

function orderedPageInsertionFromDesktopPx(
  store: StoreContextModel,
  pageVe: VisualElement,
  desktopPx: Vector,
): JustifiedInsertion {
  const page = asPageItem(pageVe.displayItem);
  if (page.arrangeAlgorithm == ArrangeAlgorithm.Justified && parseSortOrder(page.orderChildrenBy) == null &&
    pageVe.viewportBoundsPx && pageVe.childAreaBoundsPx) {
    return justifiedInsertionFromDesktopPx(store, pageVe, desktopPx);
  }
  return { index: orderedPageInsertIndexFromDesktopPx(store, pageVe, desktopPx), afterPrevious: false };
}

function orderedPageInsertIndexFromDesktopPx(
  store: StoreContextModel,
  pageVe: VisualElement,
  desktopPx: Vector,
): number {
  const page = asPageItem(pageVe.displayItem);
  if (parseSortOrder(page.orderChildrenBy) != null && page.arrangeAlgorithm != ArrangeAlgorithm.Document) {
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
      const pagePaddingPx = calcJustifiedPagePaddingPx(pageVe.childAreaBoundsPx.w, page.justifiedRowAspect);
      const rawCellX = Math.floor((xOffsetPx + scrollXPx - pagePaddingPx) / pageVe.cellSizePx.w);
      const rawCellY = Math.floor((yOffsetPx + scrollYPx - pagePaddingPx) / pageVe.cellSizePx.h);
      const cellX = Math.max(0, Math.min(page.gridNumberOfColumns, rawCellX));
      const cellY = Math.max(0, rawCellY);
      const rawIndex = cellY * page.gridNumberOfColumns + cellX;
      return Math.max(0, Math.min(rawIndex, page.computed_children.length));
    }

    case ArrangeAlgorithm.List:
      if (!pageVe.viewportBoundsPx || !pageVe.childAreaBoundsPx) {
        return page.computed_children.length;
      }

      {
        return stackedInsertionIndexFromDesktopPx(store, PageFns.listPageInsertionRowVes(pageVe), desktopPx);
      }

    case ArrangeAlgorithm.Catalog: {
      const numNonMovingChildren = VesCache.render.getNonMovingChildren(VeFns.veToPath(pageVe))().length;
      return catalogInsertionIndexFromDesktopPx(store, pageVe, numNonMovingChildren, desktopPx);
    }

    case ArrangeAlgorithm.Document: {
      const pagePath = VeFns.veToPath(pageVe);
      const childVes = VesCache.render.getNonMovingChildren(pagePath)().map((childVe) => childVe.get());
      return stackedInsertionIndexFromDesktopPx(store, childVes, desktopPx);
    }

    default:
      return page.computed_children.length;
  }
}

/** Rounded to the half block grid, as for an item moved there (calculateMoveToPagePositionGr). */
function spatialDropPositionGr(store: StoreContextModel, pageVe: VisualElement, desktopPx: Vector): Vector | null {
  const posGr = VeFns.desktopPxToPageGr(store, pageVe, desktopPx);
  if (posGr == null) {
    return null;
  }
  return {
    x: Math.max(0, Math.round(posGr.x / GRID_SIZE * 2.0) / 2.0 * GRID_SIZE),
    y: Math.max(0, Math.round(posGr.y / GRID_SIZE * 2.0) / 2.0 * GRID_SIZE),
  };
}

/**
 * Files dropped on a child page go into it, as an item moved there does (mouseUpHandler_moving_toOpaquePage). That
 * includes a translucent page: the page as a whole is the target, as for an item move, and nothing inside it reacts.
 * If the page shows its spatial contents, the files go where they were dropped; otherwise at its top left.
 */
function childPageUploadTarget(store: StoreContextModel, childPageVe: VisualElement, desktopPx: Vector): UploadTarget {
  const childPage = asPageItem(childPageVe.displayItem);
  const showsSpatialContents =
    childPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch &&
    !!(childPageVe.flags & VisualElementFlags.ShowChildren) &&
    childPageVe.childAreaBoundsPx != null &&
    childPageVe.viewportBoundsPx != null;
  const posGr = showsSpatialContents ? spatialDropPositionGr(store, childPageVe, desktopPx) : null;
  return { kind: "page-position", parent: childPage, posGr: posGr ?? { x: 0, y: 0 } };
}

/**
 * Where files dropped at the position go, following an item moved there where it can: into the page, container or
 * table row under the pointer, or attached to the item whose attachment strip it is over.
 */
function resolveExternalUploadTarget(
  store: StoreContextModel,
  desktopPx: Vector,
  syncHoverState: boolean,
): UploadTarget | null {
  const hitInfo = HitInfoFns.hitForDrop(store, desktopPx, [], false);
  const tableContainerVeMaybe = HitInfoFns.getTableContainerVe(hitInfo);
  if (syncHoverState) {
    clearMouseOverState(store);
  }

  if (tableContainerVeMaybe != null) {
    return resolveTableUploadTarget(store, hitInfo, tableContainerVeMaybe, desktopPx, syncHoverState);
  }

  const setHover = (containerPath: VisualElementPath | null, attachPath: VisualElementPath | null, attachIndex: number, ordered: boolean) => {
    if (!syncHoverState) { return; }
    syncExternalUploadMoveOverContainer(store, containerPath);
    syncExternalUploadAttachHover(store, attachPath, attachIndex);
    store.externalFileDragActive.set(ordered);
  };

  // As for an item moved there, the attachment strip takes precedence over the container it is in.
  const overVeMaybe = hitInfo.overVes?.get() ?? null;
  if (overVeMaybe != null && (hitInfo.hitboxType & HitboxFlags.Attach) && isAttachmentsItem(overVeMaybe.displayItem)) {
    const insertPosition = attachmentInsertIndexFromDesktopPx(store, overVeMaybe, desktopPx);
    setHover(null, VeFns.veToPath(overVeMaybe), insertPosition, false);
    return { kind: "attach-hitbox", parent: asAttachmentsItem(overVeMaybe.displayItem), insertPosition };
  }

  const rootVe = hitInfo.rootVes.get();
  const rootPath = VeFns.veToPath(rootVe);
  const containerVe = HitInfoFns.getOverContainerVe(hitInfo);
  const containerPath = VeFns.veToPath(containerVe);
  if (isPage(containerVe.displayItem) && containerPath != rootPath) {
    setHover(containerPath, null, -1, false);
    return childPageUploadTarget(store, containerVe, desktopPx);
  }

  if (!isPage(rootVe.displayItem)) {
    setHover(null, null, -1, false);
    return null;
  }
  const rootPage = asPageItem(rootVe.displayItem);

  // Over a composite in an ordered page, e.g. a document, files go into the page at the insertion line, as before.
  if (supportsOrderedPageExternalUpload(rootPage)) {
    const insertion = orderedPageInsertionFromDesktopPx(store, rootVe, desktopPx);
    const insertIndex = insertion.index;
    setHover(rootPath, null, -1, true);
    if (syncHoverState) {
      store.perVe.setMoveOverIndex(rootPath, insertIndex);
      store.perVe.setMoveOverIndexAndPosition(rootPath, { index: insertIndex, position: insertion.afterPrevious ? 1 : 0 });
    }
    if (rootPage.arrangeAlgorithm == ArrangeAlgorithm.List) {
      const insertionTarget = PageFns.listPageInsertionTarget(rootVe, insertIndex, []);
      return { kind: "container-row", parentId: insertionTarget.parentContainer.id, insertIndex: insertionTarget.insertIndex };
    }
    return { kind: "page-ordered", parent: rootPage, insertIndex };
  }

  setHover(null, null, -1, false);
  // Composites aren't targets: an item moved onto one joins it, which isn't what dropping a file should do.
  if (isComposite(containerVe.displayItem)) {
    return null;
  }

  if (rootPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
    // Over one of its items too, as for an item moved there: the files go where they were dropped.
    const posGr = spatialDropPositionGr(store, rootVe, desktopPx) ?? hitInfo.overPositionGr ?? { x: 0, y: 0 };
    return { kind: "page-position", parent: rootPage, posGr };
  }

  // Other arrangements (e.g. calendar) only take files on their background.
  return hitInfo.hitboxType == HitboxFlags.None
    ? { kind: "page-position", parent: rootPage, posGr: { x: 0, y: 0 } }
    : null;
}

function resolveTableUploadTarget(
  store: StoreContextModel,
  hitInfo: HitInfo,
  tableContainerVe: VisualElement,
  desktopPx: Vector,
  syncHoverState: boolean,
): UploadTarget {
  const normalizedTableMoveDesktopPx = TableFns.normalizeMoveOverDesktopPx(store, tableContainerVe, desktopPx);
  const isOverTableRootAttach =
    !!(hitInfo.hitboxType & HitboxFlags.Attach) &&
    hitInfo.overVes != null &&
    isTable(hitInfo.overVes.get().displayItem);
  const shouldTreatTableHeaderAsFirstRow =
    isOverTableRootAttach &&
    normalizedTableMoveDesktopPx.y != desktopPx.y;
  const tableChildContainerDropTargetPath =
    hitInfo.overVes != null &&
      !!(hitInfo.hitboxType & HitboxFlags.OpenPopup) &&
      !!(hitInfo.overVes.get().flags & VisualElementFlags.InsideTable) &&
      isPage(hitInfo.overVes.get().displayItem)
      ? VeFns.veToPath(hitInfo.overVes.get())
      : null;
  const tablePath = VeFns.veToPath(tableContainerVe);

  if (syncHoverState) {
    syncExternalUploadMoveOverContainer(store, tablePath);
  }

  let nextAttachHitboxPath: VisualElementPath | null = null;
  let nextAttachInsertIndex = -1;
  let target: UploadTarget;

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
    const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, tableContainerVe, desktopPx);
    const tableCellAttachmentTarget = getTableCellAttachmentTarget(store, tableContainerVe, insertRow);
    if (syncHoverState) {
      store.perVe.setMoveOverRowNumber(tablePath, insertRow);
      store.perVe.setMoveOverChildContainerPath(tablePath, tableChildContainerDropTargetPath);
      store.perVe.setMoveOverColAttachmentNumber(tablePath, tableCellAttachmentTarget != null ? attachmentPos : -1);
    }

    if (tableChildContainerDropTargetPath != null && hitInfo.overVes != null && isPage(hitInfo.overVes.get().displayItem)) {
      target = { kind: "page-position", parent: asPageItem(hitInfo.overVes.get().displayItem), posGr: { x: 0, y: 0 } };
    } else if (tableCellAttachmentTarget != null && attachmentPos >= 0) {
      target = {
        kind: "table-cell-attachment",
        parent: tableCellAttachmentTarget,
        insertPosition: attachmentPos,
      };
    } else {
      const insertionTarget = TableFns.tableInsertionTarget(store, tableContainerVe, insertRow);
      target = {
        kind: "container-row",
        parentId: insertionTarget.parentContainer.id,
        insertIndex: insertionTarget.insertIndex,
      };
    }
  }

  if (syncHoverState) {
    syncExternalUploadAttachHover(store, nextAttachHitboxPath, nextAttachInsertIndex);
    store.externalFileDragActive.set(true);
  }

  return target;
}

function waitForBrowserAfterDrop(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

/** Must be called while the drop event is being dispatched: the items can't be read after it returns. */
function dataTransferContainsDirectory(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(item =>
    item.kind == "file" && item.webkitGetAsEntry?.()?.isDirectory == true);
}

function confirmLargeExternalUploadMaybe(files: ReadonlyArray<File>): boolean {
  const isSlowUpload = files.length > EXTERNAL_UPLOAD_CONFIRMATION_FILE_THRESHOLD ||
    files.some(file => file.size > EXTERNAL_UPLOAD_CONFIRMATION_FILE_BYTES);
  const largeTextFiles = files.filter(file =>
    uploadItemTypeForFile(file) == ItemType.Text && file.size > TEXT_UPLOAD_CONFIRMATION_FILE_BYTES);
  if (!isSlowUpload && largeTextFiles.length == 0) {
    return true;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const what = files.length == 1 ? `"${files[0].name}"` : `${files.length} files`;
  let message = `Upload ${what} (${formatBytes(totalBytes)})?`;
  if (largeTextFiles.length > 0) {
    const which = largeTextFiles.length == 1 && files.length > 1 ? ` "${largeTextFiles[0].name}" is` : files.length == 1 ? " It is" : " Some are";
    message += `${which} over ${formatBytes(TEXT_UPLOAD_CONFIRMATION_FILE_BYTES)} of text, which may be slow to open as a text item.`;
  }
  if (isSlowUpload) {
    message += " This may take a while.";
  }
  return window.confirm(message);
}

function cascadedUploadPositionGr(page: PageItem, baseGr: Vector, fileIndex: number): Vector {
  const step = fileIndex % CASCADE_RUN_LENGTH;
  const run = Math.floor(fileIndex / CASCADE_RUN_LENGTH);
  // At least the minimum upload width (see spatialWidthGrForUpload) stays inside the page.
  const maxXGr = Math.max(0, page.innerSpatialWidthGr - 2.5 * GRID_SIZE);
  return {
    x: Math.min(baseGr.x + (step + run * CASCADE_RUN_OFFSET_BL) * GRID_SIZE, maxXGr),
    y: baseGr.y + step * GRID_SIZE,
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
  server.addItem(placeholderItem, null);
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
      server.deleteItem(placeholderToReplaceMaybe.id);
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
        server.deleteItem(prevPlaceholderMaybe.id);
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
    server.deleteItem(placeholderToReplaceMaybe.id);
    return ordering;
  }

  if (insertPosition > 0) {
    const prevAttachmentId = parent.computed_attachments[insertPosition - 1];
    const prevPlaceholderMaybe = itemState.get(prevAttachmentId)!;
    if (isPlaceholder(prevPlaceholderMaybe)) {
      const ordering = prevPlaceholderMaybe.ordering;
      itemState.delete(prevPlaceholderMaybe.id);
      server.deleteItem(prevPlaceholderMaybe.id);
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
    case "page-position": {
      // No ordering: the server appends to the page's children, which needn't be loaded, e.g. for an opaque page.
      const isSpatial = target.parent.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch;
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Child,
        spatialPageParentMaybe: isSpatial ? target.parent : null,
        posGr: isSpatial ? cascadedUploadPositionGr(target.parent, target.posGr, fileIndex) : { x: 0, y: 0 },
      };
    }

    case "page-ordered":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Child,
        ordering: itemState.newOrderingAtChildrenPosition(target.parent.id, target.insertIndex + fileIndex, null),
        spatialPageParentMaybe: null,
        posGr: { x: 0, y: 0 },
      };

    case "container-row":
      return {
        parentId: target.parentId,
        relationshipToParent: RelationshipToParent.Child,
        ordering: itemState.newOrderingAtChildrenPosition(target.parentId, target.insertIndex + fileIndex, null),
        spatialPageParentMaybe: null,
        posGr: { x: 0, y: 0 },
      };

    case "table-cell-attachment":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Attachment,
        ordering: prepareTableCellAttachmentOrdering(target.parent, store, target.insertPosition),
        spatialPageParentMaybe: null,
        posGr: { x: 0, y: 0 },
      };

    case "attach-hitbox":
      return {
        parentId: target.parent.id,
        relationshipToParent: RelationshipToParent.Attachment,
        ordering: prepareAttachHitboxOrdering(target.parent, store, target.insertPosition),
        spatialPageParentMaybe: null,
        posGr: { x: 0, y: 0 },
      };
  }
}

function spatialWidthGrForUpload(
  spatialParent: PageItem | null,
  posGr: Vector,
  defaultWidthGr: number,
): number {
  if (spatialParent == null) {
    return defaultWidthGr;
  }

  let maxWidthBl = Math.floor((spatialParent.innerSpatialWidthGr - posGr.x - GRID_SIZE / 2.0) / GRID_SIZE);
  if (maxWidthBl < 2) {
    maxWidthBl = 2;
  }
  const maxWidthGr = maxWidthBl * GRID_SIZE;
  return Math.min(defaultWidthGr, maxWidthGr);
}

function makeUploadPartialObject(
  file: File,
  placement: UploadPlacement,
  spatialWidthGr: number,
  itemType: ItemType,
): object {
  return {
    itemType,
    parentId: placement.parentId,
    relationshipToParent: placement.relationshipToParent,
    ordering: placement.ordering != null ? Array.from(placement.ordering) : undefined,
    title: file.name,
    spatialPositionGr: placement.posGr,
    spatialWidthGr,
    originalCreationDate: sanitizeOriginalCreationDate(Math.round(file.lastModified / 1000.0), `uploading ${itemType} ${file.name}`),
    fileSizeBytes: file.size,
  };
}

async function uploadFilesToTarget(
  store: StoreContextModel,
  files: ReadonlyArray<File>,
  target: UploadTarget,
): Promise<void> {
  if (files.length > 0) {
    store.overlay.uploadOverlayInfo.set({
      currentFile: 0,
      totalFiles: files.length,
      currentFileName: files[0].name,
    });
  }

  // The overlay blocks all interaction, so it must be cleared however the loop ends.
  try {
    for (let i = 0; i < files.length; ++i) {
      const file = files[i];
      const uploadStarted = performance.now();

      store.overlay.uploadOverlayInfo.set({
        currentFile: i + 1,
        totalFiles: files.length,
        currentFileName: file.name,
      });

      // Read before computing the placement, which can replace attachment placeholders: a file that can't be read
      // (a folder the drop checks didn't catch, or one moved or deleted since the drag started) changes nothing.
      let base64Data: string;
      try {
        base64Data = base64ArrayBuffer(await file.arrayBuffer());
      } catch (error) {
        console.warn(`Failed to read ${file.name}:`, error);
        showTransientMessage(store, `Couldn't read ${file.name}`, TransientMessageType.Error, 5000);
        continue;
      }

      let preparationMs = 0;
      let requestStarted = performance.now();
      try {
        const placement = placementForUploadTarget(store, target, i);
        const itemType = uploadItemTypeForFile(file);
        const isImageUpload = itemType == ItemType.Image;
        const defaultWidthGr = isImageUpload ? 4.0 * GRID_SIZE : 8.0 * GRID_SIZE;
        const spatialWidthGr = spatialWidthGrForUpload(placement.spatialPageParentMaybe, placement.posGr, defaultWidthGr);
        const partialObject = makeUploadPartialObject(file, placement, spatialWidthGr, itemType);
        preparationMs = Math.round(performance.now() - uploadStarted);
        requestStarted = performance.now();

        const returnedItem = await server.addItemFromPartialObject(partialObject, base64Data);
        itemState.add(ItemFns.fromObject(returnedItem, null));
        requestArrange(store, isImageUpload ? "upload-image" : itemType == ItemType.Text ? "upload-text" : "upload-file");
        console.info(`Upload ${i + 1}/${files.length} (${file.size} bytes) completed: preparation ${preparationMs} ms, request ${Math.round(performance.now() - requestStarted)} ms`);
      } catch (error) {
        console.warn(`Failed to add ${file.name}:`, error);
        console.info(`Upload ${i + 1}/${files.length} (${file.size} bytes) failed: preparation ${preparationMs} ms, request ${Math.round(performance.now() - requestStarted)} ms`);
        showTransientMessage(store, `Couldn't upload ${file.name}`, TransientMessageType.Error, 5000);
      }
    }
  } finally {
    setTimeout(() => {
      // A drop accepted during this delay owns the overlay now.
      if (!externalUploadInProgress) {
        store.overlay.uploadOverlayInfo.set(null);
      }
    }, 300);
  }
}

export function clearExternalUploadHover(store: StoreContextModel): void {
  syncExternalUploadMoveOverContainer(store, null);
  syncExternalUploadAttachHover(store, null, -1);
  clearMouseOverState(store);
  store.externalFileDragActive.set(false);
  externalUploadDropTarget = null;
}

/**
 * Whether a drop at the position would be accepted, so the drag can show it before it's let go. A refused drag gets
 * no drop event, so says nothing more. Checks that need the files themselves (folders, sizes) can only be made on drop.
 */
export function updateExternalUploadHover(
  store: StoreContextModel,
  dataTransfer: DataTransfer,
  desktopPx: Vector,
): boolean {
  if (!dataTransferContainsFiles(dataTransfer)) {
    clearExternalUploadHover(store);
    return false;
  }
  if (externalUploadInProgress) {
    clearExternalUploadHover(store);
    showRefusedFileDragHintMaybe(store, "Wait for the current upload to finish");
    return false;
  }

  const target = resolveExternalUploadTarget(store, desktopPx, true);
  // The number of files is known while dragging, though not the files. Zero means it isn't (see the drop handler).
  const dragFileCount = Array.from(dataTransfer.items).filter(item => item.kind == "file").length;
  const refusalMessage = uploadTargetRefusalMessage(store, target, dragFileCount, "Files can't be dropped here");
  const accepted = refusalMessage == null;
  externalUploadDropTarget = accepted ? target : null;
  if (!accepted) {
    clearExternalUploadHover(store);
  }
  showRefusedFileDragHintMaybe(store, refusalMessage);
  return accepted;
}

export async function handleExternalUploadDrop(
  store: StoreContextModel,
  dataTransfer: DataTransfer,
  desktopPx: Vector,
): Promise<void> {
  // Other drags are refused on dragover, so shouldn't get here, but if one does it must not look like it worked.
  if (!dataTransferContainsFiles(dataTransfer)) {
    clearExternalUploadHover(store);
    showTransientMessage(store, "Only files can be dropped here");
    return;
  }

  if (externalUploadInProgress) {
    clearExternalUploadHover(store);
    showTransientMessage(store, "Wait for the current upload to finish");
    return;
  }
  // Set before the first await, so a drop that arrives while this one is still being checked is refused too.
  externalUploadInProgress = true;

  const files = Array.from(dataTransfer.files);
  const containsDirectory = dataTransferContainsDirectory(dataTransfer);
  const target = externalUploadDropTarget ?? resolveExternalUploadTarget(store, desktopPx, false);

  try {
    await waitForBrowserAfterDrop();

    // The drag said it had files, but the browser didn't provide any, e.g. if the source only offers to create them
    // on request (macOS file promises).
    if (files.length == 0) {
      showTransientMessage(store, "Couldn't get any files from this drop");
      return;
    }

    await checkAndUploadFiles(store, files, containsDirectory, target, "Files can't be dropped here");
  } finally {
    externalUploadInProgress = false;
    clearExternalUploadHover(store);
  }
}

/**
 * Uploads the files to the target, if they can be: if not, says why. The caller must hold externalUploadInProgress.
 * noTargetMessage is what's said if there is no target where the files were put.
 */
async function checkAndUploadFiles(
  store: StoreContextModel,
  files: ReadonlyArray<File>,
  containsDirectory: boolean,
  target: UploadTarget | null,
  noTargetMessage: string,
): Promise<void> {
  const fileCount = files.length;
  if (fileCount > MAX_EXTERNAL_UPLOAD_FILES) {
    showTransientMessage(store, `Can only drop up to ${MAX_EXTERNAL_UPLOAD_FILES} files at once`);
    return;
  }

  if (containsDirectory) {
    showTransientMessage(store, "Folders can't be uploaded");
    return;
  }

  const tooLargeFile = files.find(file => file.size > MAX_EXTERNAL_UPLOAD_FILE_BYTES);
  if (tooLargeFile != null) {
    showTransientMessage(store, `${tooLargeFile.name} is too large to upload (max ${formatBytes(MAX_EXTERNAL_UPLOAD_FILE_BYTES)})`, TransientMessageType.Error, 5000);
    return;
  }

  const refusalMessage = uploadTargetRefusalMessage(store, target, fileCount, noTargetMessage);
  if (refusalMessage != null || target == null) {
    showTransientMessage(store, refusalMessage ?? noTargetMessage);
    return;
  }

  if (!confirmLargeExternalUploadMaybe(files)) {
    return;
  }

  await uploadFilesToTarget(store, files, target);
}

/**
 * Files on the clipboard, e.g. from a browser's Copy image, are uploaded to where the pointer is, as if dropped there.
 * Returns whether the paste was taken.
 */
export function pasteFilesMaybe(store: StoreContextModel, ev: ClipboardEvent): boolean {
  const clipboardData = ev.clipboardData;
  if (clipboardData == null || clipboardData.files.length == 0 || store.overlay.anOverlayIsVisible()) {
    return false;
  }
  ev.preventDefault();

  if (externalUploadInProgress) {
    showTransientMessage(store, "Wait for the current upload to finish");
    return true;
  }
  externalUploadInProgress = true;

  // Read now: like a drop's, the clipboard's items can't be read after the event returns.
  const files = Array.from(clipboardData.files);
  const containsDirectory = dataTransferContainsDirectory(clipboardData);
  const desktopPx = CursorEventState.getLatestDesktopPx(store);
  const target = resolveExternalUploadTarget(store, desktopPx, false);
  void (async () => {
    try {
      await checkAndUploadFiles(store, files, containsDirectory, target, "Files can't be pasted here");
    } finally {
      externalUploadInProgress = false;
    }
  })();
  return true;
}
