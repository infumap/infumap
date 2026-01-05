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

import { AttachmentsItem, asAttachmentsItem } from "../items/base/attachments-item";
import { Item, ItemType } from "../items/base/item";
import { CompositeItem, asCompositeItem, isComposite } from "../items/composite-item";
import { asTableItem, isTable, TableFns } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { navigateBack, navigateUp } from "../layout/navigation";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VisualElementFlags, VeFns, veFlagIsRoot } from "../layout/visual-element";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { BoundingBox, boundingBoxFromDOMRect, isInside } from "../util/geometry";
import { UMBRELLA_PAGE_UID } from "../util/uid";
import { HitInfoFns } from "./hit";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { DoubleClickState, CursorEventState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState } from "./state";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { GRID_SIZE } from "../constants";
import { toolbarPopupBoxBoundsPx } from "../components/toolbar/Toolbar_Popup";
import { serverOrRemote } from "../server";
import { isUrl, trimNewline } from "../util/string";
import { isRating } from "../items/rating-item";
import { isLink } from "../items/link-item";
import { MouseEventActionFlags } from "./enums";
import { asNoteItem, isNote, NoteFns } from "../items/note-item";
import { asFileItem, FileFns, isFile } from "../items/file-item";
import { getCaretPosition, setCaretPosition } from "../util/caret";
import { isFlipCard } from "../items/flipcard-item";
import { asPasswordItem } from "../items/password-item";
import { ImageFns, isImage } from "../items/image-item";


export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;


export async function mouseDownHandler(store: StoreContextModel, buttonNumber: number): Promise<MouseEventActionFlags> {
  let defaultResult = MouseEventActionFlags.PreventDefault;

  if (store.history.currentPageVeid() == null) { return defaultResult; }

  // Popups associated with the toolbar.
  if (store.overlay.toolbarPopupInfoMaybe.get() != null) {
    if (isInside(CursorEventState.getLatestClientPx(), toolbarPopupBoxBoundsPx(store))) {
      // if mouse down is inside popup bounds, this is not handled by the global handler.
      return MouseEventActionFlags.None;
    }
    if (ClickState.getButtonClickBoundsPx()! != null &&
      isInside(CursorEventState.getLatestClientPx(), ClickState.getButtonClickBoundsPx()!) &&
      buttonNumber == MOUSE_LEFT) {
      // if mouse down is inside button of opened popup, this is handled in the relevant button click handler.
      ClickState.setButtonClickBoundsPx(null);
      return MouseEventActionFlags.None;
    }
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    fullArrange(store);
    serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }


  // Page Title Edit
  const toolbarTitleDivs = (() => {
    let result = [];
    const TOO_MANY_TITLE_DIVS = 100;
    for (let i = 0; i < TOO_MANY_TITLE_DIVS; ++i) {
      const toolbarTitleDiv = document.getElementById(`toolbarTitleDiv-${i}`)!;
      if (!toolbarTitleDiv) { break; }
      result.push(toolbarTitleDiv);
    }
    return result;
  })();
  const saveActiveTitleDivState = () => {
    const titleText = (document.activeElement! as HTMLElement).innerText;
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
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
  }
  for (let i = 0; i < toolbarTitleDivs.length; ++i) {
    const toolbarTitleDiv = toolbarTitleDivs[i];
    const titleBounds = boundingBoxFromDOMRect(toolbarTitleDiv.getBoundingClientRect())!;
    if (isInside(CursorEventState.getLatestClientPx(), titleBounds)) {
      if (document.activeElement!.id.includes("toolbarTitleDiv")) {
        if (document.activeElement!.id == `toolbarTitleDiv-${i}`) {
          return MouseEventActionFlags.None;
        }
        saveActiveTitleDivState();
      }
      let ttpPath = store.topTitledPages.get()[i];
      setTimeout(() => {
        const caretPosition = getCaretPosition(toolbarTitleDiv);
        store.history.setFocus(ttpPath);
        fullArrange(store);
        const newToolbarTitleDiv = document.getElementById(`toolbarTitleDiv-${i}`)!;
        setCaretPosition(newToolbarTitleDiv, caretPosition);
      }, 0);
      return MouseEventActionFlags.None;
    }
  }
  // If here, click was NOT inside a toolbar title div. If one is active, update the page item.
  if (document.activeElement!.id.includes("toolbarTitleDiv")) {
    saveActiveTitleDivState();
    fullArrange(store);
    defaultResult = MouseEventActionFlags.None;
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }


  // Editing text using a content editable div (variety of item types).
  if (store.overlay.textEditInfo()) {
    if (isInsideItemOptionsToolbarArea()) { return MouseEventActionFlags.PreventDefault; }

    if (store.user.getUserMaybe() == null || store.history.getFocusItem().ownerId != store.user.getUser().userId) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      store.overlay.setTextEditInfo(store.history, null);
      fullArrange(store);
      if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
      defaultResult = MouseEventActionFlags.None;
    }

    else {
      const editingItemPath = store.overlay.textEditInfo()!.itemPath;
      const editingDomId = store.overlay.textEditInfo()!.colNum != null
        ? editingItemPath + ":col" + store.overlay.textEditInfo()!.colNum
        : editingItemPath + ":title";
      const editingDomEl = document.getElementById(editingDomId);
      if (editingDomEl && isInside(CursorEventState.getLatestClientPx(), boundingBoxFromDOMRect(editingDomEl.getBoundingClientRect())!) &&
        buttonNumber == MOUSE_LEFT) {
        const hitInfo = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);
        if (!(hitInfo.hitboxType & HitboxFlags.Resize)) {
          return MouseEventActionFlags.None;
        }
      }

      if (!editingDomEl) {
        // Element was removed during rearrangement, clear text edit state
        store.overlay.toolbarPopupInfoMaybe.set(null);
        store.overlay.setTextEditInfo(store.history, null);

        // For right-click, keep focus on the item (it will show enhanced shadow via focusPath check)
        if (buttonNumber != MOUSE_LEFT) {
          store.history.setFocus(editingItemPath);
        }

        fullArrange(store);
        if (buttonNumber != MOUSE_LEFT) { return defaultResult; }
        defaultResult = MouseEventActionFlags.None;
      } else {
        const newText = editingDomEl.innerText;
        const item = itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!;

        if (store.overlay.textEditInfo()!.itemType == ItemType.Table) {
          if (store.overlay.textEditInfo()!.colNum == null) {
            asTableItem(item).title = trimNewline(newText);
          } else {
            asTableItem(item).tableColumns[store.overlay.textEditInfo()!.colNum!].name = trimNewline(newText);
          }
        }
        else if (store.overlay.textEditInfo()!.itemType == ItemType.Page) {
          asPageItem(item).title = trimNewline(newText);
        }
        else if (store.overlay.textEditInfo()!.itemType == ItemType.Note) {
          editingDomEl.parentElement!.scrollLeft = 0;
          const noteItem = asNoteItem(item);
          noteItem.title = trimNewline(newText);
          if (isUrl(noteItem.title)) {
            if (noteItem.url == "") {
              noteItem.url = noteItem.title;
            }
          }
        }
        else if (store.overlay.textEditInfo()!.itemType == ItemType.File) {
          editingDomEl.parentElement!.scrollLeft = 0;
          asFileItem(item).title = trimNewline(newText);
        }
        else if (store.overlay.textEditInfo()!.itemType == ItemType.Password) {
          editingDomEl.parentElement!.scrollLeft = 0;
          asPasswordItem(item).text = trimNewline(newText);
        }

        if (item.relationshipToParent == RelationshipToParent.Child) {
          const parentItem = itemState.get(item.parentId);
          if (parentItem && isTable(parentItem) && asTableItem(parentItem).orderChildrenBy != "") {
            itemState.sortChildren(item.parentId);
          }
        }

        serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);

        // When ending text edit via right-click, keep focus on the item but exit edit mode.
        store.overlay.toolbarPopupInfoMaybe.set(null);
        store.overlay.setTextEditInfo(store.history, null);

        // For right-click, keep focus on the item (it will show enhanced shadow via focusPath check)
        if (buttonNumber != MOUSE_LEFT) {
          store.history.setFocus(editingItemPath);
        }

        fullArrange(store);
        if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
        defaultResult = MouseEventActionFlags.None;
      }
    }
  }

  /**
   * whether or not the mouse cursor is inside the item specific part of the toolbar.
   */
  function isInsideItemOptionsToolbarArea(): boolean {
    const toolboxDiv = document.getElementById("toolbarItemOptionsDiv")!;
    if (!toolboxDiv) { return false; }
    const bounds = toolboxDiv.getBoundingClientRect();
    const boundsPx: BoundingBox = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
    return isInside(CursorEventState.getLatestClientPx(), boundsPx);
  }

  if (isLink(store.history.getFocusItem()) ||
    isRating(store.history.getFocusItem())) {
    if (buttonNumber != MOUSE_LEFT || !isInsideItemOptionsToolbarArea()) {
      store.history.setFocus(store.history.currentPagePath()!);
    }
    defaultResult = MouseEventActionFlags.None;
    if (buttonNumber != MOUSE_LEFT) { return defaultResult; } // finished handling in the case of right click.
  }

  if (isInsideItemOptionsToolbarArea()) {
    return MouseEventActionFlags.None;
  }


  // Desktop handlers.

  switch (buttonNumber) {
    case MOUSE_LEFT:
      defaultResult = mouseLeftDownHandler(store, defaultResult);
      return defaultResult;
    case MOUSE_RIGHT:
      await mouseRightDownHandler(store);
      return defaultResult;
    default:
      console.warn("unsupported mouse button: " + buttonNumber);
      return defaultResult;
  }
}


let longHoldTimeoutId: any = null;

export function mouseLeftDownHandler(store: StoreContextModel, defaultResult: MouseEventActionFlags): MouseEventActionFlags {
  const desktopPosPx = CursorEventState.getLatestDesktopPx(store);

  if (store.overlay.contextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    store.overlay.contextMenuInfo.set(null);
    return defaultResult;
  }

  if (store.overlay.tableColumnContextMenuInfo.get() != null) {
    DoubleClickState.preventDoubleClick();
    store.overlay.tableColumnContextMenuInfo.set(null);
    return defaultResult;
  }

  let userSettingsInfo = store.overlay.editUserSettingsInfo.get();
  if (userSettingsInfo != null) {
    DoubleClickState.preventDoubleClick();
    if (isInside(desktopPosPx, userSettingsInfo!.desktopBoundsPx)) {
      UserSettingsMoveState.set({ lastMousePosPx: desktopPosPx });
      return defaultResult;
    }

    store.overlay.editUserSettingsInfo.set(null);
    return defaultResult;
  }

  const hitInfo = HitInfoFns.hit(store, desktopPosPx, [], false);

  const startPosBl = null;
  const startWidthBl = null;
  const startHeightBl = null;
  const startPx = desktopPosPx;
  let hitVe = HitInfoFns.getHitVe(hitInfo);
  // If clicking a child inside a composite and that composite is in the current selection,
  // treat this as hitting the composite to preserve selection during drag (tables unchanged).
  if ((hitVe.flags & VisualElementFlags.InsideCompositeOrDoc) && !isTable(hitVe.displayItem)) {
    const parentVe = VesCache.get(hitVe.parentPath!)!.get();
    if (isComposite(parentVe.displayItem)) {
      const sel = store.overlay.selectedVeids.get();
      if (sel && sel.length > 0) {
        const parentVeid = VeFns.veidFromItems(parentVe.displayItem, parentVe.actualLinkItemMaybe);
        const parentSelected = sel.some(v => v.itemId === parentVeid.itemId && v.linkIdMaybe === parentVeid.linkIdMaybe);
        if (parentSelected) { hitVe = parentVe; }
      }
    }
  }
  const activeItem = VeFns.treeItem(hitVe);
  let boundsOnTopLevelPagePx = VeFns.veBoundsRelativeToDesktopPx(store, hitVe);

  let onePxSizeBl = { x: 0.0, y: 0.0 };
  if (hitVe.flags & VisualElementFlags.Popup) {
    let parent = VesCache.get(hitVe.parentPath!)!.get();
    let parentPage = asPageItem(parent.displayItem);
    if (parentPage.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const containerInnerDimBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
      onePxSizeBl = {
        x: containerInnerDimBl.w / parent.childAreaBoundsPx!.w,
        y: containerInnerDimBl.h / parent.childAreaBoundsPx!.h
      };
    } else {
      const desktopBoundsPx = store.desktopMainAreaBoundsPx();
      onePxSizeBl = {
        x: 1.0 / desktopBoundsPx.w,
        y: 1.0 / desktopBoundsPx.h
      };
    }
  } else {
    if (hitInfo.compositeHitboxTypeMaybe) {
      const compositeVe = HitInfoFns.getCompositeContainerVe(hitInfo)!;
      const parentVe = VesCache.get(compositeVe.parentPath!)!.get();
      if (isPage(parentVe.displayItem)) {
        let parentPage = asPageItem(parentVe.displayItem);
        const containerInnerDimBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
        onePxSizeBl = {
          x: containerInnerDimBl.w / parentVe.childAreaBoundsPx!.w,
          y: containerInnerDimBl.h / parentVe.childAreaBoundsPx!.h
        };
      }
    } else {
      if ((hitInfo.hitboxType & HitboxFlags.HorizontalResize) &&
        isPage(hitVe.displayItem) && asPageItem(hitVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.List) {
        const squareSize = (asPageItem(hitVe.displayItem).tableColumns[0].widthGr / GRID_SIZE) / hitVe.listViewportBoundsPx!.w;
        onePxSizeBl = { x: squareSize, y: squareSize };
      } else {
        let parent = VesCache.get(hitVe.parentPath!)!.get();
        if (isPage(parent.displayItem) && VeFns.treeItem(hitVe).relationshipToParent == RelationshipToParent.Child) {
          let parentPage = asPageItem(parent.displayItem);
          const containerInnerDimBl = PageFns.calcInnerSpatialDimensionsBl(parentPage);
          onePxSizeBl = {
            x: containerInnerDimBl.w / parent.childAreaBoundsPx!.w,
            y: containerInnerDimBl.h / parent.childAreaBoundsPx!.h
          };
        }
      }
    }
  }

  let clickOffsetProp = {
    x: (startPx.x - boundsOnTopLevelPagePx.x) / boundsOnTopLevelPagePx.w,
    y: (startPx.y - boundsOnTopLevelPagePx.y) / boundsOnTopLevelPagePx.h
  };
  const startAttachmentsItem = calcStartTableAttachmentsItemMaybe(activeItem);
  const startCompositeItem = calcStartCompositeItemMaybe(activeItem);

  const canHitEmbeddedInteractive = !!(hitVe.flags & VisualElementFlags.EmbeddedInteractiveRoot);
  const ignoreItems = [hitVe.displayItem.id];
  const hitInfoFiltered = HitInfoFns.hit(store, desktopPosPx, ignoreItems, canHitEmbeddedInteractive);
  const scaleDefiningElement = VeFns.veToPath(hitInfoFiltered.overPositionableVe!);

  const activeElementPath = VeFns.veToPath(hitVe);
  const activeLinkIdMaybe = hitVe.actualLinkItemMaybe ? hitVe.actualLinkItemMaybe.id : (hitVe.linkItemMaybe ? hitVe.linkItemMaybe.id : null);
  const activeLinkedDisplayItemMaybe = activeLinkIdMaybe ? hitVe.displayItem : null;

  if (longHoldTimeoutId) {
    clearTimeout(longHoldTimeoutId);
  }

  const overDisplayItem = hitVe.displayItem;
  longHoldTimeoutId = setTimeout(() => {
    if (MouseActionState.empty()) { return; }
    if (MouseActionState.get().action != MouseAction.Ambiguous) { return; }
    if (isPage(overDisplayItem) && !veFlagIsRoot(hitVe.flags) && !(hitVe.flags & VisualElementFlags.FlipCardPage)) {
      PageFns.handleEditTitleClick(hitVe, store);
      MouseActionState.set(null);
    } else if (isRating(overDisplayItem)) {
      store.history.setFocus(activeElementPath);
      MouseActionState.set(null);
    } else if (isTable(overDisplayItem)) {
      ClickState.setLinkWasClicked(false);
      TableFns.handleClick(hitVe, null, store, true);
      MouseActionState.set(null);
    } else if (isNote(overDisplayItem)) {
      ClickState.setLinkWasClicked(false);
      NoteFns.handleClick(hitVe, store, true);
      MouseActionState.set(null);
    } else if (isFile(overDisplayItem)) {
      ClickState.setLinkWasClicked(false);
      FileFns.handleClick(hitVe, store, true);
      MouseActionState.set(null);
    } else if (isImage(overDisplayItem)) {
      ClickState.setLinkWasClicked(false);
      ImageFns.handleEditClick(hitVe, store);
      MouseActionState.set(null);
    }
  }, 750);

  MouseActionState.set({
    activeRoot: VeFns.veToPath(hitInfo.rootVes.get().flags & VisualElementFlags.Popup
      ? VesCache.get(hitInfo.rootVes.get().parentPath!)!.get()
      : hitInfo.rootVes.get()),
    startActiveElementParent: hitVe.parentPath!,
    activeElementPath,
    activeCompositeElementMaybe: hitInfo.compositeHitboxTypeMaybe ? VeFns.veToPath(HitInfoFns.getCompositeContainerVe(hitInfo)!) : null,
    activeElementSignalMaybe: VesCache.get(activeElementPath) ?? null,
    activeLinkIdMaybe,
    activeLinkedDisplayItemMaybe,
    moveOver_containerElement: null,
    moveOver_attachHitboxElement: null,
    moveOver_attachCompositeHitboxElement: null,
    moveOver_scaleDefiningElement: scaleDefiningElement,
    hitboxTypeOnMouseDown: hitInfo.hitboxType,
    compositeHitboxTypeMaybeOnMouseDown: hitInfo.compositeHitboxTypeMaybe,
    action: MouseAction.Ambiguous,
    linkCreatedOnMoveStart: false,
    startPx,
    startPosBl,
    startWidthBl,
    startHeightBl,
    startDockWidthPx: store.getCurrentDockWidthPx(),
    startChildAreaBoundsPx: hitVe.childAreaBoundsPx,
    startAttachmentsItem,
    startCompositeItem,
    clickOffsetProp,
    onePxSizeBl,
    hitMeta: hitInfo.overElementMeta,
    newPlaceholderItem: null,
    hitEmbeddedInteractive: canHitEmbeddedInteractive
  });

  // Clear selection set when clicking away from current selection
  try {
    const currentSelection = store.overlay.selectedVeids.get();
    if (currentSelection && currentSelection.length > 0) {
      const clickedVeid = VeFns.veidFromPath(activeElementPath);
      const clickedIsSelected = currentSelection.some(v => v.itemId === clickedVeid.itemId && v.linkIdMaybe === clickedVeid.linkIdMaybe);
      const clickedIsBackground = veFlagIsRoot(hitVe.flags) && !(hitInfo.hitboxType & HitboxFlags.ContentEditable);
      if (!clickedIsSelected || clickedIsBackground) {
        store.overlay.selectedVeids.set([]);
        fullArrange(store);
      }
    }
  } catch { }

  if (hitInfo.hitboxType & HitboxFlags.ContentEditable) {
    // make sure not PreventDefault in the case of clicking on a contenteditable.
    return MouseEventActionFlags.None;
  }

  return defaultResult;
}


function calcStartCompositeItemMaybe(activeItem: Item): CompositeItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Child) { return null; }
  const parent = itemState.get(activeItem.parentId);
  if (!parent) { return null; }
  if (parent.parentId == null) { return null; }
  if (!isComposite(parent)) { return null; }
  return asCompositeItem(parent);
}


function calcStartTableAttachmentsItemMaybe(activeItem: Item): AttachmentsItem | null {
  if (activeItem == null) { return null; }
  if (activeItem.parentId == null) { return null; }
  if (activeItem.relationshipToParent != RelationshipToParent.Attachment) { return null; }
  const parent = itemState.get(activeItem.parentId);
  if (!parent) { return null; }
  if (parent.parentId == null) { return null; }
  const parentParent = itemState.get(parent.parentId);
  if (!parentParent) { return null; }
  if (!isTable(parentParent)) { return null; }
  return asAttachmentsItem(parent);
}


export async function mouseRightDownHandler(store: StoreContextModel) {
  // Always clear current selection set if present
  if (store.overlay.selectedVeids.get() && store.overlay.selectedVeids.get()!.length > 0) {
    store.overlay.selectedVeids.set([]);
    fullArrange(store);
    return;
  }

  if (store.overlay.toolbarTransientMessage.get() != null) {
    store.overlay.toolbarTransientMessage.set(null);
    return;
  }

  if (store.overlay.contextMenuInfo.get()) {
    store.overlay.contextMenuInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.tableColumnContextMenuInfo.get()) {
    store.overlay.tableColumnContextMenuInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.editUserSettingsInfo.get() != null) {
    store.overlay.editUserSettingsInfo.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.toolbarPopupInfoMaybe.get() != null) {
    store.overlay.toolbarPopupInfoMaybe.set(null);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.overlay.searchOverlayVisible.get()) {
    store.overlay.searchOverlayVisible.set(false);
    mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
    return;
  }

  if (store.currentVisiblePassword.get() != null) {
    store.currentVisiblePassword.set(null);
    return;
  }

  // compact expanded list item.
  let hi = HitInfoFns.hit(store, CursorEventState.getLatestDesktopPx(store), [], false);
  if (hi.hitboxType & HitboxFlags.Expand) {
    const itemPath = VeFns.veToPath(HitInfoFns.getHitVe(hi));
    if (store.perVe.getIsExpanded(itemPath)) {
      store.perVe.setIsExpanded(itemPath, !store.perVe.getIsExpanded(itemPath));
      fullArrange(store);
      return;
    }
  }

  // If a non-page item is focused, move focus to parent page before navigating.
  // If a page item is focused (not a root page) and no popup is open, move focus to parent container.
  const currentFocusPath = store.history.getFocusPath();
  const currentFocusVes = VesCache.get(currentFocusPath);
  if (currentFocusVes && !store.history.currentPopupSpec()) {
    const focusVe = currentFocusVes.get();
    const focusItem = focusVe.displayItem;
    if (!veFlagIsRoot(focusVe.flags)) {
      // Move focus to parent container first.
      const parentPath = VeFns.parentPath(currentFocusPath);
      if (parentPath && parentPath !== UMBRELLA_PAGE_UID && parentPath !== "") {
        const parentVes = VesCache.get(parentPath);
        if (parentVes) {
          store.history.setFocus(parentPath);
          fullArrange(store);
          return;
        }
      }
    }
  }

  const topPagePaths = store.topTitledPages.get();
  const focusPath = store.history.getFocusPath();

  // Find the index of the focus path or its containing page in topTitledPages.
  // If focus is on a non-page item (note, table, etc.), we need to find its
  // parent page that exists in topTitledPages.
  // We compare by item ID because the path might have different link IDs
  // (e.g., list page selection uses synthetic links).
  let focusPageIdx = topPagePaths.indexOf(focusPath);

  if (focusPageIdx === -1) {
    // Focus is not directly on a top page. Walk up the VE hierarchy to find
    // the innermost containing page that is in topTitledPages.
    const focusVes = VesCache.get(focusPath);
    if (focusVes) {
      let ve: VisualElement | null = focusVes.get();
      while (ve !== null && ve.parentPath !== null) {
        const parentVes = VesCache.get(ve.parentPath);
        if (!parentVes) break;
        ve = parentVes.get();
        if (isPage(ve.displayItem)) {
          // Check if this page's item ID matches any topTitledPage
          const veItemId = ve.displayItem.id;
          for (let i = 0; i < topPagePaths.length; i++) {
            const topPageItemId = VeFns.itemIdFromPath(topPagePaths[i]);
            if (topPageItemId === veItemId) {
              focusPageIdx = i;
              break;
            }
          }
          if (focusPageIdx !== -1) break;
        }
      }
    }
  }

  if (focusPageIdx > 0) {
    // Save the focused page before navigating up, so it can be restored when clicking back in.
    const currentPageVeid = store.history.currentPageVeid();
    if (currentPageVeid) {
      const focusVes = VesCache.get(focusPath);
      if (focusVes && isPage(focusVes.get().displayItem)) {
        const focusedVeid = VeFns.actualVeidFromVe(focusVes.get());
        store.perItem.setFocusedListPageItem(currentPageVeid, focusedVeid);
      }
    }

    if (store.history.currentPopupSpec() != null) {
      await navigateBack(store);
      return;
    }
    await navigateUp(store);
    return;
  }

  const ves = VesCache.get(focusPath)!;
  if (ves) {
    const ve = ves.get();
    if (ve.flags & VisualElementFlags.EmbeddedInteractiveRoot) {
      store.history.setFocus(ve.parentPath!);
      fullArrange(store);
      return;
    }

    if (isFlipCard(ve.displayItem)) {
      store.history.setFocus(ve.parentPath!);
      fullArrange(store);
      return;
    }
  }

  // Save focus before navigating (when focus is on root list page).
  // This needs to happen before navigateBack/navigateUp so the focus is preserved.
  const currentPageVeid = store.history.currentPageVeid();
  if (currentPageVeid) {
    const currentPageItem = itemState.get(currentPageVeid.itemId);
    if (currentPageItem && isPage(currentPageItem) && asPageItem(currentPageItem).arrangeAlgorithm === ArrangeAlgorithm.List) {
      const focusVes = VesCache.get(focusPath);
      if (focusVes && isPage(focusVes.get().displayItem)) {
        const focusedVeid = VeFns.actualVeidFromVe(focusVes.get());
        store.perItem.setFocusedListPageItem(currentPageVeid, focusedVeid);
      }
    }
  }

  const changedPages = await navigateBack(store);
  if (!changedPages) {
    await navigateUp(store);
  }
}
