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

import { GRID_SIZE, NATURAL_BLOCK_SIZE_PX } from "../constants";
import { asAttachmentsItem } from "../items/base/attachments-item";
import { asContainerItem } from "../items/base/container-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite, CompositeFns } from "../items/composite-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { isPlaceholder, PlaceholderFns } from "../items/placeholder-item";
import { asTableItem, isTable } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VeFns, VisualElementFlags, veFlagIsRoot, EMPTY_VEID, isVeTranslucentPage } from "../layout/visual-element";
import { server, serverOrRemote } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { DoubleClickState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState, CursorEventState } from "./state";
import { MouseEventActionFlags } from "./enums";
import { boundingBoxFromDOMRect, isInside } from "../util/geometry";
import { isFlipCard } from "../items/flipcard-item";
import { decodeCalendarCombinedIndex, calculateCalendarPosition } from "../util/calendar-layout";


export function mouseUpHandler(store: StoreContextModel): MouseEventActionFlags {

  if (document.activeElement!.id.includes("toolbarTitleDiv")) {
    let titleBounds = boundingBoxFromDOMRect(document.activeElement!.getBoundingClientRect())!;
    if (isInside(CursorEventState.getLatestClientPx(), titleBounds)) {
      return MouseEventActionFlags.None;
    }
  }

  store.anItemIsResizing.set(false);
  store.anItemIsMoving.set(false);
  UserSettingsMoveState.set(null);

  // Note: There is no right mouse up handler. Program control flow will exit here in right mouse case.
  // Note: right mouse is handled in mouse_down.ts/mouseRightDownHandler.
  if (MouseActionState.empty()) { return MouseEventActionFlags.PreventDefault; }

  const activeVisualElementSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVisualElementSignal) {
    store.anItemIsResizing.set(false);
    store.anItemIsMoving.set(false);
    return MouseEventActionFlags.PreventDefault;
  }
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  switch (MouseActionState.get().action) {
    case MouseAction.Moving:
      DoubleClickState.preventDoubleClick();
      mouseUpHandler_moving_groupAware(store, activeItem);
      break;

    case MouseAction.MovingPopup: {
      DoubleClickState.preventDoubleClick();
      break;
    }

    case MouseAction.Resizing:
      DoubleClickState.preventDoubleClick();
      const xsized = isLink(activeItem)
        ? MouseActionState.get().startWidthBl! * GRID_SIZE != asLinkItem(activeItem).spatialWidthGr
        : MouseActionState.get().startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr;
      if (xsized ||
          (isYSizableItem(activeItem) && MouseActionState.get().startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr) ||
          // TODO (LOW): don't update if there are no changes.
          (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem)) ||
          isFlipCard(activeItem) ||
          (isLink(activeItem) && isFlipCard(activeVisualElement.displayItem))) {
        serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);
      }
      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.ResizingPopup: {
      if (activeVisualElement.actualLinkItemMaybe) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.actualLinkItemMaybe.id)!, store.general.networkStatus);
      } else {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      DoubleClickState.preventDoubleClick();
      break;
    }

    case MouseAction.ResizingColumn:
      DoubleClickState.preventDoubleClick();
      const widthGr = activeVisualElement.linkItemMaybe == null
        ? asTableItem(activeItem).tableColumns[MouseActionState.get().hitMeta!.colNum!].widthGr
        : asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get().hitMeta!.colNum!].widthGr;
      if (MouseActionState.get().startWidthBl! * GRID_SIZE != widthGr) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.ResizingDock:
      if (store.getCurrentDockWidthPx() == 0) {
        store.dockVisible.set(false);
        store.setDockWidthPx(MouseActionState.get().startWidthBl! * NATURAL_BLOCK_SIZE_PX.w);
      } else {
        store.dockVisible.set(true);
      }
      break;

    case MouseAction.ResizingDockItem:
      DoubleClickState.preventDoubleClick();
      if (MouseActionState.get().startChildAreaBoundsPx!.h != activeVisualElement.childAreaBoundsPx!.h) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.ResizingListPageColumn:
      const newWidthGr = asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr;
      if (MouseActionState.get().startWidthBl! * GRID_SIZE != newWidthGr) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.Selecting:
      handleSelectionMouseUp(store);
      break;

    case MouseAction.Ambiguous:
      {
        const sel = store.overlay.selectedVeids.get();
        if (sel && sel.length > 1) {
          const clickedVeid = VeFns.veidFromVe(activeVisualElement);
          const clickedIsSelected = sel.some(v => v.itemId === clickedVeid.itemId && v.linkIdMaybe === clickedVeid.linkIdMaybe);
          if (clickedIsSelected) {
            store.overlay.selectedVeids.set([]);
            fullArrange(store);
          }
        }
      }

      if (ClickState.getLinkWasClicked()) {
        ItemFns.handleLinkClick(activeVisualElement, store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.TriangleLinkSettings) {
        const focusPath = VeFns.addVeidToPath(
          { itemId: VeFns.veidFromPath(MouseActionState.get().activeElementPath).linkIdMaybe!, linkIdMaybe: null },
          VeFns.parentPath(MouseActionState.get().activeElementPath)
        );
        store.history.setFocus(focusPath);

      } else if ((MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Flip) ||
                 (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.TimedFlip)) {
        DoubleClickState.preventDoubleClick();
        const veid = VeFns.veidFromPath(MouseActionState.get().activeElementPath);
        store.perItem.setFlipCardVisibleSide(veid, store.perItem.getFlipCardVisibleSide(veid) == 0 ? 1 : 0);
        fullArrange(store);
        if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.TimedFlip) {
          setTimeout(() => {
            store.perItem.setFlipCardVisibleSide(veid, 0);
            fullArrange(store);
          }, 750);
        }

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Anchor) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleAnchorClick(activeVisualElement, store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Edit) {
        store.perVe.setFlipCardIsEditing(
          MouseActionState.get().activeElementPath,
          !store.perVe.getFlipCardIsEditing(MouseActionState.get().activeElementPath)
        );

        fullArrange(store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.TableColumnContextMenu) {
        store.overlay.tableColumnContextMenuInfo.set({
          posPx: CursorEventState.getLatestDesktopPx(store),
          tablePath: MouseActionState.get().activeElementPath,
          colNum: MouseActionState.get().hitMeta?.colNum ? MouseActionState.get().hitMeta?.colNum! : 0,
        });

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Expand) {
        store.perVe.setIsExpanded(
          MouseActionState.get().activeElementPath,
          !store.perVe.getIsExpanded(MouseActionState.get().activeElementPath)
        );
        fullArrange(store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.OpenPopup) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleOpenPopupClick(activeVisualElement, store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.OpenAttachment) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleOpenPopupClick(activeVisualElement, store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.CalendarOverflow) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleCalendarOverflowClick(activeVisualElement, store, MouseActionState.get().hitMeta ?? null);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Click) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleClick(activeVisualElementSignal, MouseActionState.get().hitMeta, MouseActionState.get().hitboxTypeOnMouseDown, store);

      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.ShiftLeft) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleShiftLeftClick(activeVisualElement, store);

      } else if (veFlagIsRoot(VesCache.get(MouseActionState.get().activeRoot)!.get().flags & VisualElementFlags.EmbeddedInteractiveRoot) &&
                 !(MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Move)) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleClick(activeVisualElementSignal, MouseActionState.get().hitMeta, MouseActionState.get().hitboxTypeOnMouseDown, store);

      } else if (veFlagIsRoot(VesCache.get(MouseActionState.get().activeRoot)!.get().flags) &&
                 !(VesCache.get(MouseActionState.get().activeRoot)!.get().flags & VisualElementFlags.IsDock) &&
                 ((VeFns.veidFromVe(VesCache.get(MouseActionState.get().activeRoot)!.get()).itemId != store.history.currentPageVeid()!.itemId) ||
                  (VeFns.veidFromVe(VesCache.get(MouseActionState.get().activeRoot)!.get()).linkIdMaybe != store.history.currentPageVeid()!.linkIdMaybe)) &&
                 (CursorEventState.getLatestDesktopPx(store).y > 0)) {
        DoubleClickState.preventDoubleClick();
        store.history.setFocus(MouseActionState.get().activeElementPath);

        {
          const focusPagePath = store.history.getFocusPath();
          const focusPageVe = VesCache.get(focusPagePath)!.get();
          const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
          const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
          if (selectedVeid == EMPTY_VEID) {
            PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
          }
        }

        // console.log("(1) setting focus to", MouseActionState.get().activeElementPath);
        fullArrange(store);

      } else if (activeVisualElementSignal.get().flags & VisualElementFlags.Popup) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleClick(activeVisualElementSignal, MouseActionState.get().hitMeta, MouseActionState.get().hitboxTypeOnMouseDown, store);

      } else if (activeVisualElementSignal.get().flags & VisualElementFlags.IsDock) {
        DoubleClickState.preventDoubleClick();

      } else if (activeVisualElementSignal.get().flags & VisualElementFlags.FlipCardPage) {
        // nothing.

      } else {
        if (isComposite(activeVisualElement.displayItem) || isPlaceholder(activeVisualElement.displayItem)) {
          // noop.

        } else {
          store.history.setFocus(MouseActionState.get().activeElementPath);

          {
            const focusPagePath = store.history.getFocusPath();
            const focusPageVe = VesCache.get(focusPagePath)!.get();
            const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
            const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
            if (selectedVeid == EMPTY_VEID) {
              PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
            }
          }

          if (isFlipCard(activeVisualElement.displayItem)) {
            store.perVe.setFlipCardIsEditing(
              MouseActionState.get().activeElementPath,
              !store.perVe.getFlipCardIsEditing(MouseActionState.get().activeElementPath)
            );
          }

          // console.log("(2) setting focus to", MouseActionState.get().activeElementPath);
          fullArrange(store);
        }
      }

      break;

    default:
      panic(`mouseUpHandler: unknown action ${MouseActionState.get().action}.`);
  }

  ClickState.setLinkWasClicked(false);
  MouseActionState.set(null);

  return MouseEventActionFlags.PreventDefault;
}


function mouseUpHandler_moving_groupAware(store: StoreContextModel, activeItem: PositionalItem) {

  if (MouseActionState.get().moveOver_containerElement != null) {
    const ve = VesCache.get(MouseActionState.get().moveOver_containerElement!)!.get();
    store.perVe.setMovingItemIsOver(VeFns.veToPath(ve), false);
  }

  if (MouseActionState.get().moveOver_attachHitboxElement != null) {
    mouseUpHandler_moving_hitboxAttachTo(store, activeItem);
    return;
  }

  if (MouseActionState.get().moveOver_attachCompositeHitboxElement != null) {
    mouseUpHandler_moving_hitboxAttachToComposite(store, activeItem);
    return;
  }

  const overContainerVe = VesCache.get(MouseActionState.get().moveOver_containerElement!)!.get();
  if (isTable(overContainerVe.displayItem)) {
    mouseUpHandler_moving_toTable(store, activeItem, overContainerVe);
    return;
  }

  if (overContainerVe.displayItem.id != activeItem.parentId) {
    if (isFlipCard(overContainerVe.displayItem)) {
      mouseUpHandler_moving_toFlipCard(store, activeItem, overContainerVe);
      return;
    } else if (isPage(overContainerVe.displayItem)) {
      const targetPageItem = asPageItem(overContainerVe.displayItem);
      if (targetPageItem.arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
        const path = VeFns.veToPath(overContainerVe);
        let combinedIndex = store.perVe.getMoveOverIndex(path);
        let targetMonth: number;
        let targetDay: number;
        if (combinedIndex >= 0) {
          const decoded = decodeCalendarCombinedIndex(combinedIndex);
          targetMonth = decoded.month;
          targetDay = decoded.day;
        } else {
          const pos = calculateCalendarPosition(CursorEventState.getLatestDesktopPx(store), overContainerVe, store);
          targetMonth = pos.month;
          targetDay = pos.day;
        }
        const selectedYear = store.perVe.getCalendarYear(path);
        const currentDate = new Date(activeItem.dateTime * 1000);
        const newDate = new Date(selectedYear, targetMonth - 1, targetDay, currentDate.getHours(), currentDate.getMinutes(), currentDate.getSeconds());
        const newDateTime = Math.floor(newDate.getTime() / 1000);
        if (activeItem.dateTime !== newDateTime) {
          activeItem.dateTime = newDateTime;
        }
        activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
        itemState.moveToNewParent(activeItem, targetPageItem.id, RelationshipToParent.Child);
         persistMovedItems(store, [activeItem.id]);
        finalizeMouseUp(store);
        MouseActionState.set(null);
        fullArrange(store);
        return;
      } else {
        mouseUpHandler_moving_toOpaquePage(store, activeItem, overContainerVe);
        return;
      }
    } else {
      // Non-page container: treat as opaque container move
      mouseUpHandler_moving_toOpaquePage(store, activeItem, overContainerVe);
      return;
    }
  }

  // root page

  if (isPage(overContainerVe.displayItem)) {
    const pageItem = asPageItem(overContainerVe.displayItem);
    if (overContainerVe.flags & VisualElementFlags.IsDock) {
    const ip = store.perVe.getMoveOverIndexAndPosition(VeFns.veToPath(overContainerVe));
    activeItem.ordering = itemState.newOrderingAtChildrenPosition(pageItem.id, ip.index, activeItem.id);
    itemState.sortChildren(pageItem.id);
   persistMovedItems(store, [activeItem.id]);
    }
    else if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
             pageItem.arrangeAlgorithm == ArrangeAlgorithm.List ||
             pageItem.arrangeAlgorithm == ArrangeAlgorithm.Justified) {
      const path = VeFns.veToPath(overContainerVe);
      const idx = store.perVe.getMoveOverIndex(path);
      const insertIndex = pageItem.orderChildrenBy != "" ? 0 : idx;
      activeItem.ordering = itemState.newOrderingAtChildrenPosition(pageItem.id, insertIndex, activeItem.id);
      itemState.sortChildren(pageItem.id);
     persistMovedItems(store, [activeItem.id]);
    } else if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      if (MouseActionState.get().startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
          MouseActionState.get().startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y) {
     persistMovedItems(store, [activeItem.id]);
      }
    } else if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.Calendar) {
      const path = VeFns.veToPath(overContainerVe);
      let combinedIndex = store.perVe.getMoveOverIndex(path);
      let targetMonth: number;
      let targetDay: number;
      if (combinedIndex >= 0) {
        const decoded = decodeCalendarCombinedIndex(combinedIndex);
        targetMonth = decoded.month;
        targetDay = decoded.day;
      } else {
        const pos = calculateCalendarPosition(CursorEventState.getLatestDesktopPx(store), overContainerVe, store);
        targetMonth = pos.month;
        targetDay = pos.day;
      }
      const selectedYear = store.perVe.getCalendarYear(path);
      const currentDate = new Date(activeItem.dateTime * 1000);
      const newDate = new Date(selectedYear, targetMonth - 1, targetDay, currentDate.getHours(), currentDate.getMinutes(), currentDate.getSeconds());
      const newDateTime = Math.floor(newDate.getTime() / 1000);
      if (activeItem.dateTime !== newDateTime) {
        activeItem.dateTime = newDateTime;
        serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);
      }
    }
    else {
      console.debug("todo: explicitly consider other page types here.");
      serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);
    }
  } else {
    // Not over a page; persist moved items (including group) if any
    persistMovedItems(store, [activeItem.id]);
  }

  finalizeMouseUp(store);
  MouseActionState.set(null); // required before arrange to as arrange makes use of move state.
  fullArrange(store);
}

function persistMovedItems(store: StoreContextModel, defaultIds: string[]) {
  const group = MouseActionState.get().groupMoveItems;
  if (group && group.length > 0) {
    const ids = group.map(g => g.veid.linkIdMaybe ? g.veid.linkIdMaybe : g.veid.itemId);
    for (const id of ids) {
      serverOrRemote.updateItem(itemState.get(id)!, store.general.networkStatus);
    }
  } else {
    for (const id of defaultIds) {
      serverOrRemote.updateItem(itemState.get(id)!, store.general.networkStatus);
    }
  }
}


async function mouseUpHandler_moving_hitboxAttachToComposite(store: StoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;

  const attachToVisualElement = VesCache.get(MouseActionState.get()!.moveOver_attachCompositeHitboxElement!)!.get();
  const attachToVisualElementPath = VeFns.veToPath(attachToVisualElement);
  store.perVe.setMovingItemIsOverAttachComposite(attachToVisualElementPath, false);
  MouseActionState.get()!.moveOver_attachCompositeHitboxElement = null;

  const attachToItem = asPositionalItem(VeFns.treeItem(attachToVisualElement));

  if (attachToVisualElement.displayItem.id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    panic("mouseUpHandler_moving_hitboxAttachToComposite: Attempt was made to attach an item to itself.");
  }

  // case #1: attaching to an item inside an existing composite.
  if (isComposite(itemState.get(attachToItem.parentId)!)) {
    const destinationCompositeItem = itemState.get(attachToItem.parentId)!;

    // case #1.1: the moving item is not a composite.
    if (!isComposite(activeItem)) {
      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(
        activeItem, destinationCompositeItem.id, RelationshipToParent.Child, itemState.newOrderingDirectlyAfterChild(destinationCompositeItem.id, attachToItem.id));
      serverOrRemote.updateItem(activeItem, store.general.networkStatus);
    }

    // case #1.2: the moving item is a composite.
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      let lastPrevId = attachToItem.id;
      while (activeItem_composite.computed_children.length > 0) {
        const child = itemState.get(activeItem_composite.computed_children[0])!;
        itemState.moveToNewParent(
          child, destinationCompositeItem.id, RelationshipToParent.Child, itemState.newOrderingDirectlyAfterChild(destinationCompositeItem.id, lastPrevId));
        lastPrevId = child.id;
        serverOrRemote.updateItem(child, store.general.networkStatus);
      }
      itemState.delete(activeItem_composite.id);
      server.deleteItem(activeItem_composite.id, store.general.networkStatus);
      MouseActionState.get().startCompositeItem = null;
    }

  // case #2: attaching to an item that is not inside an existing composite.
  } else {

    // case #2.1: this item is not a composite either.
    if (!isComposite(activeItem)) {
      const compositeItem = CompositeFns.create(activeItem.ownerId, prevParentId, RelationshipToParent.Child, attachToItem.ordering);
      compositeItem.spatialPositionGr = { x: attachToItem.spatialPositionGr.x, y: attachToItem.spatialPositionGr.y };
      if (isXSizableItem(attachToItem)) { compositeItem.spatialWidthGr = asXSizableItem(attachToItem).spatialWidthGr; }
      itemState.add(compositeItem);
      server.addItem(compositeItem, null, store.general.networkStatus);

      attachToItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(attachToItem, compositeItem.id, RelationshipToParent.Child);
      serverOrRemote.updateItem(attachToItem, store.general.networkStatus);

      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(activeItem, compositeItem.id, RelationshipToParent.Child);
      serverOrRemote.updateItem(activeItem, store.general.networkStatus);
    }

    // case #2.2: the moving item being attached is a composite. 
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      const attachToPositionGr = attachToItem.spatialPositionGr;
      activeItem_composite.spatialPositionGr = attachToPositionGr;
      itemState.moveToNewParent(attachToItem, activeItem_composite.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(activeItem_composite.id));
      serverOrRemote.updateItem(attachToItem, store.general.networkStatus);
      serverOrRemote.updateItem(activeItem_composite, store.general.networkStatus);
    }

  }

  finalizeMouseUp(store);
  MouseActionState.set(null); // required before arrange to as arrange makes use of move state.
  fullArrange(store);
}


function mouseUpHandler_moving_hitboxAttachTo(store: StoreContextModel, activeItem: PositionalItem) {
  const attachToVisualElement = VesCache.get(MouseActionState.get().moveOver_attachHitboxElement!)!.get();
  if (asAttachmentsItem(attachToVisualElement.displayItem).id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    console.error("activeItem", activeItem);
    console.error("attachToVisualElement", attachToVisualElement);
    panic("mouseUpHandler_moving_hitboxAttachTo: Attempt was made to attach an item to itself.");
  }

  store.perVe.setMovingItemIsOverAttach(VeFns.veToPath(attachToVisualElement), false);
  MouseActionState.get().moveOver_attachHitboxElement = null;

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  itemState.moveToNewParent(activeItem, attachToVisualElement.displayItem.id, RelationshipToParent.Attachment);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);

  finalizeMouseUp(store);
  fullArrange(store);
}

function mouseUpHandler_moving_toFlipCard(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const containerVeid = VeFns.veidFromVe(overContainerVe);
  const flipCardItem = asContainerItem(itemState.get(containerVeid.itemId)!);
  const visibleSide = store.perItem.getFlipCardVisibleSide(containerVeid);
  const pageItem = asPageItem(itemState.get(flipCardItem.computed_children[visibleSide])!);

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  itemState.moveToNewParent(activeItem, pageItem.id, RelationshipToParent.Child);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);

  finalizeMouseUp(store);
  fullArrange(store);
}

function mouseUpHandler_moving_toOpaquePage(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  if (isTable(overContainerVe.displayItem)) { panic("mouseUpHandler_moving_toOpaquePage: over container is a table."); }

  const moveOverContainerId = overContainerVe.displayItem.id;
  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    console.error("activeItem", activeItem);
    console.error("overContainerVe", overContainerVe);
    panic("mouseUpHandler_moving_toOpaquePage: Attempt was made to move an item into itself.");
  }

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);

  finalizeMouseUp(store);
  fullArrange(store);
}


function mouseUpHandler_moving_toTable(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const moveOverContainerId = overContainerVe.displayItem.id;
  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    console.error("activeItem", activeItem);
    console.error("overContainerVe", overContainerVe);
    panic("mouseUpHandler_moving_toTable: Attempt was made to move an item into itself.");
  }

  if (store.perVe.getMoveOverColAttachmentNumber(VeFns.veToPath(overContainerVe)) >= 0) {
    mouseUpHandler_moving_toTable_attachmentCell(store, activeItem, overContainerVe);
    return;
  }

  const moveToOrdering = itemState.newOrderingAtChildrenPosition(moveOverContainerId, store.perVe.getMoveOverRowNumber(VeFns.veToPath(overContainerVe)), activeItem.id);
  itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child, moveToOrdering);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);

  finalizeMouseUp(store);
  fullArrange(store);
}


function mouseUpHandler_moving_toTable_attachmentCell(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const tableItem = asTableItem(overContainerVe.displayItem);
  let rowNumber = store.perVe.getMoveOverRowNumber(VeFns.veToPath(overContainerVe));
  const yScrollPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(overContainerVe));
  if (rowNumber < yScrollPos) { rowNumber = yScrollPos; }

  const childId = tableItem.computed_children[rowNumber];
  const child = itemState.get(childId)!;

  const displayedChild = asAttachmentsItem(isLink(child)
    ? itemState.get(LinkFns.getLinkToId(asLinkItem(child)))!
    : child);
  const insertPosition = store.perVe.getMoveOverColAttachmentNumber(VeFns.veToPath(overContainerVe));

  const numPlaceholdersToCreate = insertPosition > displayedChild.computed_attachments.length ? insertPosition - displayedChild.computed_attachments.length : 0;
  for (let i=0; i<numPlaceholdersToCreate; ++i) {
    const placeholderItem = PlaceholderFns.create(activeItem.ownerId, displayedChild.id, RelationshipToParent.Attachment, itemState.newOrderingAtEndOfAttachments(displayedChild.id));
    itemState.add(placeholderItem);
    server.addItem(placeholderItem, null, store.general.networkStatus);
  }
  let newOrdering: Uint8Array | undefined;
  if (insertPosition < displayedChild.computed_attachments.length) {
    const overAttachmentId = displayedChild.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      newOrdering = placeholderToReplaceMaybe.ordering;
      itemState.delete(placeholderToReplaceMaybe.id);
      server.deleteItem(placeholderToReplaceMaybe.id, store.general.networkStatus);
    } else {
      // TODO (MEDIUM): probably want to forbid rather than insert in this case.
      newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedChild.id, insertPosition);
    }
  } else {
    newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedChild.id, insertPosition);
  }

  itemState.moveToNewParent(activeItem, displayedChild.id, RelationshipToParent.Attachment, newOrdering);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!, store.general.networkStatus);

  finalizeMouseUp(store);
  fullArrange(store);
}


function finalizeMouseUp(store: StoreContextModel) {
  cleanupAndPersistPlaceholders(store);
  maybeDeleteComposite(store)
}

function handleSelectionMouseUp(store: StoreContextModel) {
  const rect = store.overlay.selectionMarqueePx.get();
  store.overlay.selectionMarqueePx.set(null);
  if (rect == null) { return; }

  const activeRootVe = VesCache.get(MouseActionState.get().activeRoot)!.get();
  const activeRootBounds = VeFns.veViewportBoundsRelativeToDesktopPx(store, activeRootVe);
  const selectionRect = {
    x: Math.max(rect.x, activeRootBounds.x),
    y: Math.max(rect.y, activeRootBounds.y),
    w: Math.min(rect.x + rect.w, activeRootBounds.x + activeRootBounds.w) - Math.max(rect.x, activeRootBounds.x),
    h: Math.min(rect.y + rect.h, activeRootBounds.y + activeRootBounds.h) - Math.max(rect.y, activeRootBounds.y),
  };
  if (selectionRect.w <= 0 || selectionRect.h <= 0) {
    store.overlay.selectedVeids.set([]);
    return;
  }

  const selected: Array<{ itemId: string; linkIdMaybe: string | null }> = [];
  const selectedSet = new Set<string>();
  const rootPath = MouseActionState.get().activeRoot;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const ves = VesCache.get(path);
    if (!ves) { continue; }
    const ve = ves.get();
    if (ve.parentPath && !(ve.flags & VisualElementFlags.LineItem)) {
      const veBox = VeFns.veViewportBoundsRelativeToDesktopPx(store, ve);
      if (veBox.w > 0 && veBox.h > 0) {
        const ix = Math.max(selectionRect.x, veBox.x);
        const iy = Math.max(selectionRect.y, veBox.y);
        const ax = Math.min(selectionRect.x + selectionRect.w, veBox.x + veBox.w);
        const ay = Math.min(selectionRect.y + selectionRect.h, veBox.y + veBox.h);
        if (ix < ax && iy < ay) {
          // If inside a composite, select the composite parent instead of the child
          if (ve.flags & VisualElementFlags.InsideCompositeOrDoc) {
            const parentVe = VesCache.get(ve.parentPath!)!.get();
            if (isComposite(parentVe.displayItem)) {
              const itemId = parentVe.displayItem.id;
              const linkIdMaybe = parentVe.actualLinkItemMaybe ? parentVe.actualLinkItemMaybe.id : null;
              const key = itemId + (linkIdMaybe ? `[${linkIdMaybe}]` : "");
              if (!selectedSet.has(key)) { selected.push({ itemId, linkIdMaybe }); selectedSet.add(key); }
              continue;
            }
          }

          const isSelectableContainer = isTable(ve.displayItem);
          if ((!(ve.flags & VisualElementFlags.ShowChildren) || isSelectableContainer || isVeTranslucentPage(ve)) && !(ve.flags & VisualElementFlags.Popup)) {
            const itemId = ve.displayItem.id;
            const linkIdMaybe = ve.actualLinkItemMaybe ? ve.actualLinkItemMaybe.id : null;
            const key = itemId + (linkIdMaybe ? `[${linkIdMaybe}]` : "");
            if (!selectedSet.has(key)) { selected.push({ itemId, linkIdMaybe }); selectedSet.add(key); }
          }
        }
      }
    }
    for (const child of ve.childrenVes) { stack.push(VeFns.veToPath(child.get())); }
    for (const att of ve.attachmentsVes) { stack.push(VeFns.veToPath(att.get())); }
    if (ve.popupVes) { stack.push(VeFns.veToPath(ve.popupVes.get())); }
  }
  store.overlay.selectedVeids.set(selected);
  fullArrange(store);
}


async function maybeDeleteComposite(store: StoreContextModel) {
  if (MouseActionState.empty()) { return; }
  if (MouseActionState.get().startCompositeItem == null) { return; }

  const compositeItem = MouseActionState.get().startCompositeItem!;
  if (compositeItem.computed_children.length == 0) { panic("maybeDeleteComposite: composite has no children."); }
  if (compositeItem.computed_children.length != 1) {
    MouseActionState.get().startCompositeItem = null;
    return;
  }
  const compositeItemParent = asContainerItem(itemState.get(compositeItem.parentId)!);
  const child = itemState.get(compositeItem.computed_children[0])!;
  if (!isPositionalItem(child)) { panic("maybeDeleteComposite: child is not positional."); }
  child.parentId = compositeItem.parentId;
  asPositionalItem(child).spatialPositionGr = compositeItem.spatialPositionGr;
  compositeItem.computed_children = [];
  compositeItemParent.computed_children.push(child.id);
  itemState.delete(compositeItem.id);
  itemState.sortChildren(compositeItemParent.id);

  serverOrRemote.updateItem(child, store.general.networkStatus);
  server.deleteItem(compositeItem.id, store.general.networkStatus);
}


function cleanupAndPersistPlaceholders(store: StoreContextModel) {
  if (MouseActionState.empty()) { return; }
  if (MouseActionState.get().startAttachmentsItem == null) { return; }

  if (MouseActionState.get().newPlaceholderItem != null) {
    server.addItem(MouseActionState.get().newPlaceholderItem!, null, store.general.networkStatus);
  }

  const placeholderParent = MouseActionState.get().startAttachmentsItem!;

  while (true) {
    const attachments = placeholderParent.computed_attachments;
    if (attachments.length == 0) { break; }
    const attachmentId = placeholderParent.computed_attachments[placeholderParent.computed_attachments.length-1];
    const attachment = itemState.get(attachmentId)!;
    if (attachment == null) { panic("cleanupAndPersistPlaceholders: no attachment."); }
    if (!isPlaceholder(attachment)) {
      break;
    }
    server.deleteItem(attachment.id, store.general.networkStatus);
    itemState.delete(attachment.id);
  }

  MouseActionState.get().newPlaceholderItem = null;
  MouseActionState.get().startAttachmentsItem = null;
}
