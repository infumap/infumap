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
import { PageFns } from "../items/page-item";
import { isPlaceholder, PlaceholderFns } from "../items/placeholder-item";
import { asTableItem, isTable } from "../items/table-item";
import { fullArrange } from "../layout/arrange";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VeFns } from "../layout/visual-element";
import { server, serverOrRemote } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { DoubleClickState, DialogMoveState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState, CursorEventState } from "./state";
import { PopupType } from "../store/StoreProvider_History";
import { MouseEventActionFlags } from "./enums";
import { boundingBoxFromDOMRect, isInside } from "../util/geometry";


export function mouseUpHandler(store: StoreContextModel): MouseEventActionFlags {

  if (document.activeElement == document.getElementById("toolbarTitleDiv")!) {
    let titleBounds = boundingBoxFromDOMRect(document.getElementById("toolbarTitleDiv")!.getBoundingClientRect())!;
    if (isInside(CursorEventState.getLatestClientPx(), titleBounds)) {
      return MouseEventActionFlags.None;
    }
  }

  store.anItemIsMoving.set(false);

  DialogMoveState.set(null);
  UserSettingsMoveState.set(null);

  if (MouseActionState.empty()) { return MouseEventActionFlags.PreventDefault; }

  const activeVisualElementSignal = VesCache.get(MouseActionState.get().activeElement)!;
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(VeFns.canonicalItem(activeVisualElement));

  switch (MouseActionState.get().action) {
    case MouseAction.Moving:
      DoubleClickState.preventDoubleClick();
      mouseUpHandler_moving(store, activeItem);
      break;

    case MouseAction.MovingPopup: {
      DoubleClickState.preventDoubleClick();
      break;
    }

    case MouseAction.Resizing:
      DoubleClickState.preventDoubleClick();
      if ((MouseActionState.get().startWidthBl! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr) ||
          (isYSizableItem(activeItem) && MouseActionState.get().startHeightBl! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr) ||
          (isLink(activeItem) && isYSizableItem(activeVisualElement.displayItem))) {
        serverOrRemote.updateItem(itemState.get(activeItem.id)!);
      }
      // mouseActionState.activeVisualElement.update(ve => {
      //   ve.resizingFromBoundsPx = null;
      // });
      break;

    case MouseAction.ResizingPopup: {
      DoubleClickState.preventDoubleClick();
      break;
    }

    case MouseAction.ResizingColumn:
      DoubleClickState.preventDoubleClick();
      const widthGr = activeVisualElement.linkItemMaybe == null
        ? asTableItem(activeItem).tableColumns[MouseActionState.get().hitMeta!.colNum!].widthGr
        : asTableItem(activeVisualElement.displayItem).tableColumns[MouseActionState.get().hitMeta!.colNum!].widthGr;
      if (MouseActionState.get().startWidthBl! * GRID_SIZE != widthGr) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!);
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

    case MouseAction.ResizingListPageColumn:
      break;

    case MouseAction.Ambiguous:
      if (ClickState.getLinkWasClicked()) {
        ItemFns.handleLinkClick(activeVisualElement);
      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.TriangleLinkSettings) {
        const focusPath = VeFns.addVeidToPath(
          { itemId: VeFns.veidFromPath(MouseActionState.get().activeElement).linkIdMaybe!, linkIdMaybe: null },
          VeFns.parentPath(MouseActionState.get().activeElement)
        );
        store.history.setFocus(focusPath);
      } else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.OpenPopup) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleOpenPopupClick(activeVisualElement, store);
      }
      else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.OpenAttachment) {
        DoubleClickState.preventDoubleClick();
        handleAttachmentClick(store, activeVisualElement);
        fullArrange(store);
      }
      else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Click) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleClick(activeVisualElementSignal, MouseActionState.get().hitMeta, store);
      }
      else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Anchor) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleAnchorClick(activeVisualElement, store);
      }
      else if (MouseActionState.get().hitboxTypeOnMouseDown! & HitboxFlags.Expand) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleExpandClick(activeVisualElement, store);
      } else {
        // TODO (MEDIUM): remove this logging. unsure if this case gets hit.
        console.debug("no action taken");
      }
      break;

    default:
      panic(`mouseUpHandler: unknown action ${MouseActionState.get().action}.`);
  }

  ClickState.setLinkWasClicked(false);
  MouseActionState.set(null);

  return MouseEventActionFlags.PreventDefault;
}


function handleAttachmentClick(store: StoreContextModel, visualElement: VisualElement) {
  VesCache.removeByPath(VeFns.veToPath(visualElement));
  store.history.replacePopup({
    type: PopupType.Attachment,
    actualVeid: VeFns.actualVeidFromVe(visualElement),
    vePath: VeFns.veToPath(visualElement),
  })
}


function mouseUpHandler_moving(store: StoreContextModel, activeItem: PositionalItem) {

  if (MouseActionState.get().moveOver_containerElement != null) {
    VesCache.get(MouseActionState.get().moveOver_containerElement!)!.get()
      .movingItemIsOver.set(false);
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
    mouseUpHandler_moving_toOpaquePage(store, activeItem, overContainerVe);
    return;
  }

  // root page
  if (MouseActionState.get().startPosBl!.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
      MouseActionState.get().startPosBl!.y * GRID_SIZE != activeItem.spatialPositionGr.y) {
    serverOrRemote.updateItem(itemState.get(activeItem.id)!);
  }

  finalizeMouseUp();
  MouseActionState.set(null); // required before arrange to as arrange makes use of move state.
  fullArrange(store);
}


async function mouseUpHandler_moving_hitboxAttachToComposite(store: StoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;

  const attachToVisualElement = VesCache.get(MouseActionState.get()!.moveOver_attachCompositeHitboxElement!)!.get();
  attachToVisualElement.movingItemIsOverAttach.set(false);
  MouseActionState.get()!.moveOver_attachCompositeHitboxElement = null;

  const attachToItem = asPositionalItem(VeFns.canonicalItem(attachToVisualElement));

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
      serverOrRemote.updateItem(activeItem);
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
        serverOrRemote.updateItem(child);
      }
      itemState.delete(activeItem_composite.id);
      server.deleteItem(activeItem_composite.id);
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
      server.addItem(compositeItem, null);

      attachToItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(attachToItem, compositeItem.id, RelationshipToParent.Child);
      serverOrRemote.updateItem(attachToItem);

      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(activeItem, compositeItem.id, RelationshipToParent.Child);
      serverOrRemote.updateItem(activeItem);
    }

    // case #2.2: the moving item being attached is a composite. 
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      const attachToPositionGr = attachToItem.spatialPositionGr;
      activeItem_composite.spatialPositionGr = attachToPositionGr;
      itemState.moveToNewParent(attachToItem, activeItem_composite.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(activeItem_composite.id));
      serverOrRemote.updateItem(attachToItem);
      serverOrRemote.updateItem(activeItem_composite);
    }

  }

  finalizeMouseUp();
  MouseActionState.set(null); // required before arrange to as arrange makes use of move state.
  fullArrange(store);
}


function mouseUpHandler_moving_hitboxAttachTo(store: StoreContextModel, activeItem: PositionalItem) {
  const attachToVisualElement = VesCache.get(MouseActionState.get().moveOver_attachHitboxElement!)!.get();
  if (asAttachmentsItem(attachToVisualElement.displayItem).id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    panic("mouseUpHandler_moving_hitboxAttachTo: Attempt was made to attach an item to itself.");
  }

  attachToVisualElement.movingItemIsOverAttach.set(false);
  MouseActionState.get().moveOver_attachHitboxElement = null;

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  itemState.moveToNewParent(activeItem, attachToVisualElement.displayItem.id, RelationshipToParent.Attachment);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!);

  finalizeMouseUp();
  fullArrange(store);
}


function mouseUpHandler_moving_toOpaquePage(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  if (isTable(overContainerVe.displayItem)) { panic("mouseUpHandler_moving_toOpaquePage: over container is a table."); }

  const moveOverContainerId = overContainerVe.displayItem.id;
  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    panic("mouseUpHandler_moving_toOpaquePage: Attempt was made to move an item into itself.");
  }

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!);

  finalizeMouseUp();
  fullArrange(store);
}


function mouseUpHandler_moving_toTable(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const moveOverContainerId = overContainerVe.displayItem.id;
  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    panic("mouseUpHandler_moving_toTable: Attempt was made to move an item into itself.");
  }

  if (overContainerVe.moveOverColAttachmentNumber.get() >= 0) {
    mouseUpHandler_moving_toTable_attachmentCell(store, activeItem, overContainerVe);
    return;
  }

  const moveToOrdering = itemState.newOrderingAtChildrenPosition(moveOverContainerId, overContainerVe.moveOverRowNumber.get());
  itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child, moveToOrdering);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!);

  finalizeMouseUp();
  fullArrange(store);
}


function mouseUpHandler_moving_toTable_attachmentCell(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const tableItem = asTableItem(overContainerVe.displayItem);
  let rowNumber = overContainerVe.moveOverRowNumber.get();
  const yScrollPos = store.perItem.getTableScrollYPos(VeFns.veidFromVe(overContainerVe));
  if (rowNumber < yScrollPos) { rowNumber = yScrollPos; }

  const childId = tableItem.computed_children[rowNumber];
  const child = itemState.get(childId)!;

  const disaplyedChild = asAttachmentsItem(isLink(child)
    ? itemState.get(LinkFns.getLinkToId(asLinkItem(child)))!
    : child);
  const insertPosition = overContainerVe.moveOverColAttachmentNumber.get();

  const numPlaceholdersToCreate = insertPosition > disaplyedChild.computed_attachments.length ? insertPosition - disaplyedChild.computed_attachments.length : 0;
  for (let i=0; i<numPlaceholdersToCreate; ++i) {
    const placeholderItem = PlaceholderFns.create(activeItem.ownerId, disaplyedChild.id, RelationshipToParent.Attachment, itemState.newOrderingAtEndOfAttachments(disaplyedChild.id));
    itemState.add(placeholderItem);
    server.addItem(placeholderItem, null);
  }
  let newOrdering: Uint8Array | undefined;
  if (insertPosition < disaplyedChild.computed_attachments.length) {
    const overAttachmentId = disaplyedChild.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      newOrdering = placeholderToReplaceMaybe.ordering;
      itemState.delete(placeholderToReplaceMaybe.id);
      server.deleteItem(placeholderToReplaceMaybe.id);
    } else {
      // TODO (MEDIUM): probably want to forbid rather than insert in this case.
      newOrdering = itemState.newOrderingAtAttachmentsPosition(disaplyedChild.id, insertPosition);
    }
  } else {
    newOrdering = itemState.newOrderingAtAttachmentsPosition(disaplyedChild.id, insertPosition);
  }

  itemState.moveToNewParent(activeItem, disaplyedChild.id, RelationshipToParent.Attachment, newOrdering);
  serverOrRemote.updateItem(itemState.get(activeItem.id)!);

  finalizeMouseUp();
  fullArrange(store);
}


function finalizeMouseUp() {
  cleanupAndPersistPlaceholders();
  maybeDeleteComposite()
}


async function maybeDeleteComposite() {
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

  serverOrRemote.updateItem(child);
  server.deleteItem(compositeItem.id);
}


function cleanupAndPersistPlaceholders() {
  if (MouseActionState.empty()) { return; }
  if (MouseActionState.get().startAttachmentsItem == null) { return; }

  if (MouseActionState.get().newPlaceholderItem != null) {
    server.addItem(MouseActionState.get().newPlaceholderItem!, null);
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
    server.deleteItem(attachment.id);
    itemState.delete(attachment.id);
  }

  MouseActionState.get().newPlaceholderItem = null;
  MouseActionState.get().startAttachmentsItem = null;
}
