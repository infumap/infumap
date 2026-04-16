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

import { server, serverOrRemote } from "../server";
import { NoteFns, asNoteItem, isNote } from "../items/note-item";
import { trimNewline, isUrl } from "../util/string";
import { arrangeNow } from "../layout/arrange";
import { VesCache } from "../layout/ves-cache";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { assert, panic } from "../util/lang";
import { asFileItem, isFile } from "../items/file-item";
import { ItemType } from "../items/base/item";
import { asPositionalItem } from "../items/base/positional-item";
import { asXSizableItem } from "../items/base/x-sizeable-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { isArrowKey } from "../input/key";
import { asTableItem, isTable } from "../items/table-item";
import { currentCaretElement, EditElementType, type EditPathInfo, getCurrentCaretVePath_title as getCurrentCaretVeInfo, getCaretLineRect, getCaretPosition, setCaretPosition, editPathInfoToDomId } from "../util/caret";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { itemState } from "../store/ItemState";
import { VeFns, VisualElement } from "../layout/visual-element";
import { asTitledItem } from "../items/base/titled-item";
import { StoreContextModel } from "../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { asImageItem } from "../items/image-item";
import { PageFlags } from "../items/base/flags-item";


let arrowKeyDown_caretPosition = null;
let arrowKeyDown_element: HTMLElement | null = null;
type PendingBoundaryNavigation = { targetPath: string, targetCaretPosition: number };
type LinearEditContext = {
  containerVe: VisualElement,
  containerPath: string,
  editingVe: VisualElement,
  editingPath: string,
};

let arrowKeyDown_pendingBoundaryNavigation: PendingBoundaryNavigation | null = null;
const LINEAR_EDIT_DEBUG_KEY = "debug:linear-edit";

function linearEditDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem(LINEAR_EDIT_DEBUG_KEY) == "1";
  } catch (_e) {
    return false;
  }
}

function logLinearEdit(message: string, details?: Record<string, unknown>) {
  if (!linearEditDebugEnabled()) { return; }
  if (details == null) {
    console.log(`[linear-edit] ${message}`);
  } else {
    console.log(`[linear-edit] ${message}`, details);
  }
}

function selectionDebugInfo(): Record<string, unknown> {
  const selection = window.getSelection();
  return {
    anchorNode: selection?.anchorNode?.nodeName ?? null,
    anchorParentId: selection?.anchorNode?.parentElement?.id ?? null,
    focusNode: selection?.focusNode?.nodeName ?? null,
    focusParentId: selection?.focusNode?.parentElement?.id ?? null,
  };
}

function persistCurrentEditTarget(store: StoreContextModel) {
  const focusItem = store.history.getFocusItem();
  if (focusItem.relationshipToParent == RelationshipToParent.Child) {
    const parentItem = itemState.get(focusItem.parentId);
    if (parentItem && isTable(parentItem) && asTableItem(parentItem).orderChildrenBy != "") {
      itemState.sortChildren(focusItem.parentId);
    }
  }
  serverOrRemote.updateItem(focusItem, store.general.networkStatus);
}

function editableItemType(ve: VisualElement): ItemType | null {
  if (isNote(ve.displayItem)) { return ItemType.Note; }
  if (isFile(ve.displayItem)) { return ItemType.File; }
  if (isPassword(ve.displayItem)) { return ItemType.Password; }
  if (isPage(ve.displayItem)) { return ItemType.Page; }
  if (isTable(ve.displayItem)) { return ItemType.Table; }
  return null;
}

function textEditInfoForPathInfo(pathInfo: EditPathInfo): { itemPath: string, itemType: ItemType, colNum?: number | null } | null {
  const ve = VesCache.current.readNode(pathInfo.path);
  if (!ve) { return null; }

  const itemType = editableItemType(ve);
  if (itemType == null) { return null; }

  return {
    itemPath: pathInfo.path,
    itemType,
    colNum: pathInfo.type == EditElementType.Column ? pathInfo.colNumMaybe : null,
  };
}

function focusTextEditPathInfo(store: StoreContextModel, pathInfo: EditPathInfo, caretPosition: number): boolean {
  const nextTextEditInfo = textEditInfoForPathInfo(pathInfo);
  if (nextTextEditInfo == null) {
    console.warn("Could not derive text edit info for path", pathInfo.path);
    return false;
  }

  store.overlay.setTextEditInfo(store.history, nextTextEditInfo);
  const editingDomId = editPathInfoToDomId(pathInfo);
  const editingTextElement = document.getElementById(editingDomId);
  if (!editingTextElement) {
    console.warn("Could not find target text element for path", editingDomId);
    return false;
  }

  setCaretPosition(editingTextElement, caretPosition);
  editingTextElement.focus();
  return true;
}

function isLinearEditableContainer(ve: VisualElement): boolean {
  return isComposite(ve.displayItem) ||
    (isPage(ve.displayItem) && asPageItem(ve.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document);
}

function editingLinearContainerVeMaybe(store: StoreContextModel): VisualElement | null {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null) { return null; }

  const editingVe = VesCache.current.readNode(textEditInfo.itemPath);
  if (!editingVe) { return null; }

  if (textEditInfo.itemType == ItemType.Page &&
    isPage(editingVe.displayItem) &&
    asPageItem(editingVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    !(asPageItem(editingVe.displayItem).flags & PageFlags.HideDocumentTitle)) {
    return editingVe;
  }

  const parentPath = VeFns.parentPath(textEditInfo.itemPath);
  if (!parentPath) { return null; }

  const parentVe = VesCache.current.readNode(parentPath);
  if (!parentVe || !isLinearEditableContainer(parentVe)) { return null; }
  return parentVe;
}

function currentLinearEditContext(store: StoreContextModel): LinearEditContext | null {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null) { return null; }

  const editingVe = VesCache.current.readNode(textEditInfo.itemPath);
  if (!editingVe) { return null; }

  const containerVe = editingLinearContainerVeMaybe(store);
  if (containerVe == null) { return null; }

  return {
    containerVe,
    containerPath: VeFns.veToPath(containerVe),
    editingVe,
    editingPath: textEditInfo.itemPath,
  };
}

function isCaretOnBoundaryLine(textElement: HTMLElement, caretPosition: number, key: string): boolean {
  const currentLineRect = getCaretLineRect(textElement, caretPosition);
  const boundaryLineRect = key == "ArrowUp"
    ? getCaretLineRect(textElement, 0)
    : getCaretLineRect(textElement, textElement.textContent?.length ?? 0);
  const TOLERANCE_PX = 1;
  const isBoundary = key == "ArrowUp"
    ? currentLineRect.top <= boundaryLineRect.top + TOLERANCE_PX
    : currentLineRect.bottom >= boundaryLineRect.bottom - TOLERANCE_PX;
  logLinearEdit("boundary-check", {
    key,
    caretPosition,
    currentTop: currentLineRect.top,
    currentBottom: currentLineRect.bottom,
    boundaryTop: boundaryLineRect.top,
    boundaryBottom: boundaryLineRect.bottom,
    isBoundary,
    text: textElement.textContent,
  });
  return isBoundary;
}

function adjacentEditableChildPathInLinearContainer(
  containerVe: VisualElement,
  currentPath: string,
  key: "ArrowUp" | "ArrowDown",
): string | null {
  const containerPath = VeFns.veToPath(containerVe);
  const childVes = VesCache.current.readStructuralChildren(containerPath);
  const containerHasMirroredTitle = isPage(containerVe.displayItem) &&
    asPageItem(containerVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    !(asPageItem(containerVe.displayItem).flags & PageFlags.HideDocumentTitle);

  if (currentPath == containerPath) {
    if (key == "ArrowUp") { return null; }
    for (let i = 0; i < childVes.length; ++i) {
      if (editableItemType(childVes[i]) == null) { continue; }
      return VeFns.veToPath(childVes[i]);
    }
    return null;
  }

  const currentIndex = childVes.findIndex(ve => VeFns.veToPath(ve) == currentPath);
  if (currentIndex < 0) { return null; }

  const step = key == "ArrowUp" ? -1 : 1;
  for (let i = currentIndex + step; i >= 0 && i < childVes.length; i += step) {
    const targetVe = childVes[i];
    if (editableItemType(targetVe) == null) { continue; }
    return VeFns.veToPath(targetVe);
  }

  if (containerHasMirroredTitle && key == "ArrowUp" && currentIndex == 0) {
    return containerPath;
  }

  return null;
}

function adjacentEditableChildPathInCurrentLinearContext(
  context: LinearEditContext,
  key: "ArrowUp" | "ArrowDown",
): string | null {
  return adjacentEditableChildPathInLinearContainer(context.containerVe, context.editingPath, key);
}

function itemPathInLinearContainer(itemId: string, containerPath: string): string | null {
  const veid = { itemId, linkIdMaybe: null };
  const allVes = VesCache.current.findNodes(veid);
  const targetVe = allVes.find(ve => VeFns.parentPath(VeFns.veToPath(ve)) === containerPath);
  return targetVe ? VeFns.veToPath(targetVe) : null;
}

function focusItemInLinearContainer(
  store: StoreContextModel,
  containerPath: string,
  itemId: string,
  caretPosition: number,
): boolean {
  const itemPath = itemPathInLinearContainer(itemId, containerPath);
  if (itemPath == null) {
    console.error("Could not find item visual element in the current linear container context");
    return false;
  }

  return focusTextEditPathInfo(store, {
    path: itemPath,
    type: EditElementType.Title,
    colNumMaybe: null,
  }, caretPosition);
}

function maybeBuildLinearBoundaryNavigation(
  store: StoreContextModel,
  key: string,
  textElement: HTMLElement,
  caretPosition: number,
): PendingBoundaryNavigation | null {
  const context = currentLinearEditContext(store);
  if (context == null) {
    logLinearEdit("boundary-navigation-no-linear-parent", {
      key,
      currentPath: store.overlay.textEditInfo()?.itemPath ?? null,
    });
    return null;
  }
  if (key != "ArrowUp" && key != "ArrowDown") { return null; }
  if (!isCaretOnBoundaryLine(textElement, caretPosition, key)) { return null; }

  const targetPath = adjacentEditableChildPathInCurrentLinearContext(context, key);
  if (targetPath == null) {
    const childCount = VesCache.current.readStructuralChildren(context.containerPath).length;
    logLinearEdit("no-boundary-target", { key, currentPath: context.editingPath, childCount });
    return null;
  }

  const navigation = {
    targetPath,
    targetCaretPosition: caretPosition,
  };
  logLinearEdit("prepared-boundary-navigation", {
    key,
    containerPath: context.containerPath,
    currentPath: context.editingPath,
    targetPath: navigation.targetPath,
    caretPosition,
  });
  return navigation;
}

export function textEditSelectionChangeListener() {
  if (arrowKeyDown_pendingBoundaryNavigation != null) {
    logLinearEdit("selectionchange-skip-restore-during-boundary-navigation", {
      targetPath: arrowKeyDown_pendingBoundaryNavigation.targetPath,
      selection: selectionDebugInfo(),
    });
    return;
  }

  if (arrowKeyDown_element != null) {
    try {
      getCurrentCaretVeInfo();
    } catch (e) {
      logLinearEdit("selectionchange-restoring-caret", {
        elementId: arrowKeyDown_element.id,
        caretPosition: arrowKeyDown_caretPosition,
        selection: selectionDebugInfo(),
        error: `${e}`,
      });
      setCaretPosition(arrowKeyDown_element!, arrowKeyDown_caretPosition!);
    }
  }
}

export const edit_keyUpHandler = (store: StoreContextModel, ev: KeyboardEvent) => {
  if (isArrowKey(ev.key)) {
    keyUp_Arrow(store);
  }
}

const keyUp_Arrow = (store: StoreContextModel) => {
  const pendingBoundaryNavigation = arrowKeyDown_pendingBoundaryNavigation;
  arrowKeyDown_caretPosition = null;
  arrowKeyDown_element = null;
  arrowKeyDown_pendingBoundaryNavigation = null;

  let currentCaretItemInfo: EditPathInfo | null = null;
  try {
    currentCaretItemInfo = getCurrentCaretVeInfo();
  } catch (e) {
    logLinearEdit("keyup-caret-lookup-failed", {
      error: `${e}`,
      selection: selectionDebugInfo(),
      boundaryNavigation: pendingBoundaryNavigation,
      currentEditingPath: store.history.getFocusPathMaybe(),
    });
  }
  const currentEditingPath = store.history.getFocusPath();
  if (currentCaretItemInfo != null && currentEditingPath != currentCaretItemInfo.path) {
    logLinearEdit("keyup-browser-moved-to-new-item", {
      currentEditingPath,
      caretPath: currentCaretItemInfo.path,
      boundaryNavigation: pendingBoundaryNavigation,
    });
    persistCurrentEditTarget(store);

    const newEditingDomId = editPathInfoToDomId(currentCaretItemInfo);
    const newEditingTextElement = document.getElementById(newEditingDomId);
    const caretPosition = getCaretPosition(newEditingTextElement!);
    focusTextEditPathInfo(store, currentCaretItemInfo, caretPosition);
    return;
  }

  if (pendingBoundaryNavigation != null) {
    logLinearEdit("keyup-applying-boundary-navigation", {
      currentEditingPath,
      targetPath: pendingBoundaryNavigation.targetPath,
      targetCaretPosition: pendingBoundaryNavigation.targetCaretPosition,
    });
    const targetVe = VesCache.current.readNode(pendingBoundaryNavigation.targetPath);
    if (!targetVe) { return; }

    const itemType = editableItemType(targetVe);
    if (itemType == null) { return; }

    persistCurrentEditTarget(store);
    focusTextEditPathInfo(store, {
      path: pendingBoundaryNavigation.targetPath,
      type: EditElementType.Title,
      colNumMaybe: null,
    }, pendingBoundaryNavigation.targetCaretPosition);
    return;
  }

  logLinearEdit("keyup-no-op", {
    currentEditingPath,
    caretPath: currentCaretItemInfo?.path ?? null,
    selection: selectionDebugInfo(),
  });
}

export const edit_keyDownHandler = (store: StoreContextModel, visualElement: VisualElement, ev: KeyboardEvent) => {
  if (isArrowKey(ev.key)) {
    const itemPath = store.overlay.textEditInfo()!.itemPath;
    const editingDomId = itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);
    arrowKeyDown_caretPosition = caretPosition;
    arrowKeyDown_element = textElement;
    arrowKeyDown_pendingBoundaryNavigation = maybeBuildLinearBoundaryNavigation(store, ev.key, textElement!, caretPosition);
    logLinearEdit("keydown-arrow", {
      key: ev.key,
      itemPath,
      caretPosition,
      boundaryNavigation: arrowKeyDown_pendingBoundaryNavigation,
      selection: selectionDebugInfo(),
    });
    if (arrowKeyDown_pendingBoundaryNavigation != null) {
      logLinearEdit("keydown-prevent-default-for-boundary-navigation", {
        key: ev.key,
        itemPath,
        targetPath: arrowKeyDown_pendingBoundaryNavigation.targetPath,
      });
      ev.preventDefault();
      ev.stopPropagation();
    }
    return;
  }

  switch (ev.key) {
    case "Backspace":
      const el = currentCaretElement();
      const position = getCaretPosition(el!);
      if (position > 0) { return; }
      ev.preventDefault();
      ev.stopPropagation();
      joinItemsMaybeHandler(store, visualElement);
      return;
    case "Enter":
      enterKeyHandler(store, visualElement);
      ev.preventDefault();
      ev.stopPropagation();
      return;
  }
}

const joinItemsMaybeHandler = (store: StoreContextModel, _visualElement: VisualElement) => {
  const context = currentLinearEditContext(store);
  if (context == null) { return; }

  const initialEditingItem = VeFns.treeItem(context.editingVe);
  if (!isNote(initialEditingItem)) { return; }

  const upPath = adjacentEditableChildPathInCurrentLinearContext(context, "ArrowUp");
  if (upPath == null) { return; }

  const upVeid = VeFns.veidFromPath(upPath);
  const upFocusItem = asTitledItem(itemState.get(upVeid.itemId)!);

  if (!isNote(upFocusItem) && !isFile(upFocusItem)) { return; }
  const upTextLength = upFocusItem.title.length;
  upFocusItem.title = upFocusItem.title + asTitledItem(context.editingVe.displayItem).title;

  store.history.setFocus(upPath);
  arrangeNow(store, "join-items-focus-up-item");

  server.updateItem(upFocusItem, store.general.networkStatus);
  itemState.delete(initialEditingItem.id);
  server.deleteItem(initialEditingItem.id, store.general.networkStatus);

  if (isComposite(context.containerVe.displayItem)) {
    const compositeItem = asCompositeItem(context.containerVe.displayItem);
    assert(compositeItem.computed_children.length != 0, "composite item does not have any children.");
    if (compositeItem.computed_children.length == 1) {
      const compositeParentPath = VeFns.parentPath(context.containerPath);
      if (compositeParentPath == null) { return; }

      const posGr = compositeItem.spatialPositionGr;
      const widthGr = compositeItem.spatialWidthGr;
      itemState.moveToNewParent(upFocusItem, compositeItem.parentId, RelationshipToParent.Child);
      asPositionalItem(upFocusItem).spatialPositionGr = posGr;

      asXSizableItem(upFocusItem).spatialWidthGr = widthGr;
      server.updateItem(upFocusItem, store.general.networkStatus);
      itemState.delete(compositeItem.id);
      server.deleteItem(compositeItem.id, store.general.networkStatus);
      arrangeNow(store, "join-items-collapse-composite");
      focusItemInLinearContainer(store, compositeParentPath, upFocusItem.id, upTextLength);
      return;
    }
  }

  arrangeNow(store, "join-items-restore-edit-focus");
  focusItemInLinearContainer(store, context.containerPath, upFocusItem.id, upTextLength);
}

const enterKeyHandler = (store: StoreContextModel, _visualElement: VisualElement) => {
  const context = currentLinearEditContext(store);
  if (context == null) { return; }

  const noteVeid = VeFns.veidFromPath(context.editingPath);
  const item = itemState.get(noteVeid.itemId)!;
  if (!isNote(item) && !isFile(item)) { return; }
  const titledItem = asTitledItem(item);

  const editingDomId = context.editingPath + ":title";
  const textElement = document.getElementById(editingDomId);
  const caretPosition = getCaretPosition(textElement!);

  const beforeText = textElement!.innerText.substring(0, caretPosition);
  const afterText = textElement!.innerText.substring(caretPosition);

  // Set URL if the title is a URL (for notes)
  if (isNote(item)) {
    const noteItem = asNoteItem(item);
    if (isUrl(beforeText)) {
      if (noteItem.url == "") {
        noteItem.url = beforeText;
      }
    }
  }

  titledItem.title = beforeText;

  serverOrRemote.updateItem(titledItem, store.general.networkStatus);

  const ordering = itemState.newOrderingDirectlyAfterChild(context.containerVe.displayItem.id, VeFns.treeItemFromVeid(noteVeid)!.id);
  const note = NoteFns.create(titledItem.ownerId, context.containerVe.displayItem.id, RelationshipToParent.Child, "", ordering);
  note.title = afterText;
  itemState.add(note);
  server.addItem(note, null, store.general.networkStatus);
  arrangeNow(store, "enter-key-create-note");

  focusItemInLinearContainer(store, context.containerPath, note.id, 0);
}

export const edit_inputListener = (store: StoreContextModel, _ev: InputEvent) => {
  setTimeout(() => {
    if (store.overlay.textEditInfo()) {
      const colNum = store.overlay.textEditInfo()!.colNum;
      const focusItemPath = store.history.getFocusPath();
      const focusItemDomId = colNum == null
        ? focusItemPath + ":title"
        : focusItemPath + ":col" + colNum;
      const el = document.getElementById(focusItemDomId);
      const newText = el!.innerText;
      if (!store.overlay.toolbarPopupInfoMaybe.get()) {
        if (store.overlay.textEditInfo()!.itemType == ItemType.Note) {
          let item = asNoteItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = trimNewline(newText);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.File) {
          let item = asFileItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = trimNewline(newText);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Password) {
          let item = asPasswordItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.text = trimNewline(newText);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Page) {
          let item = asPageItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = trimNewline(newText);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Image) {
          let item = asImageItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = trimNewline(newText);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Table) {
          let item = asTableItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          if (colNum == null) {
            item.title = trimNewline(newText);
          } else {
            item.tableColumns[colNum].name = trimNewline(newText);
          }
        } else {
          console.warn("input handler for item type " + store.overlay.textEditInfo()!.itemType + " not implemented.");
        }
        const caretPosition = getCaretPosition(el!);
        arrangeNow(store, "text-edit-input-preserve-caret");
        const el_ = document.getElementById(focusItemDomId);
        setCaretPosition(el_!, caretPosition);
      }
    }
  }, 0);
}
