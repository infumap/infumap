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
import { asContainerItem, isContainer } from "../items/base/container-item";
import { Item } from "../items/base/item";
import { ItemFns } from "../items/base/item-polymorphism";
import { PositionalItem, asPositionalItem, isPositionalItem } from "../items/base/positional-item";
import { asXSizableItem, isXSizableItem } from "../items/base/x-sizeable-item";
import { asYSizableItem, isYSizableItem } from "../items/base/y-sizeable-item";
import { asCompositeItem, isComposite, CompositeFns } from "../items/composite-item";
import { FileFns, asFileItem, isFile } from "../items/file-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { ArrangeAlgorithm, PageFns, asPageItem, isPage } from "../items/page-item";
import { NoteFns, asNoteItem, isNote } from "../items/note-item";
import { PasswordFns, asPasswordItem, isPassword } from "../items/password-item";
import { FileFlags, NoteFlags, PasswordFlags } from "../items/base/flags-item";
import { isPlaceholder, PlaceholderFns } from "../items/placeholder-item";
import { TEMP_SEARCH_RESULTS_ORIGIN, isSearch } from "../items/search-item";
import { asTableItem, isTable } from "../items/table-item";
import { arrangeNow, requestArrange } from "../layout/arrange";
import { switchToPage } from "../layout/navigation";
import { HitboxFlags } from "../layout/hitbox";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VisualElement, VeFns, VisualElementFlags, veFlagIsRoot, EMPTY_VEID, isVeTranslucentPage } from "../layout/visual-element";
import { server, serverOrRemote } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { itemState } from "../store/ItemState";
import { panic } from "../util/lang";
import { HitInfoFns } from "./hit";
import { DoubleClickState, MouseAction, MouseActionState, UserSettingsMoveState, ClickState, CursorEventState, MoveRollbackSnapshotEntry } from "./state";
import { MouseEventActionFlags } from "./enums";
import { boundingBoxFromDOMRect, isInside } from "../util/geometry";
import { decodeCalendarCombinedIndex, calculateCalendarPosition } from "../util/calendar-layout";
import { ImageFns, asImageItem, isImage } from "../items/image-item";
import { mouseMove_handleNoButtonDown } from "./mouse_move";
import { calculateMoveToPagePositionGr, getGroupMoveEntriesInParent, moveGroupToChildParentPreservingOffsets } from "./move_group";
import { resolveInternalMoveTarget } from "./move_target";


interface MovePersistOperation {
  apply: () => Promise<void>,
  rollback?: () => Promise<void>,
}

interface MoveRollbackContext {
  snapshot: Array<MoveRollbackSnapshotEntry>,
  activeTreeItemId: string | null,
  newPlaceholderItemId: string | null,
  rollbackExtras: (() => void) | null,
}

interface MoveFinalizeContext {
  startAttachmentsItemId: string | null,
  startCompositeItemId: string | null,
  newPlaceholderItemId: string | null,
}

interface MoveCommitOptions {
  rollbackExtras?: (() => void) | null,
}


function pageArrangeAlgorithmForMoveDestination(item: PositionalItem, destinationVe?: VisualElement | null): string | null {
  const parentItem = itemState.get(item.parentId);
  if (parentItem == null || !isPage(parentItem)) {
    return null;
  }

  if (destinationVe != null && isPage(destinationVe.displayItem) && destinationVe.displayItem.id == item.parentId) {
    return destinationVe.linkItemMaybe?.overrideArrangeAlgorithm || asPageItem(destinationVe.displayItem).arrangeAlgorithm;
  }

  return asPageItem(parentItem).arrangeAlgorithm;
}

function movedItemShouldShowIcon(item: PositionalItem, destinationVe?: VisualElement | null): boolean {
  if (item.relationshipToParent != RelationshipToParent.Child) {
    return false;
  }

  const parentItem = itemState.get(item.parentId);
  if (parentItem == null) {
    return false;
  }
  if (isTable(parentItem)) {
    return true;
  }

  return pageArrangeAlgorithmForMoveDestination(item, destinationVe) == ArrangeAlgorithm.List;
}

function applyMovedIconDefaultMaybe(item: Item, destinationVe?: VisualElement | null): void {
  if (isNote(item)) {
    const note = asNoteItem(item);
    if (NoteFns.emoji(note) != null) {
      return;
    }
    if (movedItemShouldShowIcon(note, destinationVe)) {
      note.flags |= NoteFlags.ShowIcon;
    } else {
      note.flags &= ~NoteFlags.ShowIcon;
    }
    return;
  }

  if (isFile(item)) {
    const file = asFileItem(item);
    if (FileFns.emoji(file) != null) {
      return;
    }
    if (movedItemShouldShowIcon(file, destinationVe)) {
      file.flags |= FileFlags.ShowIcon;
    } else {
      file.flags &= ~FileFlags.ShowIcon;
    }
    return;
  }

  if (!isPassword(item)) {
    return;
  }
  const password = asPasswordItem(item);
  if (PasswordFns.emoji(password) != null) {
    return;
  }
  if (movedItemShouldShowIcon(password, destinationVe)) {
    password.flags |= PasswordFlags.ShowIcon;
  } else {
    password.flags &= ~PasswordFlags.ShowIcon;
  }
}

function updateFocusPageSelectionAndMaybeSwitchRoot(store: StoreContextModel, shouldSwitchRoot: boolean): void {
  const focusPagePath = store.history.getFocusPath();
  const focusPageVe = MouseActionState.readVisualElement(focusPagePath);
  if (!focusPageVe) { return; }

  const focusPageActualVeid = VeFns.veidFromItems(focusPageVe.displayItem, focusPageVe.actualLinkItemMaybe);
  const selectedVeid = store.perItem.getSelectedListPageItem(focusPageActualVeid);
  if (selectedVeid == EMPTY_VEID) {
    PageFns.setDefaultListPageSelectedItemMaybe(store, focusPageActualVeid);
  }

  if (shouldSwitchRoot) {
    PageFns.switchToOutermostListPageMaybe(focusPageVe, store);
  }
}

function maybeEditDocumentPageRowFromBackgroundClick(
  store: StoreContextModel,
  pageVe: VisualElement,
): boolean {
  if (!isPage(pageVe.displayItem) || asPageItem(pageVe.displayItem).arrangeAlgorithm != ArrangeAlgorithm.Document) {
    return false;
  }
  if (!pageVe.viewportBoundsPx || !pageVe.childAreaBoundsPx) { return false; }

  const pagePath = VeFns.veToPath(pageVe);
  const childVes = VesCache.render.getChildren(pagePath)();
  if (childVes.length == 0) { return false; }

  const viewportBoundsPx = VeFns.veViewportBoundsRelativeToDesktopPx(store, pageVe);
  const mouseDesktopPx = CursorEventState.getLatestDesktopPx(store);
  const pageVeid = VeFns.actualVeidFromVe(pageVe);
  const scrollYPx = store.perItem.getPageScrollYProp(pageVeid) *
    Math.max(pageVe.childAreaBoundsPx.h - pageVe.viewportBoundsPx.h, 0);
  const posInDocumentYPx = mouseDesktopPx.y - viewportBoundsPx.y + scrollYPx;

  if (posInDocumentYPx < 0 || posInDocumentYPx > pageVe.childAreaBoundsPx.h) {
    return false;
  }

  for (let i = 0; i < childVes.length; ++i) {
    const childVe = childVes[i].get();
    const prevChildVe = i > 0 ? childVes[i - 1].get() : null;
    const nextChildVe = i + 1 < childVes.length ? childVes[i + 1].get() : null;

    const bandTopPx = prevChildVe == null
      ? childVe.boundsPx.y
      : (prevChildVe.boundsPx.y + prevChildVe.boundsPx.h + childVe.boundsPx.y) / 2;
    const bandBottomPx = nextChildVe == null
      ? childVe.boundsPx.y + childVe.boundsPx.h
      : (childVe.boundsPx.y + childVe.boundsPx.h + nextChildVe.boundsPx.y) / 2;

    if (posInDocumentYPx < bandTopPx || posInDocumentYPx > bandBottomPx) { continue; }

    ItemFns.handleClick(childVes[i], null, HitboxFlags.Click, store);
    return true;
  }

  return false;
}

function focusSearchItemFromResultsBackgroundClickMaybe(
  store: StoreContextModel,
  activeVisualElement: VisualElement,
): boolean {
  if (!isPage(activeVisualElement.displayItem)) {
    return false;
  }
  if (activeVisualElement.displayItem.origin != TEMP_SEARCH_RESULTS_ORIGIN) {
    return false;
  }
  if (MouseActionState.getHitboxTypeOnMouseDown() != HitboxFlags.None) {
    return false;
  }
  if (!activeVisualElement.parentPath) {
    return false;
  }

  const searchVe = VesCache.current.readNode(activeVisualElement.parentPath);
  if (!searchVe || !isSearch(searchVe.displayItem)) {
    return false;
  }

  store.perItem.setSearchFocusedResultIndex(searchVe.displayItem.id, -1);
  store.history.setFocus(activeVisualElement.parentPath);
  arrangeNow(store, "mouse-up-focus-search-from-results-background");
  return true;
}

function showMoveDropRejectedMessage(store: StoreContextModel, text: string): void {
  store.overlay.toolbarTransientMessage.set({ text, type: TransientMessageType.Error });
  window.setTimeout(() => {
    const current = store.overlay.toolbarTransientMessage.get();
    if (current?.text == text) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, 1500);
}

function clearMoveOverState(store: StoreContextModel): void {
  const moveOverContainerPath = MouseActionState.getMoveOverContainerPath();
  if (moveOverContainerPath != null) {
    store.perVe.setMovingItemIsOver(moveOverContainerPath, false);
    store.perVe.setMoveOverChildContainerPath(moveOverContainerPath, null);
    store.perVe.setMoveOverRowNumber(moveOverContainerPath, -1);
    store.perVe.setMoveOverColAttachmentNumber(moveOverContainerPath, -1);
    MouseActionState.setMoveOverContainerPath(null);
  }

  const attachPath = MouseActionState.getMoveOverAttachHitboxPath();
  if (attachPath != null) {
    store.perVe.setMovingItemIsOverAttach(attachPath, false);
    store.perVe.setMoveOverAttachmentIndex(attachPath, -1);
    MouseActionState.setMoveOverAttachHitboxPath(null);
  }

  const attachCompositePath = MouseActionState.getMoveOverAttachCompositePath();
  if (attachCompositePath != null) {
    store.perVe.setMovingItemIsOverAttachComposite(attachCompositePath, false);
    MouseActionState.setMoveOverAttachCompositePath(null);
  }
}

function cloneItemSnapshot<T extends Item>(item: T): T {
  return ItemFns.fromObject(ItemFns.toObject(item), item.origin ?? null) as T;
}

function enqueueUpdateItem(
  ops: Array<MovePersistOperation>,
  store: StoreContextModel,
  item: Item,
  rollbackSnapshot?: Item | null,
  iconMoveDestinationVe?: VisualElement | null,
): void {
  applyMovedIconDefaultMaybe(item, iconMoveDestinationVe);
  const snapshot = cloneItemSnapshot(item);
  ops.push({
    apply: () => serverOrRemote.updateItem(snapshot, store.general.networkStatus, false),
    rollback: rollbackSnapshot == null
      ? undefined
      : () => serverOrRemote.updateItem(cloneItemSnapshot(rollbackSnapshot), store.general.networkStatus, false),
  });
}

function enqueueAddItem(ops: Array<MovePersistOperation>, store: StoreContextModel, item: Item): void {
  const snapshot = cloneItemSnapshot(item);
  ops.push({
    apply: () => server.addItem(snapshot, null, store.general.networkStatus).then(() => undefined),
    rollback: () => server.deleteItem(snapshot.id, store.general.networkStatus, false),
  });
}

function enqueueDeleteItem(
  ops: Array<MovePersistOperation>,
  store: StoreContextModel,
  id: string,
  rollbackSnapshot?: Item | null,
): void {
  ops.push({
    apply: () => server.deleteItem(id, store.general.networkStatus, false),
    rollback: rollbackSnapshot == null
      ? undefined
      : () => server.addItem(cloneItemSnapshot(rollbackSnapshot), null, store.general.networkStatus).then(() => undefined),
  });
}

function enqueuePersistMovedItems(
  ops: Array<MovePersistOperation>,
  store: StoreContextModel,
  defaultIds: string[],
  iconMoveDestinationVe?: VisualElement | null,
): void {
  const group = MouseActionState.getGroupMoveItems();
  const ids = group && group.length > 0
    ? group.map(g => g.veid.linkIdMaybe ? g.veid.linkIdMaybe : g.veid.itemId)
    : defaultIds;

  for (const id of ids) {
    const item = itemState.get(id);
    if (item != null) {
      enqueueUpdateItem(ops, store, item, null, iconMoveDestinationVe);
    }
  }
}

function captureMoveRollbackContext(rollbackExtras: (() => void) | null = null): MoveRollbackContext {
  const activeElementPath = MouseActionState.getActiveElementPath();
  return {
    snapshot: (MouseActionState.getMoveRollback() ?? []).map(entry => ({
      ...entry,
      ordering: new Uint8Array(entry.ordering),
      spatialPositionGr: { ...entry.spatialPositionGr },
    })),
    activeTreeItemId: activeElementPath != null
      ? (() => {
        const veid = VeFns.veidFromPath(activeElementPath);
        return veid.linkIdMaybe ?? veid.itemId;
      })()
      : null,
    newPlaceholderItemId: MouseActionState.getNewPlaceholderItem()?.id ?? null,
    rollbackExtras,
  };
}

function captureMoveFinalizeContext(): MoveFinalizeContext {
  return {
    startAttachmentsItemId: MouseActionState.getStartAttachmentsItem()?.id ?? null,
    startCompositeItemId: MouseActionState.getStartCompositeItem()?.id ?? null,
    newPlaceholderItemId: MouseActionState.getNewPlaceholderItem()?.id ?? null,
  };
}

function rollbackMove(store: StoreContextModel, context: MoveRollbackContext, deleteCreatedTreeItemOnServer: boolean = true): void {
  const rollbackIds = new Set(context.snapshot.map(entry => entry.id));
  if (context.activeTreeItemId != null && !rollbackIds.has(context.activeTreeItemId) && itemState.get(context.activeTreeItemId) != null) {
    itemState.delete(context.activeTreeItemId);
    if (deleteCreatedTreeItemOnServer) {
      void server.deleteItem(context.activeTreeItemId, store.general.networkStatus, false).catch((error) => {
        console.error("Rollback cleanup failed while deleting dragged item:", error);
      });
    }
  }

  if (context.newPlaceholderItemId != null && itemState.get(context.newPlaceholderItemId) != null) {
    itemState.delete(context.newPlaceholderItemId);
  }

  const parentsToSort = new Set<string>();
  for (const entry of context.snapshot) {
    const itemMaybe = itemState.get(entry.id);
    if (!itemMaybe || !isPositionalItem(itemMaybe)) { continue; }
    const item = asPositionalItem(itemMaybe);
    parentsToSort.add(item.parentId);
    parentsToSort.add(entry.parentId);

    item.spatialPositionGr = { ...entry.spatialPositionGr };
    item.dateTime = entry.dateTime;
    if (entry.iconFlags != null && isNote(item)) {
      asNoteItem(item).flags = entry.iconFlags;
    } else if (entry.iconFlags != null && isFile(item)) {
      asFileItem(item).flags = entry.iconFlags;
    } else if (entry.iconFlags != null && isPassword(item)) {
      asPasswordItem(item).flags = entry.iconFlags;
    }

    if (item.parentId != entry.parentId || item.relationshipToParent != entry.relationshipToParent) {
      itemState.moveToNewParent(item, entry.parentId, entry.relationshipToParent, new Uint8Array(entry.ordering));
    } else {
      item.ordering = new Uint8Array(entry.ordering);
    }
  }

  for (const parentId of parentsToSort) {
    const parent = itemState.get(parentId);
    if (!parent) { continue; }
    if (isContainer(parent)) {
      itemState.sortChildren(parentId);
    }
    if ("computed_attachments" in parent) {
      itemState.sortAttachments(parentId);
    }
  }
}

function restorePositionalItemSnapshot(snapshot: PositionalItem): void {
  const itemMaybe = itemState.get(snapshot.id);
  if (itemMaybe == null) {
    itemState.add(cloneItemSnapshot(snapshot));
    return;
  }
  if (!isPositionalItem(itemMaybe)) {
    return;
  }

  const item = asPositionalItem(itemMaybe);
  const currentParentId = item.parentId;
  item.spatialPositionGr = { ...snapshot.spatialPositionGr };
  item.dateTime = snapshot.dateTime;

  if (item.parentId != snapshot.parentId || item.relationshipToParent != snapshot.relationshipToParent) {
    itemState.moveToNewParent(item, snapshot.parentId, snapshot.relationshipToParent, new Uint8Array(snapshot.ordering));
  } else {
    item.ordering = new Uint8Array(snapshot.ordering);
  }

  if (snapshot.relationshipToParent == RelationshipToParent.Child) {
    itemState.sortChildren(snapshot.parentId);
    if (currentParentId != snapshot.parentId) {
      const prevParent = itemState.get(currentParentId);
      if (prevParent != null && isContainer(prevParent)) {
        itemState.sortChildren(currentParentId);
      }
    }
  } else if (snapshot.relationshipToParent == RelationshipToParent.Attachment) {
    itemState.sortAttachments(snapshot.parentId);
    if (currentParentId != snapshot.parentId) {
      const prevParent = itemState.get(currentParentId);
      if (prevParent != null && "computed_attachments" in prevParent) {
        itemState.sortAttachments(currentParentId);
      }
    }
  }
}

function restoreDeletedItemSnapshot(snapshot: Item): void {
  if (itemState.get(snapshot.id) != null) {
    return;
  }
  itemState.add(cloneItemSnapshot(snapshot));
}

function deleteCreatedItemIfPresent(id: string): void {
  if (itemState.get(id) != null) {
    itemState.delete(id);
  }
}

function placeholderRollbackSnapshotMaybe(placeholder: Item): Item | null {
  const newPlaceholderId = MouseActionState.getNewPlaceholderItem()?.id ?? null;
  if (placeholder.id == newPlaceholderId) {
    return null;
  }
  return cloneItemSnapshot(placeholder);
}

function rollbackInvalidMove(store: StoreContextModel): void {
  clearMoveOverState(store);
  rollbackMove(store, captureMoveRollbackContext());
  MouseActionState.setNewPlaceholderItem(null);
  MouseActionState.setStartAttachmentsItem(null);
  MouseActionState.setMoveRollback(null);
}

function buildCleanupPersistedPlaceholderOperations(
  ops: Array<MovePersistOperation>,
  store: StoreContextModel,
  finalizeContext: MoveFinalizeContext,
): void {
  const parentId = finalizeContext.startAttachmentsItemId;
  if (parentId == null) {
    return;
  }

  const newPlaceholderItem = finalizeContext.newPlaceholderItemId != null
    ? itemState.get(finalizeContext.newPlaceholderItemId)
    : null;
  if (newPlaceholderItem != null) {
    const snapshot = cloneItemSnapshot(newPlaceholderItem);
    ops.push({
      apply: () => server.addItem(snapshot, null, store.general.networkStatus).then(() => undefined),
      rollback: async () => {
        await server.deleteItem(snapshot.id, store.general.networkStatus, false);
      },
    });
  }

  const placeholderParent = itemState.getAsAttachmentsItem(parentId);
  if (placeholderParent == null) {
    return;
  }

  const placeholderSnapshotsToDelete: Array<Item> = [];
  for (let i = placeholderParent.computed_attachments.length - 1; i >= 0; --i) {
    const attachmentId = placeholderParent.computed_attachments[i];
    const attachment = itemState.get(attachmentId);
    if (attachment == null) { panic("buildCleanupPersistedPlaceholderOperations: no attachment."); }
    if (!isPlaceholder(attachment)) {
      break;
    }
    placeholderSnapshotsToDelete.push(cloneItemSnapshot(attachment));
  }

  for (const placeholderSnapshot of placeholderSnapshotsToDelete) {
    ops.push({
      apply: async () => {
        await server.deleteItem(placeholderSnapshot.id, store.general.networkStatus, false);
        if (itemState.get(placeholderSnapshot.id) != null) {
          itemState.delete(placeholderSnapshot.id);
        }
      },
      rollback: async () => {
        restoreDeletedItemSnapshot(placeholderSnapshot);
        await server.addItem(cloneItemSnapshot(placeholderSnapshot), null, store.general.networkStatus).then(() => undefined);
      },
    });
  }
}

function buildCleanupCollapsedCompositeOperations(
  ops: Array<MovePersistOperation>,
  store: StoreContextModel,
  finalizeContext: MoveFinalizeContext,
): void {
  const compositeId = finalizeContext.startCompositeItemId;
  if (compositeId == null) {
    return;
  }

  const compositeItemMaybe = itemState.get(compositeId);
  if (compositeItemMaybe == null || !isComposite(compositeItemMaybe)) {
    return;
  }

  const compositeItem = asCompositeItem(compositeItemMaybe);
  if (compositeItem.computed_children.length == 0) {
    panic("buildCleanupCollapsedCompositeOperations: composite has no children.");
  }
  if (compositeItem.computed_children.length != 1) {
    return;
  }

  const child = itemState.get(compositeItem.computed_children[0]);
  if (itemState.getAsContainerItem(compositeItem.parentId) == null || child == null || !isPositionalItem(child)) {
    return;
  }

  const compositeSnapshot = cloneItemSnapshot(compositeItem);
  const childOriginalSnapshot = asPositionalItem(cloneItemSnapshot(child));
  const childSnapshot = asPositionalItem(cloneItemSnapshot(child));
  childSnapshot.parentId = compositeItem.parentId;
  childSnapshot.spatialPositionGr = { ...compositeItem.spatialPositionGr };
  childSnapshot.ordering = new Uint8Array(compositeItem.ordering);
  applyMovedIconDefaultMaybe(childSnapshot);
  ops.push({
    apply: async () => {
      await serverOrRemote.updateItem(childSnapshot, store.general.networkStatus, false);
      await server.deleteItem(compositeItem.id, store.general.networkStatus, false);
      asPositionalItem(child).spatialPositionGr = { ...compositeItem.spatialPositionGr };
      itemState.moveToNewParent(child, compositeItem.parentId, RelationshipToParent.Child, new Uint8Array(compositeItem.ordering));
      applyMovedIconDefaultMaybe(child);
      itemState.delete(compositeItem.id);
    },
    rollback: async () => {
      if (itemState.get(compositeSnapshot.id) == null) {
        const compositeRestore = asCompositeItem(cloneItemSnapshot(compositeSnapshot));
        compositeRestore.computed_children = [];
        itemState.add(compositeRestore);
      }
      restorePositionalItemSnapshot(childOriginalSnapshot);
      await server.addItem(cloneItemSnapshot(compositeSnapshot), null, store.general.networkStatus).then(() => undefined);
      await serverOrRemote.updateItem(cloneItemSnapshot(childOriginalSnapshot), store.general.networkStatus, false);
    },
  });
}

function buildFinalizeMoveOperations(
  store: StoreContextModel,
  finalizeContext: MoveFinalizeContext,
): Array<MovePersistOperation> {
  const ops: Array<MovePersistOperation> = [];
  buildCleanupPersistedPlaceholderOperations(ops, store, finalizeContext);
  buildCleanupCollapsedCompositeOperations(ops, store, finalizeContext);
  return ops;
}

function describeRollbackError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error == "string") {
    return error;
  }
  return String(error);
}

function panicCatastrophicMoveRollback(
  store: StoreContextModel,
  originalError: unknown,
  rollbackFailures: Array<string>,
): never {
  const firstFailure = rollbackFailures[0] ?? "unknown rollback failure";
  const extraFailureCount = Math.max(rollbackFailures.length - 1, 0);
  const failureSummary = extraFailureCount > 0
    ? `${firstFailure} (+${extraFailureCount} more)`
    : firstFailure;
  const panicMessage = `Move rollback failed after a server mutation partially succeeded. Restart required. ${failureSummary}`;
  console.error("Catastrophic move rollback failure.", { originalError, rollbackFailures });
  store.overlay.toolbarTransientMessage.set(null);
  store.overlay.isPanicked.set(true);
  panic(panicMessage);
}

async function rollbackAppliedOperations(appliedOps: Array<MovePersistOperation>): Promise<Array<string>> {
  const failures: Array<string> = [];
  for (let i = appliedOps.length - 1; i >= 0; --i) {
    const rollback = appliedOps[i].rollback;
    if (!rollback) {
      continue;
    }
    try {
      await rollback();
    } catch (error) {
      console.error("Move rollback operation failed.", error);
      failures.push(`rollback operation ${i + 1}: ${describeRollbackError(error)}`);
    }
  }
  return failures;
}

async function rollbackMoveServerState(
  store: StoreContextModel,
  rollbackContext: MoveRollbackContext,
): Promise<Array<string>> {
  const failures: Array<string> = [];
  if (rollbackContext.activeTreeItemId != null && itemState.get(rollbackContext.activeTreeItemId) == null) {
    try {
      await server.deleteItem(rollbackContext.activeTreeItemId, store.general.networkStatus, false);
    } catch (error) {
      console.error("Rollback failed while deleting created dragged item on server.", error);
      failures.push(`delete created dragged item '${rollbackContext.activeTreeItemId}': ${describeRollbackError(error)}`);
    }
  }

  for (const entry of rollbackContext.snapshot) {
    const item = itemState.get(entry.id);
    if (item == null) {
      continue;
    }
    try {
      await serverOrRemote.updateItem(cloneItemSnapshot(item), store.general.networkStatus, false);
    } catch (error) {
      console.error(`Rollback failed while restoring item '${entry.id}' on the server.`, error);
      failures.push(`restore item '${entry.id}' on server: ${describeRollbackError(error)}`);
    }
  }
  return failures;
}

async function commitMoveOperations(
  store: StoreContextModel,
  ops: Array<MovePersistOperation>,
  rollbackContext: MoveRollbackContext,
  postCommitArrangeReason: string,
): Promise<void> {
  const appliedOps: Array<MovePersistOperation> = [];
  try {
    for (const op of ops) {
      await op.apply();
      appliedOps.push(op);
    }
    // Finalize operations can mutate local state asynchronously after the
    // immediate mouse-up arrange has already completed.
    requestArrange(store, postCommitArrangeReason);
  } catch (error) {
    console.error("Move commit failed; rolling back local state.", error);
    const rollbackFailures = await rollbackAppliedOperations(appliedOps);
    try {
      rollbackMove(store, rollbackContext, false);
    } catch (rollbackError) {
      console.error("Local move rollback failed.", rollbackError);
      rollbackFailures.push(`restore local move state: ${describeRollbackError(rollbackError)}`);
    }
    try {
      rollbackContext.rollbackExtras?.();
    } catch (rollbackError) {
      console.error("Local rollback extras failed.", rollbackError);
      rollbackFailures.push(`restore local move side effects: ${describeRollbackError(rollbackError)}`);
    }
    rollbackFailures.push(...await rollbackMoveServerState(store, rollbackContext));
    if (rollbackFailures.length > 0) {
      panicCatastrophicMoveRollback(store, error, rollbackFailures);
    }
    showMoveDropRejectedMessage(store, "Couldn't save move. Restored original location.");
    arrangeNow(store, "mouse-up-rollback-server-failure");
    return;
  }
}

function scheduleMoveCommit(
  store: StoreContextModel,
  ops: Array<MovePersistOperation>,
  arrangeReason: string,
  options?: MoveCommitOptions,
): void {
  const rollbackContext = captureMoveRollbackContext(options?.rollbackExtras ?? null);
  const finalizeContext = captureMoveFinalizeContext();
  const finalOps = [...ops, ...buildFinalizeMoveOperations(store, finalizeContext)];
  MouseActionState.set(null);
  arrangeNow(store, arrangeReason);
  void commitMoveOperations(store, finalOps, rollbackContext, `${arrangeReason}-post-commit`);
}

function movingIgnoreIds(activeVisualElement: VisualElement): Array<string> {
  const ignoreIds = [activeVisualElement.displayItem.id];
  if (isComposite(activeVisualElement.displayItem)) {
    const compositeItem = asCompositeItem(activeVisualElement.displayItem);
    for (const childId of compositeItem.computed_children) {
      ignoreIds.push(childId);
      const item = itemState.get(childId);
      if (isLink(item)) {
        ignoreIds.push(LinkFns.getLinkToId(asLinkItem(item!)));
      }
    }
  }
  return ignoreIds;
}

function shouldRejectCurrentDropTarget(store: StoreContextModel): boolean {
  const activeVisualElement = MouseActionState.getActiveVisualElement();
  if (!activeVisualElement) {
    return false;
  }

  const ignoreIds = movingIgnoreIds(activeVisualElement);
  const hitInfo = HitInfoFns.hit(
    store,
    CursorEventState.getLatestDesktopPx(store),
    ignoreIds,
    MouseActionState.usesEmbeddedInteractiveHitTesting(),
    false,
  );
  return resolveInternalMoveTarget(hitInfo, ignoreIds).validity != "valid";
}


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
  if (MouseActionState.empty()) {
    // Allow native controls (sliders, form inputs, etc.) to handle mouseup normally when nothing is being dragged.
    return MouseEventActionFlags.None;
  }

  const activeVisualElementSignal = MouseActionState.getActiveVisualElementSignal();
  if (!activeVisualElementSignal) {
    store.anItemIsResizing.set(false);
    store.anItemIsMoving.set(false);
    return MouseEventActionFlags.PreventDefault;
  }
  const activeVisualElement = activeVisualElementSignal.get();
  const activeItem = asPositionalItem(VeFns.treeItem(activeVisualElement));

  switch (MouseActionState.getAction()) {
    case MouseAction.Moving:
      DoubleClickState.preventDoubleClick();
      mouseUpHandler_moving_groupAware(store, activeItem);
      break;

    case MouseAction.MovingPopup: {
      if (MouseActionState.hitboxTypeIncludes(HitboxFlags.AnchorChild)) {
        DoubleClickState.preventDoubleClick();
        if (isPage(activeVisualElement.displayItem)) {
          PageFns.handleAnchorChildClick(activeVisualElement, store);
        } else if (isImage(activeVisualElement.displayItem)) {
          const imageItem = asImageItem(activeVisualElement.displayItem);
          const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
          const parentPage = asPageItem(parentVe.displayItem);
          ImageFns.handleAnchorChildClick(imageItem, parentPage, store);
          serverOrRemote.updateItem(imageItem, store.general.networkStatus);
        }
        break;
      }
      if (MouseActionState.hitboxTypeIncludes(HitboxFlags.AnchorDefault)) {
        DoubleClickState.preventDoubleClick();
        if (isPage(activeVisualElement.displayItem)) {
          PageFns.handleAnchorDefaultClick(activeVisualElement, store);
        } else if (isImage(activeVisualElement.displayItem)) {
          const imageItem = asImageItem(activeVisualElement.displayItem);
          const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
          const parentPage = asPageItem(parentVe.displayItem);
          ImageFns.handleHomeClick(imageItem, parentPage, store, serverOrRemote);
        }
        break;
      }
      DoubleClickState.preventDoubleClick();
      break;
    }

    case MouseAction.Resizing:
      DoubleClickState.preventDoubleClick();
      const xsized = isLink(activeItem)
        ? MouseActionState.getStartWidthBl()! * GRID_SIZE != asLinkItem(activeItem).spatialWidthGr
        : MouseActionState.getStartWidthBl()! * GRID_SIZE != asXSizableItem(activeItem).spatialWidthGr;
      if (xsized ||
        (isYSizableItem(activeItem) && MouseActionState.getStartHeightBl()! * GRID_SIZE != asYSizableItem(activeItem).spatialHeightGr) ||
        (isNote(activeItem) && (asNoteItem(activeItem).flags & NoteFlags.ExplicitHeight) && MouseActionState.getStartHeightBl()! * GRID_SIZE != asNoteItem(activeItem).spatialHeightGr) ||
        (isLink(activeItem) && (isYSizableItem(activeVisualElement.displayItem) || isNote(activeVisualElement.displayItem)))) {
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
      const hitMeta = MouseActionState.getHitMeta()!;
      const widthGr = activeVisualElement.linkItemMaybe == null
        ? asTableItem(activeItem).tableColumns[hitMeta.colNum!].widthGr
        : asTableItem(activeVisualElement.displayItem).tableColumns[hitMeta.colNum!].widthGr;
      if (MouseActionState.getStartWidthBl()! * GRID_SIZE != widthGr) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.ResizingDock:
      if (store.getCurrentDockWidthPx() == 0) {
        store.dockVisible.set(false);
        store.setDockWidthPx(MouseActionState.getStartWidthBl()! * NATURAL_BLOCK_SIZE_PX.w);
      } else {
        store.dockVisible.set(true);
      }
      break;

    case MouseAction.ResizingDockItem:
      DoubleClickState.preventDoubleClick();
      if (MouseActionState.getStartChildAreaBoundsPx()!.h != activeVisualElement.childAreaBoundsPx!.h) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.ResizingListPageColumn:
      const newWidthGr = asPageItem(activeVisualElement.displayItem).tableColumns[0].widthGr;
      if (MouseActionState.getStartWidthBl()! * GRID_SIZE != newWidthGr) {
        serverOrRemote.updateItem(itemState.get(activeVisualElement.displayItem.id)!, store.general.networkStatus);
      }
      break;

    case MouseAction.ResizingCalendarMonth:
      document.body.style.cursor = "";
      mouseMove_handleNoButtonDown(store, store.user.getUserMaybe() != null);
      DoubleClickState.preventDoubleClick();
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
            arrangeNow(store, "mouse-up-clear-multi-selection");
          }
        }
      }

      if (MouseActionState.hitboxTypeIncludes(HitboxFlags.AnchorChild)) {
        DoubleClickState.preventDoubleClick();
        if (isPage(activeVisualElement.displayItem)) {
          PageFns.handleAnchorChildClick(activeVisualElement, store);
        } else if (isImage(activeVisualElement.displayItem)) {
          const imageItem = asImageItem(activeVisualElement.displayItem);
          const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
          const parentPage = asPageItem(parentVe.displayItem);
          ImageFns.handleAnchorChildClick(imageItem, parentPage, store);
          serverOrRemote.updateItem(imageItem, store.general.networkStatus);
        }

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.AnchorDefault)) {
        DoubleClickState.preventDoubleClick();
        if (isPage(activeVisualElement.displayItem)) {
          PageFns.handleAnchorDefaultClick(activeVisualElement, store);
        } else if (isImage(activeVisualElement.displayItem)) {
          const imageItem = asImageItem(activeVisualElement.displayItem);
          const parentVe = MouseActionState.readVisualElement(activeVisualElement.parentPath)!;
          const parentPage = asPageItem(parentVe.displayItem);
          ImageFns.handleHomeClick(imageItem, parentPage, store, serverOrRemote);
        }

      } else if (isLink(activeVisualElement.displayItem) &&
        asLinkItem(activeVisualElement.displayItem).linkRequiresRemoteLogin &&
        !MouseActionState.hitboxTypeIncludes(HitboxFlags.TriangleLinkSettings)) {
        DoubleClickState.preventDoubleClick();
        const linkItem = asLinkItem(activeVisualElement.displayItem);
        const linkFocusPath = VeFns.addVeidToPath(
          { itemId: linkItem.id, linkIdMaybe: null },
          activeVisualElement.parentPath!
        );
        store.overlay.remoteLoginInfo.set({
          host: linkItem.linkRequiresRemoteLogin!,
          linkId: linkItem.id,
          linkPath: linkFocusPath,
        });

      } else if (isLink(activeVisualElement.displayItem) &&
        !MouseActionState.hitboxTypeIncludes(HitboxFlags.TriangleLinkSettings) &&
        ClickState.getLinkWasClicked()) {
        const linkItem = asLinkItem(activeVisualElement.displayItem);
        const linkFocusPath = VeFns.addVeidToPath(
          { itemId: linkItem.id, linkIdMaybe: null },
          activeVisualElement.parentPath!
        );
        store.history.setFocus(linkFocusPath);
        arrangeNow(store, "mouse-up-focus-link");

      } else if (ClickState.getLinkWasClicked()) {
        if (isPage(activeVisualElement.displayItem) ||
          isNote(activeVisualElement.displayItem) ||
          isImage(activeVisualElement.displayItem) ||
          isFile(activeVisualElement.displayItem)) {
          ItemFns.handleLinkClick(activeVisualElement, store);
        } else {
          ItemFns.handleClick(activeVisualElementSignal, MouseActionState.getHitMeta(), MouseActionState.getHitboxTypeOnMouseDown(), store);
        }

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.TriangleLinkSettings)) {
        const focusPath = VeFns.addVeidToPath(
          { itemId: VeFns.veidFromPath(MouseActionState.getActiveElementPath()!).linkIdMaybe!, linkIdMaybe: null },
          VeFns.parentPath(MouseActionState.getActiveElementPath()!)
        );
        store.history.setFocus(focusPath);

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.TableColumnContextMenu)) {
        const hitMeta = MouseActionState.getHitMeta();
        store.overlay.tableColumnContextMenuInfo.set({
          posPx: CursorEventState.getLatestDesktopPx(store),
          tablePath: MouseActionState.getActiveElementPath()!,
          colNum: hitMeta?.colNum ? hitMeta.colNum : 0,
        });

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.Expand)) {
        store.perVe.setIsExpanded(
          MouseActionState.getActiveElementPath()!,
          !store.perVe.getIsExpanded(MouseActionState.getActiveElementPath()!)
        );
        arrangeNow(store, "mouse-up-toggle-expand");

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.OpenPopup)) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleOpenPopupClick(activeVisualElement, store, false, MouseActionState.getStartPx()!);

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.OpenAttachment)) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleOpenPopupClick(activeVisualElement, store, true, MouseActionState.getStartPx()!);

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.CalendarOverflow)) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleCalendarOverflowClick(activeVisualElement, store, MouseActionState.getHitMeta());

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.Click)) {
        DoubleClickState.preventDoubleClick();
        ItemFns.handleClick(activeVisualElementSignal, MouseActionState.getHitMeta(), MouseActionState.getHitboxTypeOnMouseDown(), store);

      } else if (MouseActionState.hitboxTypeIncludes(HitboxFlags.ShiftLeft)) {
        DoubleClickState.preventDoubleClick();
        PageFns.handleShiftLeftClick(activeVisualElement, store);

      } else {
        const activeRootVe = MouseActionState.readActiveRoot()!;

        if (focusSearchItemFromResultsBackgroundClickMaybe(store, activeVisualElement)) {
          DoubleClickState.preventDoubleClick();

        } else if (veFlagIsRoot(activeRootVe.flags & VisualElementFlags.EmbeddedInteractiveRoot) &&
        !MouseActionState.hitboxTypeIncludes(HitboxFlags.Move)) {
          DoubleClickState.preventDoubleClick();
          ItemFns.handleClick(activeVisualElementSignal, MouseActionState.getHitMeta(), MouseActionState.getHitboxTypeOnMouseDown(), store);

        } else if (veFlagIsRoot(activeRootVe.flags) &&
        !(activeRootVe.flags & VisualElementFlags.IsDock) &&
        ((VeFns.veidFromVe(activeRootVe).itemId != store.history.currentPageVeid()!.itemId) ||
          (VeFns.veidFromVe(activeRootVe).linkIdMaybe != store.history.currentPageVeid()!.linkIdMaybe)) &&
        (CursorEventState.getLatestDesktopPx(store).y > 0)) {
          DoubleClickState.preventDoubleClick();
          store.history.setFocus(MouseActionState.getActiveElementPath()!);
          updateFocusPageSelectionAndMaybeSwitchRoot(
            store,
            !(isPage(activeVisualElement.displayItem) && (activeVisualElement.flags & VisualElementFlags.ListPageRoot)),
          );

          // console.log("(1) setting focus to", MouseActionState.get().activeElementPath);
          arrangeNow(store, "mouse-up-focus-noncurrent-root");

        } else if (maybeEditDocumentPageRowFromBackgroundClick(store, activeVisualElement)) {
          DoubleClickState.preventDoubleClick();
          arrangeNow(store, "mouse-up-edit-document-row-from-background");

        } else if (activeVisualElementSignal.get().flags & VisualElementFlags.Popup) {
          DoubleClickState.preventDoubleClick();
          ItemFns.handleClick(activeVisualElementSignal, MouseActionState.getHitMeta(), MouseActionState.getHitboxTypeOnMouseDown(), store);
          arrangeNow(store, "mouse-up-click-popup");

        } else if (activeVisualElementSignal.get().flags & VisualElementFlags.IsDock) {
          DoubleClickState.preventDoubleClick();

        } else {
          if (isComposite(activeVisualElement.displayItem) || isPlaceholder(activeVisualElement.displayItem)) {
            // noop.

          } else {
            store.history.setFocus(MouseActionState.getActiveElementPath()!);
            updateFocusPageSelectionAndMaybeSwitchRoot(store, true);

            // console.log("(2) setting focus to", MouseActionState.get().activeElementPath);
            arrangeNow(store, "mouse-up-focus-item");
          }
        }
      }

      break;

    default:
      panic(`mouseUpHandler: unknown action ${MouseActionState.getAction()}.`);
  }

  ClickState.setLinkWasClicked(false);
  MouseActionState.set(null);

  return MouseEventActionFlags.PreventDefault;
}


function mouseUpHandler_moving_groupAware(store: StoreContextModel, activeItem: PositionalItem) {
  if (shouldRejectCurrentDropTarget(store)) {
    rollbackInvalidMove(store);
    showMoveDropRejectedMessage(store, "Can't drop here.");
    MouseActionState.set(null);
    arrangeNow(store, "mouse-up-reject-invalid-drop-target");
    return;
  }

  if (MouseActionState.getMoveOverContainerPath() != null) {
    store.perVe.setMovingItemIsOver(MouseActionState.getMoveOverContainerPath()!, false);
  }

  if (MouseActionState.getMoveOverAttachHitboxPath() != null) {
    mouseUpHandler_moving_hitboxAttachTo(store, activeItem);
    return;
  }

  if (MouseActionState.getMoveOverAttachCompositePath() != null) {
    mouseUpHandler_moving_hitboxAttachToComposite(store, activeItem);
    return;
  }

  const overContainerVe = MouseActionState.readMoveOverContainer();
  if (overContainerVe == null) {
    rollbackInvalidMove(store);
    MouseActionState.set(null);
    arrangeNow(store, "mouse-up-finish-move-no-target");
    return;
  }
  if (isTable(overContainerVe.displayItem)) {
    mouseUpHandler_moving_toTable(store, activeItem, overContainerVe);
    return;
  }
  if (isComposite(overContainerVe.displayItem)) {
    mouseUpHandler_moving_toComposite(store, activeItem, overContainerVe);
    return;
  }

  if (overContainerVe.displayItem.id != activeItem.parentId) {
    if (isPage(overContainerVe.displayItem)) {
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
        const ops: Array<MovePersistOperation> = [];
        enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
        scheduleMoveCommit(store, ops, "mouse-up-move-to-calendar-page");
        return;
      } else if (targetPageItem.arrangeAlgorithm == ArrangeAlgorithm.Document ||
        targetPageItem.arrangeAlgorithm == ArrangeAlgorithm.Catalog) {
        mouseUpHandler_moving_toOrderedPage(store, activeItem, overContainerVe);
        return;
      } else {
        mouseUpHandler_moving_toOpaquePage(store, activeItem, overContainerVe);
        return;
      }
    } else if (isContainer(overContainerVe.displayItem)) {
      mouseUpHandler_moving_toOpaquePage(store, activeItem, overContainerVe);
      return;
    }
  }

  // root page

  const ops: Array<MovePersistOperation> = [];
  if (isPage(overContainerVe.displayItem)) {
    const pageItem = asPageItem(overContainerVe.displayItem);
    if (overContainerVe.flags & VisualElementFlags.IsDock) {
      const ip = store.perVe.getMoveOverIndexAndPosition(VeFns.veToPath(overContainerVe));
      activeItem.ordering = itemState.newOrderingAtChildrenPosition(pageItem.id, ip.index, activeItem.id);
      itemState.sortChildren(pageItem.id);
      enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
    }
    else if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.Grid ||
      pageItem.arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
      pageItem.arrangeAlgorithm == ArrangeAlgorithm.List ||
      pageItem.arrangeAlgorithm == ArrangeAlgorithm.Justified ||
      pageItem.arrangeAlgorithm == ArrangeAlgorithm.Document) {
      mouseUpHandler_moving_toOrderedPage(store, activeItem, overContainerVe);
      return;
    } else if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) {
      const startPosBl = MouseActionState.getStartPosBl()!;
      if (startPosBl.x * GRID_SIZE != activeItem.spatialPositionGr.x ||
        startPosBl.y * GRID_SIZE != activeItem.spatialPositionGr.y) {
        enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
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
        enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!, null, overContainerVe);
      }
    }
    else {
      console.debug("todo: explicitly consider other page types here.");
      enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!, null, overContainerVe);
    }
  } else {
    // Not over a page; persist moved items (including group) if any
    enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
  }

  scheduleMoveCommit(store, ops, "mouse-up-finish-move");
}

function moveSelectedGroupToOpaquePageMaybe(
  store: StoreContextModel,
  activeItem: PositionalItem,
  overContainerVe: VisualElement,
): boolean {
  if (!isPage(overContainerVe.displayItem)) { return false; }

  const activeVe = MouseActionState.getActiveVisualElement();
  if (!activeVe) { return false; }

  const sourceParentId = activeItem.parentId;
  const { activePosGr } = calculateMoveToPagePositionGr(
    store,
    overContainerVe,
    CursorEventState.getLatestDesktopPx(store),
    activeItem,
    RelationshipToParent.Child,
    MouseActionState.getClickOffsetProp(),
  );

  return moveGroupToChildParentPreservingOffsets(
    MouseActionState.getGroupMoveItems(),
    VeFns.veidFromVe(activeVe),
    sourceParentId,
    overContainerVe.displayItem.id,
    activePosGr,
  ).length > 0;
}

function moveSelectedGroupToTableMaybe(
  store: StoreContextModel,
  activeItem: PositionalItem,
  tableVe: VisualElement,
): boolean {
  const activeVe = MouseActionState.getActiveVisualElement();
  if (!activeVe) { return false; }

  const groupEntries = getGroupMoveEntriesInParent(MouseActionState.getGroupMoveItems(), activeItem.parentId);
  if (groupEntries.length == 0) { return false; }

  const activeVeid = VeFns.veidFromVe(activeVe);
  const sortedEntries = groupEntries.slice().sort((a, b) => {
    const dy = a.entry.startPosGr.y - b.entry.startPosGr.y;
    if (dy != 0) { return dy; }
    return a.entry.startPosGr.x - b.entry.startPosGr.x;
  });
  const activeSortedIndex = sortedEntries.findIndex(({ entry }) =>
    entry.veid.itemId == activeVeid.itemId && entry.veid.linkIdMaybe == activeVeid.linkIdMaybe);
  if (activeSortedIndex < 0) { return false; }

  const tableId = tableVe.displayItem.id;
  const anchorIndex = Math.max(0, store.perVe.getMoveOverRowNumber(VeFns.veToPath(tableVe)));
  const startIndex = Math.max(0, anchorIndex - activeSortedIndex);

  for (let i = 0; i < sortedEntries.length; ++i) {
    const { item } = sortedEntries[i];
    const ordering = itemState.newOrderingAtChildrenPosition(tableId, startIndex + i, item.id);
    itemState.moveToNewParent(item, tableId, RelationshipToParent.Child, ordering);
  }
  return true;
}

function mouseUpHandler_moving_toOrderedPage(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  if (!isPage(overContainerVe.displayItem)) {
    panic("mouseUpHandler_moving_toOrderedPage: over container is not a page.");
  }

  const pageItem = asPageItem(overContainerVe.displayItem);
  const path = VeFns.veToPath(overContainerVe);
  const idx = store.perVe.getMoveOverIndex(path);
  const insertIndex =
    pageItem.arrangeAlgorithm != ArrangeAlgorithm.Document && pageItem.orderChildrenBy != ""
      ? 0
      : idx;
  const moveToOrdering = itemState.newOrderingAtChildrenPosition(pageItem.id, insertIndex, activeItem.id);

  if (activeItem.parentId != pageItem.id) {
    itemState.moveToNewParent(activeItem, pageItem.id, RelationshipToParent.Child, moveToOrdering);
  } else {
    activeItem.ordering = moveToOrdering;
    itemState.sortChildren(pageItem.id);
  }

  if (pageItem.arrangeAlgorithm == ArrangeAlgorithm.List) {
    const activeVe = MouseActionState.getActiveVisualElement();
    if (activeVe) {
      const movingVeid = VeFns.actualVeidFromVe(activeVe);
      const movingChildId = activeVe.actualLinkItemMaybe?.id ?? activeVe.displayItem.id;
      const rollback = MouseActionState.getMoveRollback()?.find(entry => entry.id == movingChildId);
      PageFns.moveListPageSelectionOffChild(
        store,
        pageItem,
        [VeFns.actualVeidFromVe(overContainerVe), VeFns.veidFromVe(overContainerVe), { itemId: pageItem.id, linkIdMaybe: null }],
        movingVeid,
        movingChildId,
        rollback ? new Uint8Array(rollback.ordering) : null,
        false,
        true,
      );
    }
  }

  const ops: Array<MovePersistOperation> = [];
  enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
  scheduleMoveCommit(
    store,
    ops,
    pageItem.arrangeAlgorithm == ArrangeAlgorithm.Document
      ? "mouse-up-move-to-document-page"
      : "mouse-up-move-to-ordered-page",
  );
}


async function mouseUpHandler_moving_hitboxAttachToComposite(store: StoreContextModel, activeItem: PositionalItem) {
  const prevParentId = activeItem.parentId;
  const ops: Array<MovePersistOperation> = [];

  const attachToVisualElement = MouseActionState.readMoveOverAttachComposite()!;
  const attachToVisualElementPath = VeFns.veToPath(attachToVisualElement);
  store.perVe.setMovingItemIsOverAttachComposite(attachToVisualElementPath, false);
  MouseActionState.setMoveOverAttachCompositePath(null);

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
      enqueueUpdateItem(ops, store, activeItem);
      scheduleMoveCommit(store, ops, "mouse-up-attach-to-composite");
      return;
    }

    // case #1.2: the moving item is a composite.
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      const activeCompositeSnapshot = cloneItemSnapshot(activeItem_composite);
      const childSnapshots = activeItem_composite.computed_children
        .map((childId) => itemState.get(childId))
        .filter((child): child is PositionalItem => child != null && isPositionalItem(child))
        .map((child) => cloneItemSnapshot(child));
      const childSnapshotsById = new Map(childSnapshots.map((snapshot) => [snapshot.id, snapshot]));
      let lastPrevId = attachToItem.id;
      while (activeItem_composite.computed_children.length > 0) {
        const child = itemState.get(activeItem_composite.computed_children[0])!;
        itemState.moveToNewParent(
          child, destinationCompositeItem.id, RelationshipToParent.Child, itemState.newOrderingDirectlyAfterChild(destinationCompositeItem.id, lastPrevId));
        lastPrevId = child.id;
        enqueueUpdateItem(ops, store, child, childSnapshotsById.get(child.id) ?? null);
      }
      itemState.delete(activeItem_composite.id);
      enqueueDeleteItem(ops, store, activeItem_composite.id, activeCompositeSnapshot);
      MouseActionState.setStartCompositeItem(null);
      scheduleMoveCommit(store, ops, "mouse-up-attach-to-composite", {
        rollbackExtras: () => {
          if (itemState.get(activeCompositeSnapshot.id) == null) {
            const compositeRestore = asCompositeItem(cloneItemSnapshot(activeCompositeSnapshot));
            compositeRestore.computed_children = [];
            itemState.add(compositeRestore);
          }
          for (const childSnapshot of childSnapshots) {
            restorePositionalItemSnapshot(childSnapshot);
          }
        },
      });
      return;
    }

    // case #2: attaching to an item that is not inside an existing composite.
  } else {

    // case #2.1: this item is not a composite either.
    if (!isComposite(activeItem)) {
      const attachToItemSnapshot = cloneItemSnapshot(attachToItem);
      const compositeItem = CompositeFns.create(activeItem.ownerId, prevParentId, RelationshipToParent.Child, attachToItem.ordering);
      compositeItem.spatialPositionGr = { x: attachToItem.spatialPositionGr.x, y: attachToItem.spatialPositionGr.y };
      if (isXSizableItem(attachToItem)) { compositeItem.spatialWidthGr = asXSizableItem(attachToItem).spatialWidthGr; }
      itemState.add(compositeItem);
      enqueueAddItem(ops, store, compositeItem);

      attachToItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(attachToItem, compositeItem.id, RelationshipToParent.Child);
      enqueueUpdateItem(ops, store, attachToItem, attachToItemSnapshot);

      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(activeItem, compositeItem.id, RelationshipToParent.Child);
      enqueueUpdateItem(ops, store, activeItem);
      scheduleMoveCommit(store, ops, "mouse-up-attach-to-composite", {
        rollbackExtras: () => {
          restorePositionalItemSnapshot(attachToItemSnapshot);
          deleteCreatedItemIfPresent(compositeItem.id);
        },
      });
      return;
    }

    // case #2.2: the moving item being attached is a composite. 
    else {
      const activeItem_composite = asCompositeItem(activeItem);
      const attachToItemSnapshot = cloneItemSnapshot(attachToItem);
      const attachToPositionGr = attachToItem.spatialPositionGr;
      activeItem_composite.spatialPositionGr = attachToPositionGr;
      itemState.moveToNewParent(attachToItem, activeItem_composite.id, RelationshipToParent.Child, itemState.newOrderingAtBeginningOfChildren(activeItem_composite.id));
      enqueueUpdateItem(ops, store, attachToItem, attachToItemSnapshot);
      enqueueUpdateItem(ops, store, activeItem_composite);
      scheduleMoveCommit(store, ops, "mouse-up-attach-to-composite", {
        rollbackExtras: () => {
          restorePositionalItemSnapshot(attachToItemSnapshot);
        },
      });
      return;
    }

  }
}


function mouseUpHandler_moving_hitboxAttachTo(store: StoreContextModel, activeItem: PositionalItem) {
  const attachToVisualElement = MouseActionState.readMoveOverAttachHitbox()!;
  const attachToPath = VeFns.veToPath(attachToVisualElement);
  const displayedParent = asAttachmentsItem(attachToVisualElement.displayItem);
  const ops: Array<MovePersistOperation> = [];

  if (displayedParent.id == activeItem.id) {
    // TODO (MEDIUM): More rigorous recursive check. also server side.
    console.error("activeItem", activeItem);
    console.error("attachToVisualElement", attachToVisualElement);
    panic("mouseUpHandler_moving_hitboxAttachTo: Attempt was made to attach an item to itself.");
  }

  store.perVe.setMovingItemIsOverAttach(attachToPath, false);
  const insertPosition = store.perVe.getMoveOverAttachmentIndex(attachToPath);
  store.perVe.setMoveOverAttachmentIndex(attachToPath, -1);
  MouseActionState.setMoveOverAttachHitboxPath(null);

  // Handle case when no specific position or position is at/past end
  if (insertPosition < 0 || insertPosition >= displayedParent.computed_attachments.length) {
    // Check if there's a placeholder at the previous position (insertPosition - 1)
    // If inserting past end but previous position has a placeholder, replace it
    if (insertPosition > 0 && insertPosition - 1 < displayedParent.computed_attachments.length) {
      const prevAttachmentId = displayedParent.computed_attachments[insertPosition - 1];
      const prevPlaceholderMaybe = itemState.get(prevAttachmentId)!;
      if (isPlaceholder(prevPlaceholderMaybe)) {
        const placeholderRollback = placeholderRollbackSnapshotMaybe(prevPlaceholderMaybe);
        const newOrdering = prevPlaceholderMaybe.ordering;
        itemState.delete(prevPlaceholderMaybe.id);
        if (placeholderRollback != null) {
          enqueueDeleteItem(ops, store, prevPlaceholderMaybe.id, placeholderRollback);
        }
        activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
        itemState.moveToNewParent(activeItem, displayedParent.id, RelationshipToParent.Attachment, newOrdering);
        enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
        scheduleMoveCommit(store, ops, "mouse-up-attach-end-placeholder", {
          rollbackExtras: placeholderRollback == null
            ? null
            : () => { restoreDeletedItemSnapshot(placeholderRollback); },
        });
        return;
      }
    }
    activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
    const newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedParent.id, insertPosition >= 0 ? insertPosition : displayedParent.computed_attachments.length);
    itemState.moveToNewParent(activeItem, displayedParent.id, RelationshipToParent.Attachment, newOrdering);
    enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
    scheduleMoveCommit(store, ops, "mouse-up-attach-end");
    return;
  }

  // Check if there's a placeholder at the target position
  const overAttachmentId = displayedParent.computed_attachments[insertPosition];
  const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
  if (isPlaceholder(placeholderToReplaceMaybe)) {
    // Replace the placeholder
    const placeholderRollback = placeholderRollbackSnapshotMaybe(placeholderToReplaceMaybe);
    const newOrdering = placeholderToReplaceMaybe.ordering;
    itemState.delete(placeholderToReplaceMaybe.id);
    if (placeholderRollback != null) {
      enqueueDeleteItem(ops, store, placeholderToReplaceMaybe.id, placeholderRollback);
    }
    activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
    itemState.moveToNewParent(activeItem, displayedParent.id, RelationshipToParent.Attachment, newOrdering);
    enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
    scheduleMoveCommit(store, ops, "mouse-up-attach-replace-placeholder", {
      rollbackExtras: placeholderRollback == null
        ? null
        : () => { restoreDeletedItemSnapshot(placeholderRollback); },
    });
    return;
  }

  // Check if there's a placeholder at the previous position (insertPosition - 1)
  // This handles inserting "after" a placeholder - should replace the placeholder
  if (insertPosition > 0) {
    const prevAttachmentId = displayedParent.computed_attachments[insertPosition - 1];
    const prevPlaceholderMaybe = itemState.get(prevAttachmentId)!;
    if (isPlaceholder(prevPlaceholderMaybe)) {
      const placeholderRollback = placeholderRollbackSnapshotMaybe(prevPlaceholderMaybe);
      const newOrdering = prevPlaceholderMaybe.ordering;
      itemState.delete(prevPlaceholderMaybe.id);
      if (placeholderRollback != null) {
        enqueueDeleteItem(ops, store, prevPlaceholderMaybe.id, placeholderRollback);
      }
      activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
      itemState.moveToNewParent(activeItem, displayedParent.id, RelationshipToParent.Attachment, newOrdering);
      enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
      scheduleMoveCommit(store, ops, "mouse-up-attach-prev-placeholder", {
        rollbackExtras: placeholderRollback == null
          ? null
          : () => { restoreDeletedItemSnapshot(placeholderRollback); },
      });
      return;
    }
  }

  // Insert at specific position (shifts existing attachments)
  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  const newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedParent.id, insertPosition);
  itemState.moveToNewParent(activeItem, displayedParent.id, RelationshipToParent.Attachment, newOrdering);
  enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
  scheduleMoveCommit(store, ops, "mouse-up-attach-insert");
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

  const movedGroup = moveSelectedGroupToOpaquePageMaybe(store, activeItem, overContainerVe);
  const ops: Array<MovePersistOperation> = [];
  if (movedGroup) {
    enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
  } else {
    activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
    itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child);
    enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!, null, overContainerVe);
  }

  scheduleMoveCommit(store, ops, "mouse-up-move-to-opaque-page");
}

function mouseUpHandler_moving_toComposite(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  if (!isComposite(overContainerVe.displayItem)) { panic("mouseUpHandler_moving_toComposite: over container is not a composite."); }

  const moveOverContainerId = overContainerVe.displayItem.id;
  if (moveOverContainerId == activeItem.id) {
    console.error("activeItem", activeItem);
    console.error("overContainerVe", overContainerVe);
    panic("mouseUpHandler_moving_toComposite: Attempt was made to move an item into itself.");
  }

  const path = VeFns.veToPath(overContainerVe);
  const moveToIndex = store.perVe.getMoveOverIndex(path);
  const moveToOrdering = itemState.newOrderingAtChildrenPosition(
    moveOverContainerId,
    moveToIndex >= 0 ? moveToIndex : asCompositeItem(overContainerVe.displayItem).computed_children.length,
    activeItem.id,
  );

  activeItem.spatialPositionGr = { x: 0.0, y: 0.0 };
  if (activeItem.parentId != moveOverContainerId) {
    itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child, moveToOrdering);
  } else {
    activeItem.ordering = moveToOrdering;
    itemState.sortChildren(moveOverContainerId);
  }
  const ops: Array<MovePersistOperation> = [];
  enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!, null, overContainerVe);
  scheduleMoveCommit(store, ops, "mouse-up-move-to-composite");
}


function mouseUpHandler_moving_toTable(store: StoreContextModel, activeItem: PositionalItem, overContainerVe: VisualElement) {
  const moveOverContainerId = overContainerVe.displayItem.id;
  const tablePath = VeFns.veToPath(overContainerVe);
  if (moveOverContainerId == activeItem.id) {
    // TODO (HIGH): more rigorous check of entire hierarchy.
    // TODO (HIGH): quite possibly quite hard if only partial hierarchy loaded.
    console.error("activeItem", activeItem);
    console.error("overContainerVe", overContainerVe);
    panic("mouseUpHandler_moving_toTable: Attempt was made to move an item into itself.");
  }

  const moveIntoChildContainerPath = store.perVe.getMoveOverChildContainerPath(tablePath);
  store.perVe.setMoveOverChildContainerPath(tablePath, null);
  if (moveIntoChildContainerPath != null) {
    const moveIntoChildContainerVe = MouseActionState.readVisualElement(moveIntoChildContainerPath);
    if (moveIntoChildContainerVe != null && isPage(moveIntoChildContainerVe.displayItem)) {
      mouseUpHandler_moving_toOpaquePage(store, activeItem, moveIntoChildContainerVe);
      return;
    }
  }

  if (store.perVe.getMoveOverColAttachmentNumber(tablePath) >= 0) {
    mouseUpHandler_moving_toTable_attachmentCell(store, activeItem, overContainerVe);
    return;
  }

  const movedGroup = moveSelectedGroupToTableMaybe(store, activeItem, overContainerVe);
  const ops: Array<MovePersistOperation> = [];
  if (movedGroup) {
    enqueuePersistMovedItems(ops, store, [activeItem.id], overContainerVe);
  } else {
    const moveToOrdering = itemState.newOrderingAtChildrenPosition(moveOverContainerId, store.perVe.getMoveOverRowNumber(tablePath), activeItem.id);
    itemState.moveToNewParent(activeItem, moveOverContainerId, RelationshipToParent.Child, moveToOrdering);
    enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!, null, overContainerVe);
  }

  scheduleMoveCommit(store, ops, "mouse-up-move-to-table");
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
  const ops: Array<MovePersistOperation> = [];

  const startAttachmentsItem = MouseActionState.getStartAttachmentsItem();
  const isDroppingBack = startAttachmentsItem != null && startAttachmentsItem.id == displayedChild.id;

  if (isDroppingBack && insertPosition < displayedChild.computed_attachments.length) {
    const overAttachmentId = displayedChild.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      const newPlaceholderItem = MouseActionState.getNewPlaceholderItem();
      const placeholderRollback =
        newPlaceholderItem != null && newPlaceholderItem.id == placeholderToReplaceMaybe.id
          ? null
          : cloneItemSnapshot(placeholderToReplaceMaybe);
      let newOrdering: Uint8Array;
      if (newPlaceholderItem != null && newPlaceholderItem.id == placeholderToReplaceMaybe.id) {
        newOrdering = placeholderToReplaceMaybe.ordering;
        itemState.delete(placeholderToReplaceMaybe.id);
        MouseActionState.setNewPlaceholderItem(null);
      } else {
        newOrdering = placeholderToReplaceMaybe.ordering;
        itemState.delete(placeholderToReplaceMaybe.id);
        enqueueDeleteItem(ops, store, placeholderToReplaceMaybe.id, placeholderRollback);
      }
      itemState.moveToNewParent(activeItem, displayedChild.id, RelationshipToParent.Attachment, newOrdering);
      enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);
      scheduleMoveCommit(store, ops, "mouse-up-move-to-table-attachment-placeholder", {
        rollbackExtras: placeholderRollback == null
          ? null
          : () => { restoreDeletedItemSnapshot(placeholderRollback); },
      });
      return;
    }
  }

  const createdPlaceholderIds: Array<string> = [];
  const numPlaceholdersToCreate = insertPosition > displayedChild.computed_attachments.length ? insertPosition - displayedChild.computed_attachments.length : 0;
  for (let i = 0; i < numPlaceholdersToCreate; ++i) {
    const placeholderItem = PlaceholderFns.create(activeItem.ownerId, displayedChild.id, RelationshipToParent.Attachment, itemState.newOrderingAtEndOfAttachments(displayedChild.id));
    itemState.add(placeholderItem);
    createdPlaceholderIds.push(placeholderItem.id);
    enqueueAddItem(ops, store, placeholderItem);
  }
  let newOrdering: Uint8Array | undefined;
  let deletedPlaceholderSnapshot: Item | null = null;
  if (insertPosition < displayedChild.computed_attachments.length) {
    const overAttachmentId = displayedChild.computed_attachments[insertPosition];
    const placeholderToReplaceMaybe = itemState.get(overAttachmentId)!;
    if (isPlaceholder(placeholderToReplaceMaybe)) {
      deletedPlaceholderSnapshot = placeholderRollbackSnapshotMaybe(placeholderToReplaceMaybe);
      newOrdering = placeholderToReplaceMaybe.ordering;
      itemState.delete(placeholderToReplaceMaybe.id);
      if (deletedPlaceholderSnapshot != null) {
        enqueueDeleteItem(ops, store, placeholderToReplaceMaybe.id, deletedPlaceholderSnapshot);
      }
    } else {
      // TODO (MEDIUM): probably want to forbid rather than insert in this case.
      newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedChild.id, insertPosition);
    }
  } else {
    newOrdering = itemState.newOrderingAtAttachmentsPosition(displayedChild.id, insertPosition);
  }

  itemState.moveToNewParent(activeItem, displayedChild.id, RelationshipToParent.Attachment, newOrdering);
  enqueueUpdateItem(ops, store, itemState.get(activeItem.id)!);

  scheduleMoveCommit(store, ops, "mouse-up-move-to-table-attachment", {
    rollbackExtras: () => {
      for (const placeholderId of createdPlaceholderIds) {
        deleteCreatedItemIfPresent(placeholderId);
      }
      if (deletedPlaceholderSnapshot != null) {
        restoreDeletedItemSnapshot(deletedPlaceholderSnapshot);
      }
    },
  });
}


function finalizeMouseUp(store: StoreContextModel) {
  cleanupAndPersistPlaceholders(store);
  maybeDeleteComposite(store)
}

function handleSelectionMouseUp(store: StoreContextModel) {
  const rect = store.overlay.selectionMarqueePx.get();
  store.overlay.selectionMarqueePx.set(null);
  if (rect == null) { return; }

  const selectionRootVe = MouseActionState.readSelectionRoot()!;
  const activeRootBounds = VeFns.veViewportBoundsRelativeToDesktopPx(store, selectionRootVe);
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
  const rootPath = MouseActionState.getSelectionRootPath()!;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const ves = MouseActionState.getVisualElementSignal(path);
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
            const parentVe = MouseActionState.readVisualElement(ve.parentPath)!;
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
    for (const child of VesCache.render.getChildren(VeFns.veToPath(ve))()) { stack.push(VeFns.veToPath(child.get())); }
    for (const att of VesCache.render.getAttachments(VeFns.veToPath(ve))()) { stack.push(VeFns.veToPath(att.get())); }
  }
  store.overlay.selectedVeids.set(selected);
  arrangeNow(store, "mouse-up-finish-selection");
}


async function maybeDeleteComposite(store: StoreContextModel) {
  if (MouseActionState.empty()) { return; }
  if (MouseActionState.getStartCompositeItem() == null) { return; }

  const compositeItem = MouseActionState.getStartCompositeItem()!;
  if (compositeItem.computed_children.length == 0) { panic("maybeDeleteComposite: composite has no children."); }
  if (compositeItem.computed_children.length != 1) {
    MouseActionState.setStartCompositeItem(null);
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
  if (MouseActionState.getStartAttachmentsItem() == null) { return; }

  if (MouseActionState.getNewPlaceholderItem() != null) {
    server.addItem(MouseActionState.getNewPlaceholderItem()!, null, store.general.networkStatus);
  }

  const placeholderParent = MouseActionState.getStartAttachmentsItem()!;

  while (true) {
    const attachments = placeholderParent.computed_attachments;
    if (attachments.length == 0) { break; }
    const attachmentId = placeholderParent.computed_attachments[placeholderParent.computed_attachments.length - 1];
    const attachment = itemState.get(attachmentId)!;
    if (attachment == null) { panic("cleanupAndPersistPlaceholders: no attachment."); }
    if (!isPlaceholder(attachment)) {
      break;
    }
    server.deleteItem(attachment.id, store.general.networkStatus);
    itemState.delete(attachment.id);
  }

  MouseActionState.setNewPlaceholderItem(null);
  MouseActionState.setStartAttachmentsItem(null);
}
