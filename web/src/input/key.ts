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

import { GRID_SIZE, TABLE_COL_HEADER_HEIGHT_BL, TABLE_TITLE_HEADER_HEIGHT_BL } from "../constants";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PageFlags, TableFlags } from "../items/base/flags-item";
import { ImageFns, isImage } from "../items/image-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { asAttachmentsItem, isAttachmentsItem } from "../items/base/attachments-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { arrangeNow, arrangeVirtual } from "../layout/arrange";
import { findClosest, FindDirection, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { EMPTY_VEID, VeFns, VisualElement, VisualElementFlags, veFlagIsRoot } from "../layout/visual-element";


import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState, MouseActionState } from "./state";
import { newItemInContext } from "./create";
import { isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { serverOrRemote } from "../server";
import { ItemType } from "../items/base/item";
import { HitInfoFns } from "./hit";
import { UMBRELLA_PAGE_UID } from "../util/uid";
import { asContainerItem } from "../items/base/container-item";
import { MOUSE_RIGHT, mouseDownHandler } from "./mouse_down";
import { isComposite } from "../items/composite-item";
import { FileFns, isFile } from "../items/file-item";
import { NoteFns, isNote } from "../items/note-item";
import { PasswordFns, isPassword } from "../items/password-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { getVePropertiesForItem } from "../layout/arrange/util";


/**
 * Whether or not the value of KeyboardEvent.code corresponds to one of the arrow keys.
 */
export function isArrowKey(key: string) {
  if (key == "ArrowDown") { return true; }
  if (key == "ArrowUp") { return true; }
  if (key == "ArrowLeft") { return true; }
  if (key == "ArrowRight") { return true; }
  return false;
}

function isShiftKey(code: string): boolean {
  return code == "ShiftLeft" || code == "ShiftRight";
}

let shiftNavigationGesture = {
  pending: false,
  cancelled: false,
};

function beginShiftNavigationGesture(ev: KeyboardEvent): void {
  if (ev.repeat) { return; }

  // Treat a bare Shift tap as the keyboard equivalent of right-click/back-up,
  // but cancel it as soon as Shift becomes part of another gesture.
  shiftNavigationGesture = {
    pending: true,
    cancelled: ev.ctrlKey || ev.metaKey || ev.altKey || !MouseActionState.empty(),
  };
}

function consumeShiftNavigationGesture(): boolean {
  const shouldNavigate = shiftNavigationGesture.pending && !shiftNavigationGesture.cancelled;
  shiftNavigationGesture = { pending: false, cancelled: false };
  return shouldNavigate;
}

export function cancelShiftNavigationGesture(): void {
  if (!shiftNavigationGesture.pending) { return; }
  shiftNavigationGesture.cancelled = true;
}


/**
 * Top level handler for keydown events.
 */
export function keyDownHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  if (isShiftKey(ev.code)) {
    beginShiftNavigationGesture(ev);
    return;
  }

  cancelShiftNavigationGesture();

  // IMPORTANT: keep these in sync with the code below.

  const recognizedKeys = [
    "Slash", "Backslash", "Escape", "Enter", "Space", "F2",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "KeyN", "KeyP", "KeyT", "KeyR", "KeyW", "KeyL", "KeyE", "KeyF",
  ];

  if (document.activeElement!.id.includes('toolbarTitleDiv')) {
    const titleText = (document.activeElement! as HTMLElement).innerText;
    if (ev.code == "Enter" || ev.code == "Escape") {
      (document.activeElement! as HTMLElement).blur();
      let selection = window.getSelection();
      if (selection != null) { selection.removeAllRanges(); }
      const focusItem = store.history.getFocusItem();
      asPageItem(focusItem).title = titleText;
      if (focusItem.relationshipToParent == RelationshipToParent.Child) {
        const parentItem = itemState.get(focusItem.parentId);
        if (parentItem && isTable(parentItem) && asTableItem(parentItem).orderChildrenBy != "") {
          itemState.sortChildren(focusItem.parentId);
        }
      }
      arrangeNow(store, "key-toolbar-title-commit");
      serverOrRemote.updateItem(focusItem, store.general.networkStatus);
      ev.preventDefault();
    }
    return;
  }

  if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
    if (ev.code == "Escape") {
      ev.preventDefault();
      store.overlay.setTextEditInfo(store.history, null, true);
      arrangeNow(store, "key-escape-cancel-edit");
      return;
    }

    // TODO (HIGH)
    // event is fired before content is updated.
    return;
  }

  // input box is in toolbar.
  if (isLink(store.history.getFocusItem())) { return; }

  if (store.overlay.anOverlayIsVisible()) { return; }

  if (!recognizedKeys.find(a => a == ev.code)) { return; }

  const hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);

  if (ev.code == "Slash") {
    ev.preventDefault();
    store.overlay.contextMenuInfo.set({ posPx: CursorEventState.getLatestDesktopPx(store), hitInfo });
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
  }

  else if (ev.code == "Backslash") {
    return;
  }

  else if (ev.code == "Escape") {
    ev.preventDefault();
    // Exit text edit mode while keeping focus on the item
    if (store.overlay.textEditInfo()) {
      store.overlay.setTextEditInfo(store.history, null, true);
      arrangeNow(store, "key-escape-exit-edit");
      return;
    }
    if (store.history.currentPopupSpec()) {
      store.history.popPopup();
      const topRootVes = VesCache.render.getChildren(VeFns.veToPath(store.umbrellaVisualElement.get()))()[0];
      VesCache.mutate.clearPopup(VeFns.veToPath(topRootVes.get()));
      topRootVes.set(topRootVes.get());
      arrangeNow(store, "key-escape-close-popup");
      return;
    }

    focusParentMaybe(store);
  }

  else if (isArrowKey(ev.code)) {
    arrowKeyHandler(store, ev);
  }

  else if (ev.code == "Enter") {
    if (ev.metaKey) {
      if (!store.dockVisible.get() && !store.topToolbarVisible.get()) {
        store.dockVisible.set(true);
        store.topToolbarVisible.set(true);
      } else {
        store.dockVisible.set(false);
        store.topToolbarVisible.set(false);
      }
      arrangeNow(store, "key-toggle-dock-toolbar");
      return;
    }

    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe && !store.overlay.textEditInfo()) {
      if (isPage(focusVe.displayItem) &&
        !!(asPageItem(focusVe.displayItem).flags & PageFlags.EmbeddedInteractive) &&
        ev.shiftKey) {
        ev.preventDefault();
        switchToPage(store, VeFns.actualVeidFromVe(focusVe), true, false, false);
        return;
      }

      if (openPopupForFocusedItemMaybe(store, focusVe, false)) {
        ev.preventDefault();
        return;
      }

      if (!isPage(focusVe.displayItem) && focusFirstChildMaybe(store, focusPath, focusVe)) {
        ev.preventDefault();
        return;
      }

      if (isPage(focusVe.displayItem)) {
        const pageItem = asPageItem(focusVe.displayItem);
        if ((veFlagIsRoot(focusVe.flags) || !!(pageItem.flags & PageFlags.EmbeddedInteractive)) &&
          focusFirstChildMaybe(store, focusPath, focusVe)) {
          ev.preventDefault();
          return;
        }
      }
    }

    // If an opaque/translucent page has focus (no popup showing), open the popup
    if (focusVe && isPage(focusVe.displayItem) && !store.history.currentPopupSpec()) {
      const pageItem = asPageItem(focusVe.displayItem);
      if (!(pageItem.flags & PageFlags.EmbeddedInteractive)) {
        ev.preventDefault();
        if (!veFlagIsRoot(focusVe.flags)) {
          // Non-root page: open popup
          PageFns.handleOpenPopupClick(focusVe, store, false);
          return;
        }
      }
    }

    const spec = store.history.currentPopupSpec();
    if (spec && itemState.get(spec.actualVeid.itemId)!.itemType == ItemType.Page) {
      switchToPage(store, store.history.currentPopupSpec()!.actualVeid, true, false, false);
    }
  }

  else if (ev.code == "Space") {
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe && !store.overlay.textEditInfo() && openPopupForFocusedItemMaybe(store, focusVe, true)) {
      ev.preventDefault();
      return;
    }
  }

  else if (ev.code == "F2") {
    ev.preventDefault();
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe) {
      editFocusedItemMaybe(store, focusVe);
    }
  }

  else if (ev.code == "KeyN") {
    ev.preventDefault();
    newItemInContext(store, "note", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyP") {
    ev.preventDefault();
    newItemInContext(store, "page", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyT") {
    ev.preventDefault();
    newItemInContext(store, "table", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyR") {
    ev.preventDefault();
    newItemInContext(store, "rating", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyW") {
    ev.preventDefault();
    newItemInContext(store, "password", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyL") {
    ev.preventDefault();
    newItemInContext(store, "link", hitInfo, CursorEventState.getLatestDesktopPx(store));
  }

  else if (ev.code == "KeyE") {
    ev.preventDefault();
    return;
  }

  else if (ev.code == "KeyF") {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      store.overlay.findOverlayVisible.set(true);
    }
    return;
  }

  else {
    panic(`Unexpected key code: ${ev.code}`);
  }
}

function focusParentMaybe(store: StoreContextModel): boolean {
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath);
  if (!focusVe) { return false; }

  const parentPath = VeFns.parentPath(focusPath);
  if (!parentPath || parentPath === UMBRELLA_PAGE_UID || parentPath === "") { return false; }

  if (focusVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
    store.history.setFocus(parentPath);
    arrangeNow(store, "key-focus-parent-embedded-interactive");
    return true;
  }

  if (veFlagIsRoot(focusVe.flags)) { return false; }

  store.history.setFocus(parentPath);
  arrangeNow(store, "key-focus-parent");
  return true;
}

function focusFirstChildMaybe(store: StoreContextModel, focusPath: string, focusVe: VisualElement): boolean {
  const focusItem = focusVe.displayItem;

  if (isPage(focusItem)) {
    const pageItem = asPageItem(focusItem);
    if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.List) {
      const pageVeid = VeFns.actualVeidFromVe(focusVe);
      PageFns.setDefaultListPageSelectedItemMaybe(store, pageVeid);
      let selectedVeid = store.perItem.getSelectedListPageItem(pageVeid);
      if (selectedVeid == EMPTY_VEID && pageItem.computed_children.length > 0) {
        selectedVeid = VeFns.veidFromId(pageItem.computed_children[0]);
      }
      if (selectedVeid != EMPTY_VEID && selectedVeid.itemId !== "") {
        store.history.setFocus(VeFns.addVeidToPath(selectedVeid, focusPath));
        arrangeNow(store, "key-enter-focus-list-child");
        return true;
      }
      return false;
    }

    if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const topLeftChild = VesCache.current.readIndexedChildren(focusPath)
        .filter(child =>
          !!child.boundsPx &&
          !(child.flags & VisualElementFlags.Attachment) &&
          !(child.flags & VisualElementFlags.Popup) &&
          !(child.flags & VisualElementFlags.LineItem))
        .sort((a, b) => {
          const aDistanceSq = a.boundsPx!.x * a.boundsPx!.x + a.boundsPx!.y * a.boundsPx!.y;
          const bDistanceSq = b.boundsPx!.x * b.boundsPx!.x + b.boundsPx!.y * b.boundsPx!.y;
          if (aDistanceSq !== bDistanceSq) { return aDistanceSq - bDistanceSq; }
          if (a.boundsPx!.y !== b.boundsPx!.y) { return a.boundsPx!.y - b.boundsPx!.y; }
          if (a.boundsPx!.x !== b.boundsPx!.x) { return a.boundsPx!.x - b.boundsPx!.x; }
          return VeFns.veToPath(a).localeCompare(VeFns.veToPath(b));
        })[0];

      if (topLeftChild) {
        store.history.setFocus(VeFns.veToPath(topLeftChild));
        arrangeNow(store, "key-enter-focus-spatial-top-left-child");
        return true;
      }
      return false;
    }

    if (pageItem.computed_children.length > 0) {
      store.history.setFocus(VeFns.addVeidToPath(VeFns.veidFromId(pageItem.computed_children[0]), focusPath));
      arrangeNow(store, "key-enter-focus-page-child");
      return true;
    }
    return false;
  }

  if (isTable(focusItem) || isComposite(focusItem)) {
    const containerItem = asContainerItem(focusItem);
    if (containerItem.computed_children.length > 0) {
      store.history.setFocus(VeFns.addVeidToPath(VeFns.veidFromId(containerItem.computed_children[0]), focusPath));
      arrangeNow(store, "key-enter-focus-container-child");
      return true;
    }
  }

  return false;
}

function openPopupForFocusedItemMaybe(store: StoreContextModel, focusVe: VisualElement, includeTables: boolean): boolean {
  const openUsingPopupHotspot = () => {
    const boundsPx = VeFns.veBoundsRelativeToDesktopPx(store, focusVe);
    const hotspotWidthPx = Math.min(focusVe.blockSizePx?.w ?? focusVe.boundsPx.w, boundsPx.w);
    const hotspotHeightPx = Math.min(focusVe.blockSizePx?.h ?? focusVe.boundsPx.h, boundsPx.h);
    ItemFns.handleOpenPopupClick(focusVe, store, false, {
      x: boundsPx.x + hotspotWidthPx / 2,
      y: boundsPx.y + hotspotHeightPx / 2,
    });
  };

  if (isNote(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (isFile(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (isPassword(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  if (includeTables && isTable(focusVe.displayItem)) {
    openUsingPopupHotspot();
    return true;
  }
  return false;
}

function editFocusedItemMaybe(store: StoreContextModel, focusVe: VisualElement): boolean {
  if (isPage(focusVe.displayItem)) {
    PageFns.handleEditTitleClick(focusVe, store);
    return true;
  }
  if (isTable(focusVe.displayItem)) {
    TableFns.handleClick(focusVe, null, store, true);
    return true;
  }
  if (isNote(focusVe.displayItem)) {
    NoteFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isFile(focusVe.displayItem)) {
    FileFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isPassword(focusVe.displayItem)) {
    PasswordFns.handleClick(focusVe, store, true, true);
    return true;
  }
  if (isImage(focusVe.displayItem)) {
    ImageFns.handleEditClick(focusVe, store);
    return true;
  }
  return false;
}

export async function keyUpHandler(store: StoreContextModel, ev: KeyboardEvent): Promise<void> {
  if (!isShiftKey(ev.code)) { return; }
  if (ev.shiftKey) { return; }
  if (!consumeShiftNavigationGesture()) { return; }

  ev.preventDefault();
  await mouseDownHandler(store, MOUSE_RIGHT);
}


/**
 * Handler for arrow key down events.
 */
function arrowKeyHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  ev.preventDefault(); // TODO (MEDIUM): allow default in some circumstances where it is appropriate for a table to scroll.

  // When a translucent page has focus, skip list page selection and grid/justified scroll handling.
  // Arrow keys should apply to the parent context (navigating to sibling items) instead.
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath);
  const focusedPageIsRoot = !!focusVe && isPage(focusVe.displayItem) && veFlagIsRoot(focusVe.flags);

  if (focusedPageIsRoot && handleArrowKeyCalendarPageMaybe(store, ev)) { return; }
  if (focusedPageIsRoot && handleArrowKeyListPageChangeMaybe(store, ev)) { return; }
  if (focusedPageIsRoot && handleArrowKeyGridOrJustifiedPageScrollMaybe(store, ev)) { return; }

  // Handle arrow keys when an item (including pages) has focus but no popup
  // This enables navigation from a focused (non-editable) item
  if (!store.history.currentPopupSpec()) {
    const focusPath = store.history.getFocusPath();
    const focusVe = VesCache.current.readNode(focusPath);
    if (focusVe) {
      // Navigate to closest item from current focus
      const direction = findDirectionFromKeyCode(ev.code);
      if (handleVirtualizedTableVerticalNavigationMaybe(store, focusPath, focusVe, direction)) { return; }
      const closest = findClosest(VesCache.current, focusPath, direction, true);
      if (closest != null) {
        // Just set focus to the new item - don't pop up pages
        store.history.setFocus(closest);
        arrangeNow(store, "key-arrow-focus-closest");
        return;
      }
      // If no visible sibling found and focus is on a page, try navigating in parent container
      if (isPage(focusVe.displayItem)) {
        const currentPageVeid = store.history.currentPageVeid();
        if (!currentPageVeid) return;

        // Strategy 1: Use navigation history if available (works for tables and normal navigation)
        const historyParentVeid = store.history.peekPrevPageVeid();
        if (historyParentVeid) {
          arrangeVirtual(store, historyParentVeid, "key-arrow-nav-parent-history");
          const parentFocusPath = store.history.getParentPageFocusPath();
          // Check if the path exists in the virtual cache (it might not if it includes a link ID from a popup)
          if (parentFocusPath && VesCache.virtual.readNode(parentFocusPath)) {
            const closestInParent = findClosest(VesCache.virtual, parentFocusPath, direction, false);
            if (closestInParent) {
              const closestVe = VesCache.virtual.readNode(closestInParent);
              if (closestVe && isPage(closestVe.displayItem)) {
                store.history.changeParentPageFocusPath(closestInParent);
                switchToPage(store, VeFns.veidFromPath(closestInParent), true, false, true);
                return;
              }
            }
          }
        }

        // Strategy 2: Use item hierarchy if history doesn't have a parent (works for popup entry)
        const currentPageItem = itemState.get(currentPageVeid.itemId);
        if (currentPageItem && currentPageItem.parentId) {
          // Find the actual parent page (might need to traverse up through tables, etc.)
          let parentId = currentPageItem.parentId;
          let parentItem = itemState.get(parentId);
          while (parentItem && !isPage(parentItem)) {
            parentId = parentItem.parentId;
            parentItem = parentId ? itemState.get(parentId) : null;
          }
          if (parentItem && isPage(parentItem)) {
            const parentVeid = { itemId: parentId, linkIdMaybe: null };
            arrangeVirtual(store, parentVeid, "key-arrow-nav-parent-hierarchy");
            // Find the current page's path in the virtual cache (handles tables and other containers)
            const virtualVesList = VesCache.virtual.findNodes(currentPageVeid);
            if (virtualVesList.length > 0) {
              const virtualVe = virtualVesList[0];
              const currentPagePath = VeFns.veToPath(virtualVe);
              const closestInParent = findClosest(VesCache.virtual, currentPagePath, direction, false);
              if (closestInParent) {
                const closestVe = VesCache.virtual.readNode(closestInParent);
                if (closestVe && isPage(closestVe.displayItem)) {
                  switchToPage(store, VeFns.veidFromPath(closestInParent), true, false, true);
                  return;
                }
              }

              // Strategy 3: Table attachment navigation (when findClosest failed)
              // If this is a table attachment, navigate up/down to attachments in other rows
              if ((virtualVe.flags & VisualElementFlags.InsideTable) &&
                (virtualVe.flags & VisualElementFlags.Attachment) &&
                virtualVe.col != null && virtualVe.row != null && virtualVe.parentPath) {
                if (direction == FindDirection.Up || direction == FindDirection.Down) {
                  // Navigate between attachments in different table rows
                  const rowVe = VesCache.virtual.readNode(virtualVe.parentPath);
                  if (rowVe && rowVe.parentPath) {
                    const tableVe = VesCache.virtual.readNode(rowVe.parentPath);
                    if (tableVe) {
                      // Get sibling rows (other rows in the table)
                      const siblingRows = VesCache.virtual.readSiblings(virtualVe.parentPath);

                      let targetPath: string | null = null;
                      let targetRow: number | null = null;
                      const columnIndex = virtualVe.col;
                      const currentRow = virtualVe.row;

                      for (const rowVe of siblingRows) {
                        if (rowVe.row == null) continue;

                        const childRow = rowVe.row;
                        let rowIsCandidate = false;

                        if (direction == FindDirection.Up) {
                          rowIsCandidate = childRow < currentRow && (targetRow == null || childRow > targetRow);
                        } else {
                          rowIsCandidate = childRow > currentRow && (targetRow == null || childRow < targetRow);
                        }

                        if (!rowIsCandidate) continue;

                        // Find attachments of this row using virtual indexed children.
                        const rowPath = VeFns.veToPath(rowVe);
                        const rowChildren = VesCache.virtual.readIndexedChildren(rowPath);
                        for (const attVe of rowChildren) {
                          if ((attVe.flags & VisualElementFlags.Attachment) && attVe.col === columnIndex) {
                            // Only consider pages
                            if (isPage(attVe.displayItem)) {
                              targetPath = VeFns.veToPath(attVe);
                              targetRow = childRow;
                              break;
                            }
                          }
                        }
                      }

                      if (targetPath) {
                        const targetVeid = VeFns.veidFromPath(targetPath);
                        switchToPage(store, targetVeid, true, false, true);
                        return;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return;
  }

  const currentPopupSpec = store.history.currentPopupSpec()!;
  const path = currentPopupSpec.vePath;
  if (path == null) { return; }
  const direction = findDirectionFromKeyCode(ev.code);
  if (handleTableAttachmentPopupNavigation(store, path, direction)) { return; }
  if (handleTableItemPopupHorizontalNavigation(store, path, direction)) { return; }
  // Handle scrolling of grid/justified page that contains the popup.
  // If at max scroll, this returns false and we continue to page switching logic.
  if (handlePopupGridOrJustifiedPageScrollMaybe(store, path, ev)) { return; }
  const closest = findClosest(VesCache.current, path, direction, true)!;
  if (closest != null) {
    const closestVeid = VeFns.veidFromPath(closest);
    const closestItem = itemState.get(closestVeid.itemId);
    if (!closestItem) { return; }

    // Check if destination item is a page/image (should become popup)
    const isPageOrImage = isPage(closestItem) || isImage(closestItem);
    // Check if destination item is actually an attachment (should become popup)
    const isActualAttachment = closestItem.relationshipToParent === RelationshipToParent.Attachment;

    if (isPageOrImage || isActualAttachment) {
      // Page/image or attachment items: use popup mechanism
      let sourcePositionGr: { x: number, y: number } | undefined = undefined;
      // Only calculate sourcePositionGr for non-page/non-image attachments
      // Pages and images have their own popup positioning (popupPositionGr) and should not use attachment positioning
      if (isActualAttachment && !isPageOrImage) {
        // Calculate sourcePositionGr from VE's center for attachments
        const ve = VesCache.current.readNode(closest);
        if (ve) {
          const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, ve);
          const centerPx = {
            x: veBoundsPx.x + veBoundsPx.w / 2,
            y: veBoundsPx.y + veBoundsPx.h / 2,
          };

          // Find the parent page to convert to Gr coordinates
          const parentPath = VeFns.parentPath(closest);
          if (parentPath) {
            let pageVe = VesCache.current.readNode(parentPath);
            while (pageVe && !isPage(pageVe.displayItem)) {
              if (!pageVe.parentPath) break;
              pageVe = VesCache.current.readNode(pageVe.parentPath);
            }
            if (pageVe && isPage(pageVe.displayItem) && pageVe.childAreaBoundsPx) {
              const pageItem = asPageItem(pageVe.displayItem);
              const pageBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, pageVe);
              const parentInnerSizeBl = PageFns.calcInnerSpatialDimensionsBl(pageItem);

              const pxToGrX = (parentInnerSizeBl.w * GRID_SIZE) / pageVe.childAreaBoundsPx.w;
              const pxToGrY = (parentInnerSizeBl.h * GRID_SIZE) / pageVe.childAreaBoundsPx.h;

              const relativeX = centerPx.x - pageBoundsPx.x;
              const relativeY = centerPx.y - pageBoundsPx.y;

              sourcePositionGr = {
                x: relativeX * pxToGrX,
                y: relativeY * pxToGrY,
              };
            }
          }
        }
      }

      // Only set isFromAttachment for non-page/non-image attachments
      // Pages and images should use their own popup positioning logic (popupPositionGr, etc.)
      const treatAsAttachment = isActualAttachment && !isPageOrImage;

      store.history.replacePopup({
        vePath: closest,
        actualVeid: closestVeid,
        isFromAttachment: treatAsAttachment ? true : undefined,
        sourcePositionGr,
      });
      arrangeNow(store, "key-arrow-replace-popup");
    } else {
      // Non-attachment child items: just set focus, pop the popup
      store.history.popPopup();
      store.history.setFocus(closest);
      arrangeNow(store, "key-arrow-close-popup-focus-item");
    }
  } else {
    // for grid and justified pages, use ordering to wrap around to next or prev line.
    if (direction == FindDirection.Left || direction == FindDirection.Right) {
      const parentPath = VeFns.parentPath(path);
      const parentVe = parentPath ? VesCache.current.readNode(parentPath) : null;
      if (!parentVe) { return; }
      const parentItem = parentVe.displayItem;
      if (isPage(parentItem)) {
        const arrangeAlgorithm = asPageItem(parentItem).arrangeAlgorithm;
        if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
          const itemVeid = VeFns.veidFromPath(path);
          const childId = itemVeid.linkIdMaybe ? itemVeid.linkIdMaybe : itemVeid.itemId;
          const pageChildren = asContainerItem(parentItem).computed_children;
          let idx = pageChildren.indexOf(childId);
          if (direction == FindDirection.Left) {
            if (idx <= 0) { return; }
            idx = idx - 1;
          }
          if (direction == FindDirection.Right) {
            if (idx >= pageChildren.length - 1) { return; }
            idx = idx + 1;
          }
          const newChildId = pageChildren[idx];
          let newChildVeid = VeFns.veidFromId(newChildId);
          const newPath = VeFns.addVeidToPath(newChildVeid, parentPath);
          store.history.replacePopup({
            vePath: newPath,
            actualVeid: newChildVeid,
          });
          arrangeNow(store, "key-arrow-replace-grid-popup");
        }
      }
    }
  }
}

function handleVirtualizedTableVerticalNavigationMaybe(
  store: StoreContextModel,
  focusPath: string,
  focusVe: VisualElement,
  direction: FindDirection
): boolean {
  if (direction != FindDirection.Up && direction != FindDirection.Down) { return false; }
  if (!(focusVe.flags & VisualElementFlags.InsideTable)) { return false; }
  if (focusVe.row == null) { return false; }

  const isAttachment = !!(focusVe.flags & VisualElementFlags.Attachment);
  const rowPath = isAttachment ? focusVe.parentPath : focusPath;
  if (!rowPath) { return false; }

  const rowVe = isAttachment ? VesCache.current.readNode(rowPath) : focusVe;
  if (!rowVe) { return false; }

  const tablePath = rowVe.parentPath;
  if (!tablePath) { return false; }

  const tableVe = VesCache.current.readNode(tablePath);
  if (!tableVe || !isTable(tableVe.displayItem) || !tableVe.blockSizePx) { return false; }

  const tableVeid = VeFns.veidFromVe(tableVe);
  const tableItem = asTableItem(tableVe.displayItem);
  const delta = direction == FindDirection.Up ? -1 : 1;

  let targetPath: string | null = null;
  let targetRow = focusVe.row;

  if (!isAttachment) {
    targetRow = focusVe.row + delta;
    if (targetRow < 0 || targetRow >= tableItem.computed_children.length) { return false; }

    const childItem = itemState.get(tableItem.computed_children[targetRow]);
    if (!childItem) { return false; }
    const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, childItem);
    targetPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), tablePath);
  } else {
    if (focusVe.col == null || focusVe.col < 1) { return false; }
    const attachmentColPos = focusVe.col - 1;

    for (let rowIdx = focusVe.row + delta; rowIdx >= 0 && rowIdx < tableItem.computed_children.length; rowIdx += delta) {
      const childItem = itemState.get(tableItem.computed_children[rowIdx]);
      if (!childItem || !isAttachmentsItem(childItem)) { continue; }

      const attachments = asAttachmentsItem(childItem).computed_attachments;
      if (attachmentColPos >= attachments.length) { continue; }

      const { displayItem: rowDisplayItem, linkItemMaybe: rowLinkItemMaybe } = getVePropertiesForItem(store, childItem);
      const rowTargetPath = VeFns.addVeidToPath(VeFns.veidFromItems(rowDisplayItem, rowLinkItemMaybe), tablePath);

      const attachmentItem = itemState.get(attachments[attachmentColPos]);
      if (!attachmentItem) { continue; }

      const { displayItem, linkItemMaybe } = getVePropertiesForItem(store, attachmentItem);
      targetPath = VeFns.addVeidToPath(VeFns.veidFromItems(displayItem, linkItemMaybe), rowTargetPath);
      targetRow = rowIdx;
      break;
    }
  }

  if (!targetPath) { return false; }

  const scrollYPos = store.perItem.getTableScrollYPos(tableVeid);
  const headerRowsBl = TABLE_TITLE_HEADER_HEIGHT_BL;
  const colHeaderRowsBl = (tableItem.flags & TableFlags.ShowColHeader) ? TABLE_COL_HEADER_HEIGHT_BL : 0;
  const numVisibleRows = Math.max(1, Math.floor(tableVe.boundsPx.h / tableVe.blockSizePx.h - headerRowsBl - colHeaderRowsBl));
  const firstVisibleRow = Math.floor(scrollYPos);
  const lastVisibleRow = firstVisibleRow + numVisibleRows - 1;

  let nextScrollYPos = scrollYPos;
  if (targetRow < firstVisibleRow) {
    nextScrollYPos = targetRow;
  } else if (targetRow > lastVisibleRow) {
    nextScrollYPos = targetRow - (numVisibleRows - 1);
  }

  const maxFirstVisibleRow = Math.max(0, tableItem.computed_children.length - numVisibleRows);
  nextScrollYPos = Math.max(0, Math.min(nextScrollYPos, maxFirstVisibleRow));

  if (nextScrollYPos !== scrollYPos) {
    store.perItem.setTableScrollYPos(tableVeid, nextScrollYPos);
    arrangeNow(store, "key-arrow-scroll-table-before-focus");
  }

  store.history.setFocus(targetPath);
  arrangeNow(store, "key-arrow-focus-table-virtual-row");
  return true;
}


function handleArrowKeyCalendarPageMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (store.history.currentPopupSpec()) { return false; }

  const focusItem = store.history.getFocusItem();
  if (!isPage(focusItem) || asPageItem(focusItem).arrangeAlgorithm != ArrangeAlgorithm.Calendar) {
    return false;
  }

  if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
    return true;
  }

  const focusPath = store.history.getFocusPath();
  const currentYear = store.perVe.getCalendarYear(focusPath);

  if (ev.code == "ArrowLeft") {
    store.perVe.setCalendarYear(focusPath, currentYear - 1);
    arrangeNow(store, "key-calendar-prev-year");
    return true;
  }

  if (ev.code == "ArrowRight") {
    store.perVe.setCalendarYear(focusPath, currentYear + 1);
    arrangeNow(store, "key-calendar-next-year");
    return true;
  }

  return false;
}


/**
 * If arrow keydown event is relevant for a focussed list page, handle it and return true, else return false.
 */
function handleArrowKeyListPageChangeMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  const focusItem = store.history.getFocusItem();

  // If the focus item is a grid or justified page, don't handle up/down arrows here.
  // Let the grid/justified scroll handler process them instead.
  if (isPage(focusItem)) {
    const focusArrangeAlgorithm = asPageItem(focusItem).arrangeAlgorithm;
    if ((focusArrangeAlgorithm == ArrangeAlgorithm.Grid || focusArrangeAlgorithm == ArrangeAlgorithm.Justified) &&
      (ev.code == "ArrowUp" || ev.code == "ArrowDown")) {
      return false;
    }
  }

  let handleListPageChange = isPage(focusItem) && asPageItem(focusItem).arrangeAlgorithm == ArrangeAlgorithm.List;
  const focusPath = store.history.getFocusPath();
  const focusVe = VesCache.current.readNode(focusPath)!;
  const focusVeid = VeFns.veidFromVe(focusVe);
  for (let i = 1; i < store.topTitledPages.get().length; ++i) {
    const ttp = VeFns.veidFromPath(store.topTitledPages.get()[i]);
    if (ttp.itemId == focusVeid.itemId && ttp.linkIdMaybe == focusVeid.linkIdMaybe) {
      handleListPageChange = true;
      break;
    }
  }

  if (!handleListPageChange) { return false; }

  if (ev.code == "ArrowUp" || ev.code == "ArrowDown") {
    const focusPagePath = store.history.getFocusPath();
    const focusPageVe = VesCache.current.readNode(focusPagePath)!;
    const focusPageVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
    const selectedVeid = store.perItem.getSelectedListPageItem(focusPageVeid);
    if (selectedVeid == EMPTY_VEID) {
      PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageVeid);
      arrangeNow(store, "key-list-page-set-default-selection");
      return true;
    }
    const selectedItemPath = VeFns.addVeidToPath(selectedVeid, focusPagePath);
    const direction = findDirectionFromKeyCode(ev.code);
    const closest = findClosest(VesCache.current, selectedItemPath, direction, true);
    if (closest != null) {
      const closestVeid = VeFns.veidFromPath(closest);
      store.perItem.setSelectedListPageItem(focusPageVeid, closestVeid);
      arrangeNow(store, "key-list-page-move-selection");
    } else {
      // At boundary (topmost/bottommost item) - fall through to parent context navigation
      return false;
    }
  } else if (ev.code == "ArrowLeft") {
    const focusPagePath = store.history.getFocusPath();
    const newFocusPagePath = VeFns.parentPath(focusPagePath);
    if (newFocusPagePath == UMBRELLA_PAGE_UID) {
      return true;
    }
    store.history.setFocus(newFocusPagePath);
    arrangeNow(store, "key-list-page-focus-parent");
  } else if (ev.code == "ArrowRight") {
    const focusPagePath = store.history.getFocusPath();
    const focusPageVe = VesCache.current.readNode(focusPagePath)!;
    const focusPageVeid = VeFns.veidFromVe(focusPageVe);
    const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
    const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
    if (!isPage(itemState.get(selectedVeid.itemId))) {
      return true;
    }
    const selectedPage = asPageItem(itemState.get(selectedVeid.itemId)!);
    if (selectedPage.arrangeAlgorithm != ArrangeAlgorithm.List) {
      // return;
    }
    const ttpVePaths = store.topTitledPages.get();
    const ttpVeids = [];
    for (let i = 0; i < ttpVePaths.length; ++i) { ttpVeids.push(VeFns.veidFromPath(ttpVePaths[i])); }
    for (let i = 0; i < ttpVeids.length; ++i) {
      const veid = ttpVeids[i];
      if (veid.itemId == focusPageVeid.itemId &&
        veid.linkIdMaybe == focusPageVeid.linkIdMaybe) {
        const nextIdx = i + 1;
        if (nextIdx < ttpVeids.length) {
          const nextFocusVeid = ttpVeids[nextIdx];
          const nextFocusPath = VeFns.addVeidToPath(nextFocusVeid, focusPagePath);
          store.history.setFocus(nextFocusPath);

          {
            const focusPagePath = store.history.getFocusPath();
            const focusPageVe = VesCache.current.readNode(focusPagePath)!;
            const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
            const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
            if (selectedVeid == EMPTY_VEID) {
              PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
            }
          }

          arrangeNow(store, "key-list-page-focus-child-page");
        }
      }
    }
  }

  return true;
}

/**
 * If arrow keydown event is for scrolling a focussed grid or justified page, handle it and return true, else return false.
 * This works both when the grid/justified page is the root page, and when it's nested as a selected item within a list page.
 */
function handleArrowKeyGridOrJustifiedPageScrollMaybe(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (store.history.currentPopupSpec()) { return false; }
  if (ev.code != "ArrowUp" && ev.code != "ArrowDown") { return false; }

  const focusItem = store.history.getFocusItem();
  if (isPage(focusItem)) {
    const arrangeAlgorithm = asPageItem(focusItem).arrangeAlgorithm;
    if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
      const focusVe = VesCache.current.readNode(store.history.getFocusPath());
      if (focusVe && scrollGridOrJustifiedPageVe(store, focusVe, ev.code)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * If arrow keydown event is for scrolling a grid/justified page popup, handle it and return true.
 * Handles two cases:
 * 1. The popup item itself is a grid/justified page that needs scrolling
 * 2. The popup item is a child of a grid/justified page that needs scrolling
 * Returns false if scrolling was not handled (not a grid/justified page, or at max scroll bounds).
 */
function handlePopupGridOrJustifiedPageScrollMaybe(store: StoreContextModel, popupPath: string, ev: KeyboardEvent): boolean {
  if (ev.code != "ArrowUp" && ev.code != "ArrowDown") { return false; }

  // First, check if the popup item itself is a grid/justified page
  const popupVe = VesCache.current.readNode(popupPath);
  if (popupVe) {
    const popupItem = popupVe.displayItem;
    if (isPage(popupItem)) {
      const arrangeAlgorithm = asPageItem(popupItem).arrangeAlgorithm;
      if (arrangeAlgorithm == ArrangeAlgorithm.Grid || arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        if (scrollGridOrJustifiedPageVe(store, popupVe, ev.code)) {
          return true;
        }
        // If scrolling returned false (at max bounds), continue to fall through to page switching
        return false;
      }
    }
  }

  // Otherwise, check if the popup's parent is a grid/justified page
  const parentPath = VeFns.parentPath(popupPath);
  if (!parentPath) { return false; }

  const parentVe = VesCache.current.readNode(parentPath);
  if (!parentVe) { return false; }

  const parentItem = parentVe.displayItem;
  if (!isPage(parentItem)) { return false; }

  const arrangeAlgorithm = asPageItem(parentItem).arrangeAlgorithm;
  if (arrangeAlgorithm != ArrangeAlgorithm.Grid && arrangeAlgorithm != ArrangeAlgorithm.Justified) {
    return false;
  }

  return scrollGridOrJustifiedPageVe(store, parentVe, ev.code);
}

/**
 * Helper function to scroll a grid or justified page given its visual element.
 * Returns true if scrolling was performed, false if already at max scroll or no scrolling needed.
 * When false is returned, arrow keys can fall through to page switching functionality.
 */
function scrollGridOrJustifiedPageVe(store: StoreContextModel, pageVe: VisualElement, keyCode: string): boolean {
  if (!pageVe.childAreaBoundsPx || !pageVe.viewportBoundsPx) { return false; }

  const contentHeight = pageVe.childAreaBoundsPx.h;
  const viewportHeight = pageVe.viewportBoundsPx.h;

  // If content fits within viewport, no scrolling needed - allow fall through to page switching
  if (contentHeight <= viewportHeight) { return false; }

  // Use the correct veid that matches how the rendering code reads scroll.
  // When the page is a selected item in a list page (ListPageRoot flag), the rendering
  // code uses getSelectedListPageItem to get the original item's veid.
  let pageVeid = VeFns.veidFromVe(pageVe);
  if (pageVe.flags & VisualElementFlags.ListPageRoot) {
    const parentVeid = VesCache.current.readNode(pageVe.parentPath!)
      ? VeFns.actualVeidFromPath(pageVe.parentPath!)
      : VeFns.veidFromPath(pageVe.parentPath!);
    pageVeid = store.perItem.getSelectedListPageItem(parentVeid);
  }

  const currentScrollProp = store.perItem.getPageScrollYProp(pageVeid);

  // If already at max scroll in the direction of the key, allow fall through to page switching
  if (keyCode == "ArrowUp" && currentScrollProp <= 0) { return false; }
  if (keyCode == "ArrowDown" && currentScrollProp >= 1) { return false; }

  const scrollableDistance = contentHeight - viewportHeight;
  const scrollStep = (viewportHeight * 0.2) / scrollableDistance;

  const newScrollProp = keyCode == "ArrowUp"
    ? Math.max(0, currentScrollProp - scrollStep)
    : Math.min(1, currentScrollProp + scrollStep);

  store.perItem.setPageScrollYProp(pageVeid, newScrollProp);
  arrangeNow(store, "key-scroll-grid-or-justified-page");

  return true;
}

/**
 * Handle up/down navigation between attachments in different table rows.
 */
function handleTableAttachmentPopupNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  if (direction != FindDirection.Up && direction != FindDirection.Down) { return false; }

  const currentVe = VesCache.current.readNode(currentPath);
  if (!currentVe) { return false; }
  if (!(currentVe.flags & VisualElementFlags.InsideTable) || !(currentVe.flags & VisualElementFlags.Attachment)) {
    return false;
  }

  if (currentVe.col == null || currentVe.row == null || currentVe.parentPath == null) {
    return false;
  }

  const columnIndex = currentVe.col;
  const currentRow = currentVe.row;

  const rowVe = VesCache.current.readNode(currentVe.parentPath);
  if (!rowVe) { return false; }
  if (!rowVe.parentPath) { return false; }

  const tableVe = VesCache.current.readNode(rowVe.parentPath);
  if (!tableVe) { return false; }

  const childRows = VesCache.current.readIndexedChildren(VeFns.veToPath(tableVe));

  let targetPath: string | null = null;
  let targetRow: number | null = null;

  for (const childVe of childRows) {
    const atts = VesCache.current.readAttachments(VeFns.veToPath(childVe));
    if (childVe.row == null || !atts) { continue; }

    const childRow = childVe.row;
    let rowIsCandidate = false;

    if (direction == FindDirection.Up) {
      rowIsCandidate = childRow < currentRow && (targetRow == null || childRow > targetRow);
    } else {
      rowIsCandidate = childRow > currentRow && (targetRow == null || childRow < targetRow);
    }

    if (!rowIsCandidate) { continue; }

    const attachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(childVe));
    for (const attachmentVe of attachmentsVes) {
      if (!(attachmentVe.flags & VisualElementFlags.Attachment)) { continue; }
      if (attachmentVe.col != columnIndex) { continue; }

      targetPath = VeFns.veToPath(attachmentVe);
      targetRow = childRow;
      break;
    }
  }

  if (!targetPath) { return false; }

  const targetVeid = VeFns.veidFromPath(targetPath);
  store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
  arrangeNow(store, "key-table-attachment-popup-nav");
  return true;
}

/**
 * Handle left/right navigation between table children and their attachments.
 * - On a table child (col=0), Right navigates to first attachment
 * - On an attachment (col>0), Left navigates to previous column (attachment or table child)
 * - On an attachment (col>0), Right navigates to next attachment if available
 */
function handleTableItemPopupHorizontalNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  if (direction != FindDirection.Left && direction != FindDirection.Right) { return false; }

  const currentVe = VesCache.current.readNode(currentPath);
  if (!currentVe) { return false; }

  // Check if we're inside a table
  if (!(currentVe.flags & VisualElementFlags.InsideTable)) {
    return false;
  }

  const isAttachment = !!(currentVe.flags & VisualElementFlags.Attachment);
  const currentCol = currentVe.col;

  if (currentCol == null) { return false; }

  // Case 1: On a table child (col=0), pressing Right -> go to first attachment
  if (!isAttachment && currentCol === 0 && direction === FindDirection.Right) {
    // currentVe is the table child, check its attachments
    // currentVe is the table child, check its attachments
    const currentAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(currentVe));
    if (!currentAttachmentsVes || currentAttachmentsVes.length === 0) {
      return false;
    }

    // Find the first attachment (col=1)
    // Find the first attachment (col=1)
    for (const attachmentVe of currentAttachmentsVes) {
        if (attachmentVe.col === 1) {
          const targetPath = VeFns.veToPath(attachmentVe);
          const targetVeid = VeFns.veidFromPath(targetPath);
          store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
          arrangeNow(store, "key-table-popup-right-to-first-attachment");
          return true;
        }
      }
    return false;
  }

  // Case 2: On an attachment, navigating left or right
  if (isAttachment && currentVe.parentPath) {
    const rowVe = VesCache.current.readNode(currentVe.parentPath);
    if (!rowVe) { return false; }

    if (direction === FindDirection.Left) {
      // Navigate to previous column
      if (currentCol === 1) {
        // Go back to the table child (the parent row)
        const targetPath = VeFns.veToPath(rowVe);
        const targetVeid = VeFns.veidFromPath(targetPath);
        store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
        arrangeNow(store, "key-table-popup-left-to-row");
        return true;
      } else if (currentCol > 1) {
        // Go to previous attachment
        // Go to previous attachment
        const rowAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(rowVe));
        for (const attachmentVe of rowAttachmentsVes) {
          if (attachmentVe.col === currentCol - 1) {
            const targetPath = VeFns.veToPath(attachmentVe);
            const targetVeid = VeFns.veidFromPath(targetPath);
            store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
            arrangeNow(store, "key-table-popup-left-to-attachment");
            return true;
          }
        }
      }
    } else if (direction === FindDirection.Right) {
      // Navigate to next attachment
      // Navigate to next attachment
      const rowAttachmentsVes = VesCache.current.readAttachments(VeFns.veToPath(rowVe));
      for (const attachmentVe of rowAttachmentsVes) {
        if (attachmentVe.col === currentCol + 1) {
          const targetPath = VeFns.veToPath(attachmentVe);
          const targetVeid = VeFns.veidFromPath(targetPath);
          store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
          arrangeNow(store, "key-table-popup-right-to-attachment");
          return true;
        }
      }
    }
  }

  return false;
}
