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

import { GRID_SIZE } from "../constants";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { PageFlags } from "../items/base/flags-item";
import { isImage } from "../items/image-item";
import { asTableItem, isTable } from "../items/table-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { fullArrange } from "../layout/arrange";
import { findClosest, FindDirection, findDirectionFromKeyCode } from "../layout/find";
import { switchToPage } from "../layout/navigation";
import { EMPTY_VEID, VeFns, VisualElement, VisualElementFlags } from "../layout/visual-element";


import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { CursorEventState } from "./state";
import { newItemInContext } from "./create";
import { isLink } from "../items/link-item";
import { VesCache } from "../layout/ves-cache";
import { serverOrRemote } from "../server";
import { ItemType } from "../items/base/item";
import { HitInfoFns } from "./hit";
import { UMBRELLA_PAGE_UID } from "../util/uid";
import { asContainerItem } from "../items/base/container-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { HitboxFlags } from "../layout/hitbox";
import { setCaretPosition } from "../util/caret";


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


/**
 * Top level handler for keydown events.
 */
export function keyDownHandler(store: StoreContextModel, ev: KeyboardEvent): void {

  // IMPORTANT: keep these in sync with the code below.

  const recognizedKeys = [
    "Slash", "Backslash", "Escape", "Enter",
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
      fullArrange(store);
      serverOrRemote.updateItem(focusItem, store.general.networkStatus);
      ev.preventDefault();
    }
    return;
  }

  if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
    // Allow Escape key to exit text editing mode
    if (ev.code != "Escape") {
      // TODO (HIGH)
      // event is fired before content is updated.
      return;
    }
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
      fullArrange(store);
      return;
    }
    if (store.history.currentPopupSpec()) {
      store.history.popPopup();
      const topRootVes = VesCache.getChildrenVes(VeFns.veToPath(store.umbrellaVisualElement.get()))()[0];
      VesCache.clearPopupVes(VeFns.veToPath(topRootVes.get()));
      topRootVes.set(topRootVes.get());
      fullArrange(store);
      return;
    }

    // If a page is focused (not popped up), move focus to parent container
    const focusPath = store.history.getFocusPath();
    const focusVes = VesCache.get(focusPath);
    if (focusVes && isPage(focusVes.get().displayItem)) {
      const parentPath = VeFns.parentPath(focusPath);
      if (parentPath && parentPath !== UMBRELLA_PAGE_UID && parentPath !== "") {
        store.history.setFocus(parentPath);
        fullArrange(store);
      }
    }
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
      fullArrange(store);
      return;
    }

    // If a non-page item has focus and we're not already editing, make it editable
    const focusPath = store.history.getFocusPath();
    const focusVes = VesCache.get(focusPath);
    if (focusVes && !isPage(focusVes.get().displayItem) && !store.overlay.textEditInfo()) {
      ev.preventDefault();
      ItemFns.handleClick(focusVes, null, HitboxFlags.None, store, true); // caretAtEnd=true
      return;
    }

    // If an embedded interactive page has focus (and title is not being edited), start title editing
    if (focusVes && isPage(focusVes.get().displayItem) && !store.overlay.textEditInfo()) {
      const pageItem = asPageItem(focusVes.get().displayItem);
      if (pageItem.flags & PageFlags.EmbeddedInteractive) {
        ev.preventDefault();
        PageFns.handleEditTitleClick(focusVes.get(), store);
        return;
      }
    }

    // If an opaque/translucent page has focus (no popup showing), open the popup
    // But for root pages, make the toolbar title editable instead
    if (focusVes && isPage(focusVes.get().displayItem) && !store.history.currentPopupSpec()) {
      const pageItem = asPageItem(focusVes.get().displayItem);
      if (!(pageItem.flags & PageFlags.EmbeddedInteractive)) {
        ev.preventDefault();
        // Check if this is a root page (in topTitledPages)
        const topPages = store.topTitledPages.get();
        const focusPageIdx = topPages.indexOf(focusPath);
        if (focusPageIdx >= 0) {
          // Root page: focus the toolbar title div to make it editable
          const toolbarTitleDiv = document.getElementById(`toolbarTitleDiv-${focusPageIdx}`);
          if (toolbarTitleDiv) {
            toolbarTitleDiv.focus();
            // Set cursor at end of text
            const textLength = toolbarTitleDiv.innerText.length;
            setCaretPosition(toolbarTitleDiv, textLength);
          }
        } else {
          // Non-root page: open popup
          PageFns.handleOpenPopupClick(focusVes.get(), store, false);
        }
        return;
      }
    }

    const spec = store.history.currentPopupSpec();
    if (spec && itemState.get(spec.actualVeid.itemId)!.itemType == ItemType.Page) {
      switchToPage(store, store.history.currentPopupSpec()!.actualVeid, true, false, false);
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
    newItemInContext(store, "expression", hitInfo, CursorEventState.getLatestDesktopPx(store));
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


/**
 * Handler for arrow key down events.
 */
function arrowKeyHandler(store: StoreContextModel, ev: KeyboardEvent): void {
  ev.preventDefault(); // TODO (MEDIUM): allow default in some circumstances where it is appropriate for a table to scroll.

  if (handleArrowKeyCalendarPageMaybe(store, ev)) { return; }
  if (handleArrowKeyListPageChangeMaybe(store, ev)) { return; }
  if (handleArrowKeyGridOrJustifiedPageScrollMaybe(store, ev)) { return; }

  // Handle arrow keys when an item (including pages) has focus but no popup
  // This enables navigation from a focused (non-editable) item
  if (!store.history.currentPopupSpec()) {
    const focusPath = store.history.getFocusPath();
    const focusVes = VesCache.get(focusPath);
    if (focusVes) {
      // Navigate to closest item from current focus
      const direction = findDirectionFromKeyCode(ev.code);
      const closest = findClosest(focusPath, direction, true, false);
      if (closest != null) {
        // Just set focus to the new item - don't pop up pages
        store.history.setFocus(closest);
        fullArrange(store);
        return;
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
  const closest = findClosest(path, direction, true, false)!;
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
      if (!isPageOrImage) {
        // Calculate sourcePositionGr from VE's center for attachments
        const closestVes = VesCache.get(closest);
        if (closestVes) {
          const ve = closestVes.get();
          const veBoundsPx = VeFns.veBoundsRelativeToDesktopPx(store, ve);
          const centerPx = {
            x: veBoundsPx.x + veBoundsPx.w / 2,
            y: veBoundsPx.y + veBoundsPx.h / 2,
          };

          // Find the parent page to convert to Gr coordinates
          const parentPath = VeFns.parentPath(closest);
          if (parentPath) {
            let pageVe = VesCache.get(parentPath)?.get();
            while (pageVe && !isPage(pageVe.displayItem)) {
              if (!pageVe.parentPath) break;
              pageVe = VesCache.get(pageVe.parentPath)?.get();
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

      store.history.replacePopup({
        vePath: closest,
        actualVeid: closestVeid,
        isFromAttachment: isActualAttachment ? true : undefined,
        sourcePositionGr,
      });
      fullArrange(store);
    } else {
      // Non-attachment child items: just set focus, pop the popup
      store.history.popPopup();
      store.history.setFocus(closest);
      fullArrange(store);
    }
  } else {
    // for grid and justified pages, use ordering to wrap around to next or prev line.
    if (direction == FindDirection.Left || direction == FindDirection.Right) {
      const parentPath = VeFns.parentPath(path);
      const parentVes = VesCache.get(parentPath)!;
      const parentItem = parentVes.get().displayItem;
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
          fullArrange(store);
        }
      }
    }
  }
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
    fullArrange(store);
    return true;
  }

  if (ev.code == "ArrowRight") {
    store.perVe.setCalendarYear(focusPath, currentYear + 1);
    fullArrange(store);
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
  const focusVe = VesCache.get(focusPath)!.get();
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
    const focusPageVe = VesCache.get(focusPagePath)!.get();
    const focusPageVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
    const selectedVeid = store.perItem.getSelectedListPageItem(focusPageVeid);
    if (selectedVeid == EMPTY_VEID) {
      PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageVeid);
      fullArrange(store);
      return true;
    }
    const selectedItemPath = VeFns.addVeidToPath(selectedVeid, focusPagePath);
    const direction = findDirectionFromKeyCode(ev.code);
    const closest = findClosest(selectedItemPath, direction, true, false);
    if (closest != null) {
      const closestVeid = VeFns.veidFromPath(closest);
      store.perItem.setSelectedListPageItem(focusPageVeid, closestVeid);
      fullArrange(store);
    }
  } else if (ev.code == "ArrowLeft") {
    const focusPagePath = store.history.getFocusPath();
    const newFocusPagePath = VeFns.parentPath(focusPagePath);
    if (newFocusPagePath == UMBRELLA_PAGE_UID) {
      return true;
    }
    store.history.setFocus(newFocusPagePath);
    fullArrange(store);
  } else if (ev.code == "ArrowRight") {
    const focusPagePath = store.history.getFocusPath();
    const focusPageVe = VesCache.get(focusPagePath)!.get();
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
            const focusPageVe = VesCache.get(focusPagePath)!.get();
            const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
            const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
            if (selectedVeid == EMPTY_VEID) {
              PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
            }
          }

          fullArrange(store);
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
      const focusVes = VesCache.get(store.history.getFocusPath());
      if (focusVes && scrollGridOrJustifiedPageVe(store, focusVes.get(), ev.code)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Helper function to scroll a grid or justified page given its visual element.
 * Returns true if scrolling was performed (or content fits viewport), false otherwise.
 */
function scrollGridOrJustifiedPageVe(store: StoreContextModel, pageVe: VisualElement, keyCode: string): boolean {
  if (!pageVe.childAreaBoundsPx || !pageVe.viewportBoundsPx) { return false; }

  const contentHeight = pageVe.childAreaBoundsPx.h;
  const viewportHeight = pageVe.viewportBoundsPx.h;

  // If content fits within viewport, no scrolling needed but we handled the event
  if (contentHeight <= viewportHeight) { return true; }

  // Use the correct veid that matches how the rendering code reads scroll.
  // When the page is a selected item in a list page (ListPageRoot flag), the rendering
  // code uses getSelectedListPageItem to get the original item's veid.
  let pageVeid = VeFns.veidFromVe(pageVe);
  if (pageVe.flags & VisualElementFlags.ListPageRoot) {
    const parentVeid = VesCache.get(pageVe.parentPath!)
      ? VeFns.actualVeidFromPath(pageVe.parentPath!)
      : VeFns.veidFromPath(pageVe.parentPath!);
    pageVeid = store.perItem.getSelectedListPageItem(parentVeid);
  }

  const currentScrollProp = store.perItem.getPageScrollYProp(pageVeid);
  const scrollableDistance = contentHeight - viewportHeight;
  const scrollStep = (viewportHeight * 0.2) / scrollableDistance;

  const newScrollProp = keyCode == "ArrowUp"
    ? Math.max(0, currentScrollProp - scrollStep)
    : Math.min(1, currentScrollProp + scrollStep);

  store.perItem.setPageScrollYProp(pageVeid, newScrollProp);
  fullArrange(store);

  return true;
}

/**
 * Handle up/down navigation between attachments in different table rows.
 */
function handleTableAttachmentPopupNavigation(store: StoreContextModel, currentPath: string, direction: FindDirection): boolean {
  if (direction != FindDirection.Up && direction != FindDirection.Down) { return false; }

  const currentVes = VesCache.get(currentPath);
  if (!currentVes) { return false; }

  const currentVe = currentVes.get();
  if (!(currentVe.flags & VisualElementFlags.InsideTable) || !(currentVe.flags & VisualElementFlags.Attachment)) {
    return false;
  }

  if (currentVe.col == null || currentVe.row == null || currentVe.parentPath == null) {
    return false;
  }

  const columnIndex = currentVe.col;
  const currentRow = currentVe.row;

  const rowVes = VesCache.get(currentVe.parentPath);
  if (!rowVes) { return false; }
  const rowVe = rowVes.get();
  if (!rowVe.parentPath) { return false; }

  const tableVes = VesCache.get(rowVe.parentPath);
  if (!tableVes) { return false; }
  const tableVe = tableVes.get();

  const childRows = VesCache.getChildrenVes(VeFns.veToPath(tableVe))() ?? [];

  let targetPath: string | null = null;
  let targetRow: number | null = null;

  for (const childSignal of childRows) {
    const childVe = childSignal.get();
    const atts = VesCache.getAttachmentsVes(VeFns.veToPath(childVe))();
    if (childVe.row == null || !atts) { continue; }

    const childRow = childVe.row;
    let rowIsCandidate = false;

    if (direction == FindDirection.Up) {
      rowIsCandidate = childRow < currentRow && (targetRow == null || childRow > targetRow);
    } else {
      rowIsCandidate = childRow > currentRow && (targetRow == null || childRow < targetRow);
    }

    if (!rowIsCandidate) { continue; }

    const attachmentsVes = VesCache.getAttachmentsVes(VeFns.veToPath(childVe))();
    for (const attachmentSignal of attachmentsVes) {
      const attachmentVe = attachmentSignal.get();
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
  fullArrange(store);
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

  const currentVes = VesCache.get(currentPath);
  if (!currentVes) { return false; }

  const currentVe = currentVes.get();

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
    const currentAttachmentsVes = VesCache.getAttachmentsVes(VeFns.veToPath(currentVe))();
    if (!currentAttachmentsVes || currentAttachmentsVes.length === 0) {
      return false;
    }

    // Find the first attachment (col=1)
    // Find the first attachment (col=1)
    for (const attachmentSignal of currentAttachmentsVes) {
      const attachmentVe = attachmentSignal.get();
      if (attachmentVe.col === 1) {
        const targetPath = VeFns.veToPath(attachmentVe);
        const targetVeid = VeFns.veidFromPath(targetPath);
        store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
        fullArrange(store);
        return true;
      }
    }
    return false;
  }

  // Case 2: On an attachment, navigating left or right
  if (isAttachment && currentVe.parentPath) {
    const rowVes = VesCache.get(currentVe.parentPath);
    if (!rowVes) { return false; }
    const rowVe = rowVes.get();

    if (direction === FindDirection.Left) {
      // Navigate to previous column
      if (currentCol === 1) {
        // Go back to the table child (the parent row)
        const targetPath = VeFns.veToPath(rowVe);
        const targetVeid = VeFns.veidFromPath(targetPath);
        store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
        fullArrange(store);
        return true;
      } else if (currentCol > 1) {
        // Go to previous attachment
        // Go to previous attachment
        const rowAttachmentsVes = VesCache.getAttachmentsVes(VeFns.veToPath(rowVe))();
        for (const attachmentSignal of rowAttachmentsVes) {
          const attachmentVe = attachmentSignal.get();
          if (attachmentVe.col === currentCol - 1) {
            const targetPath = VeFns.veToPath(attachmentVe);
            const targetVeid = VeFns.veidFromPath(targetPath);
            store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
            fullArrange(store);
            return true;
          }
        }
      }
    } else if (direction === FindDirection.Right) {
      // Navigate to next attachment
      // Navigate to next attachment
      const rowAttachmentsVes = VesCache.getAttachmentsVes(VeFns.veToPath(rowVe))();
      for (const attachmentSignal of rowAttachmentsVes) {
        const attachmentVe = attachmentSignal.get();
        if (attachmentVe.col === currentCol + 1) {
          const targetPath = VeFns.veToPath(attachmentVe);
          const targetVeid = VeFns.veidFromPath(targetPath);
          store.history.replacePopup({ vePath: targetPath, actualVeid: targetVeid });
          fullArrange(store);
          return true;
        }
      }
    }
  }

  return false;
}
