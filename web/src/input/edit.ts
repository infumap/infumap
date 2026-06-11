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
import {
  NoteFns,
  asNoteItem,
  concatNoteInlineMarks,
  concatNoteUrls,
  isNote,
  noteInlineFlagsAtPosition,
  noteInlineFlagsForRange,
  NoteInlineMarkFlags,
  splitNoteInlineMarks,
  splitNoteUrls,
  toggleNoteInlineMarkFlag,
  updateNoteInlineMarksForTextChange,
  updateNoteUrlsForTextChange,
} from "../items/note-item";
import { trimNewline, restoreContentEditablePlaceholderIfEmpty } from "../util/string";
import { arrangeNow } from "../layout/arrange";
import { VesCache } from "../layout/ves-cache";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { assert, panic } from "../util/lang";
import { asFileItem, isFile } from "../items/file-item";
import { asTextItem, isText } from "../items/text-item";
import { ItemType } from "../items/base/item";
import { asPositionalItem } from "../items/base/positional-item";
import { asXSizableItem } from "../items/base/x-sizeable-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { isArrowKey } from "../input/key";
import { asTableItem, isTable } from "../items/table-item";
import { currentCaretElement, EditElementType, type EditPathInfo, editPathInfoToDomId, getCurrentCaretVePath_title as getCurrentCaretVeInfo, getCaretLineRect, getCaretPosition, getEditPathInfoForNode, getTextOffsetWithinElement, setCaretPosition, setTextSelection } from "../util/caret";
import { asCompositeItem, CompositeFns, isComposite } from "../items/composite-item";
import { itemState } from "../store/ItemState";
import { VeFns, VisualElement } from "../layout/visual-element";
import { asTitledItem } from "../items/base/titled-item";
import { StoreContextModel } from "../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { asImageItem } from "../items/image-item";
import { itemCanAcceptManualChildren, PageFlags } from "../items/base/flags-item";
import { finishPendingClipboardTextItem } from "./text_clipboard_create";


let arrowKeyDown_caretPosition: number | null = null;
let arrowKeyDown_element: HTMLElement | null = null;
let beforeInputNoteTypingFlags: { itemPath: string, flags: number } | null = null;
type PendingBoundaryNavigation = { targetPath: string, targetCaretPosition: number };
type LinearEditContext = {
  containerVe: VisualElement,
  containerPath: string,
  editingVe: VisualElement,
  editingPath: string,
};
type LinearSelectionBoundary = {
  pathInfo: EditPathInfo,
  offset: number,
};
type LinearSelectionDeleteSpec = {
  context: LinearEditContext,
  orderedPaths: Array<string>,
  start: LinearSelectionBoundary,
  end: LinearSelectionBoundary,
  startIndex: number,
  endIndex: number,
};

function visualAncestorPageAcceptsManualChildAdd(path: string): boolean {
  let currentPath: string | null = path;
  while (currentPath != null && currentPath != "") {
    const currentVe = VesCache.current.readNode(currentPath);
    if (currentVe == null) {
      return true;
    }
    if (isPage(currentVe.displayItem)) {
      const page = asPageItem(currentVe.displayItem);
      return page.clientOnly !== true && itemCanAcceptManualChildren(page);
    }
    currentPath = VeFns.parentPath(currentPath);
  }
  return true;
}

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

function activeNoteTextEditTarget(store: StoreContextModel): { itemPath: string, element: HTMLElement } | null {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null || textEditInfo.itemType != ItemType.Note || textEditInfo.colNum != null) {
    return null;
  }

  const element = document.getElementById(textEditInfo.itemPath + ":title");
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  return { itemPath: textEditInfo.itemPath, element };
}

function nodeIsInsideElement(element: HTMLElement, node: Node): boolean {
  return node == element || element.contains(node);
}

function updateNoteTextSelectionInfoFromDom(store: StoreContextModel, preserveCollapsedTypingFlags: boolean): boolean {
  const target = activeNoteTextEditTarget(store);
  if (target == null) {
    store.overlay.noteTextSelectionInfo.set(null);
    return false;
  }

  const item = itemState.get(VeFns.veidFromPath(target.itemPath).itemId);
  if (item == null || !isNote(item)) {
    store.overlay.noteTextSelectionInfo.set(null);
    return false;
  }

  const selection = window.getSelection();
  if (selection == null || selection.rangeCount == 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  if (!nodeIsInsideElement(target.element, range.startContainer) || !nodeIsInsideElement(target.element, range.endContainer)) {
    return false;
  }

  const note = asNoteItem(item);
  const start = Math.max(0, Math.min(getTextOffsetWithinElement(target.element, range.startContainer, range.startOffset), note.title.length));
  const end = Math.max(0, Math.min(getTextOffsetWithinElement(target.element, range.endContainer, range.endOffset), note.title.length));
  const orderedStart = Math.min(start, end);
  const orderedEnd = Math.max(start, end);
  const previous = store.overlay.noteTextSelectionInfo.get();
  let typingFlags = orderedStart == orderedEnd
    ? noteInlineFlagsAtPosition(note.inlineMarks, note.title, orderedStart)
    : noteInlineFlagsForRange(note.inlineMarks, note.title, orderedStart, orderedEnd);

  if (
    preserveCollapsedTypingFlags &&
    orderedStart == orderedEnd &&
    previous != null &&
    previous.itemPath == target.itemPath &&
    previous.start == orderedStart &&
    previous.end == orderedEnd
  ) {
    typingFlags = previous.typingFlags;
  }

  store.overlay.noteTextSelectionInfo.set({
    itemPath: target.itemPath,
    start: orderedStart,
    end: orderedEnd,
    typingFlags,
  });
  store.touchToolbar();
  return true;
}

function noteInputTypingFlags(store: StoreContextModel, itemPath: string): number {
  if (beforeInputNoteTypingFlags != null && beforeInputNoteTypingFlags.itemPath == itemPath) {
    return beforeInputNoteTypingFlags.flags;
  }

  const selectionInfo = store.overlay.noteTextSelectionInfo.get();
  if (selectionInfo != null && selectionInfo.itemPath == itemPath) {
    return selectionInfo.typingFlags;
  }

  return 0;
}

function restoreNoteTextSelection(store: StoreContextModel, itemPath: string, start: number, end: number, preserveCollapsedTypingFlags: boolean): void {
  const element = document.getElementById(itemPath + ":title");
  if (!(element instanceof HTMLElement)) { return; }
  if (document.activeElement !== element) {
    element.focus();
  }
  setTextSelection(element, start, end);
  updateNoteTextSelectionInfoFromDom(store, preserveCollapsedTypingFlags);
}

function persistCurrentEditTarget(store: StoreContextModel) {
  const editInfo = store.overlay.textEditInfo();
  const item = editInfo == null
    ? store.history.getFocusItem()
    : itemState.get(VeFns.veidFromPath(editInfo.itemPath).itemId) ?? store.history.getFocusItem();
  itemState.sortParentChildrenIfTitleOrdered(item);
  serverOrRemote.updateItem(item, store.general.networkStatus);
}

function setNoteTitleFromEditedText(noteItem: ReturnType<typeof asNoteItem>, nextTitle: string, typingFlags: number): void {
  const oldTitle = noteItem.title;
  if (oldTitle != nextTitle) {
    noteItem.inlineMarks = updateNoteInlineMarksForTextChange(noteItem.inlineMarks, oldTitle, nextTitle, typingFlags);
    noteItem.urls = updateNoteUrlsForTextChange(noteItem.urls, oldTitle, nextTitle);
  }
  noteItem.title = nextTitle;
  NoteFns.ensureTitleUrl(noteItem);
}

export function commitActiveTextEdit(
  store: StoreContextModel,
  preserveFocus: boolean = false,
  arrangeReason: string = "text-edit-commit",
): boolean {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null) { return false; }

  const editingItemPath = textEditInfo.itemPath;
  const editingDomId = textEditInfo.colNum != null
    ? editingItemPath + ":col" + textEditInfo.colNum
    : editingItemPath + ":title";
  const editingDomEl = document.getElementById(editingDomId);
  const item = itemState.get(VeFns.veidFromPath(editingItemPath).itemId);

  if (editingDomEl && item != null) {
    const newText = editingDomEl instanceof HTMLInputElement ? editingDomEl.value : editingDomEl.innerText;

    if (textEditInfo.itemType == ItemType.Table) {
      if (textEditInfo.colNum == null) {
        asTableItem(item).title = trimNewline(newText);
      } else {
        asTableItem(item).tableColumns[textEditInfo.colNum].name = trimNewline(newText);
      }
    }
    else if (textEditInfo.itemType == ItemType.Page) {
      asPageItem(item).title = trimNewline(newText);
    }
    else if (textEditInfo.itemType == ItemType.Composite) {
      asCompositeItem(item).title = trimNewline(newText);
    }
    else if (textEditInfo.itemType == ItemType.Note) {
      editingDomEl.parentElement!.scrollLeft = 0;
      const noteItem = asNoteItem(item);
      setNoteTitleFromEditedText(noteItem, trimNewline(newText), 0);
    }
    else if (textEditInfo.itemType == ItemType.File) {
      editingDomEl.parentElement!.scrollLeft = 0;
      asFileItem(item).title = trimNewline(newText);
    }
    let handledPendingClipboardText = false;

    if (textEditInfo.itemType == ItemType.Text) {
      editingDomEl.parentElement!.scrollLeft = 0;
      asTextItem(item).title = trimNewline(newText);
      handledPendingClipboardText = finishPendingClipboardTextItem(store, editingItemPath, newText);
    }
    else if (textEditInfo.itemType == ItemType.Password) {
      editingDomEl.parentElement!.scrollLeft = 0;
      asPasswordItem(item).text = trimNewline(newText);
    }
    else if (textEditInfo.itemType == ItemType.Image) {
      asImageItem(item).title = trimNewline(newText);
    }
    else if (textEditInfo.itemType == ItemType.Search) {
      store.perItem.setSearchQuery(item.id, trimNewline(newText).replace(/\u200B/g, ""));
    }

    itemState.sortParentChildrenIfTitleOrdered(item);
    if (textEditInfo.itemType != ItemType.Search && !handledPendingClipboardText) {
      serverOrRemote.updateItem(item, store.general.networkStatus);
    }
  }

  store.overlay.toolbarPopupInfoMaybe.set(null);
  store.overlay.setTextEditInfo(store.history, null, preserveFocus);
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const selection = window.getSelection();
  if (selection != null) { selection.removeAllRanges(); }
  arrangeNow(store, arrangeReason);
  return true;
}

function editableItemType(ve: VisualElement): ItemType | null {
  if (isNote(ve.displayItem)) { return ItemType.Note; }
  if (isFile(ve.displayItem)) { return ItemType.File; }
  if (isText(ve.displayItem)) { return ItemType.Text; }
  if (isPassword(ve.displayItem)) { return ItemType.Password; }
  if (isPage(ve.displayItem)) { return ItemType.Page; }
  if (isTable(ve.displayItem)) { return ItemType.Table; }
  if (isComposite(ve.displayItem)) { return ItemType.Composite; }
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
  if (nextTextEditInfo.itemType == ItemType.Note) {
    updateNoteTextSelectionInfoFromDom(store, false);
  }
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

function editablePathsInLinearContainer(context: LinearEditContext): Array<string> {
  const orderedPaths: Array<string> = [];
  if (isPage(context.containerVe.displayItem) &&
    asPageItem(context.containerVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    !(asPageItem(context.containerVe.displayItem).flags & PageFlags.HideDocumentTitle)) {
    orderedPaths.push(context.containerPath);
  }

  const childVes = VesCache.current.readStructuralChildren(context.containerPath);
  for (const childVe of childVes) {
    if (editableItemType(childVe) == null) { continue; }
    orderedPaths.push(VeFns.veToPath(childVe));
  }

  return orderedPaths;
}

function supportsLinearSelectionDeletePath(
  context: LinearEditContext,
  path: string,
  allowContainerTitle: boolean,
): boolean {
  if (path == context.containerPath) {
    return allowContainerTitle &&
      isPage(context.containerVe.displayItem) &&
      asPageItem(context.containerVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
      !(asPageItem(context.containerVe.displayItem).flags & PageFlags.HideDocumentTitle);
  }

  const item = itemState.get(VeFns.veidFromPath(path).itemId);
  return !!item && (isNote(item) || isFile(item) || isText(item));
}

function textForLinearSelectionDeletePath(context: LinearEditContext, path: string): string | null {
  if (path == context.containerPath) {
    if (!isPage(context.containerVe.displayItem)) { return null; }
    return asPageItem(context.containerVe.displayItem).title;
  }

  const item = itemState.get(VeFns.veidFromPath(path).itemId);
  if (item == null || (!isNote(item) && !isFile(item) && !isText(item))) { return null; }
  return asTitledItem(item).title;
}

function setTextForLinearSelectionDeletePath(context: LinearEditContext, path: string, text: string): boolean {
  if (path == context.containerPath) {
    const pageItem = itemState.get(context.containerVe.displayItem.id);
    if (pageItem == null || !isPage(pageItem)) { return false; }
    asPageItem(pageItem).title = text;
    return true;
  }

  const item = itemState.get(VeFns.veidFromPath(path).itemId);
  if (item == null || (!isNote(item) && !isFile(item) && !isText(item))) { return false; }
  if (isNote(item)) {
    setNoteTitleFromEditedText(asNoteItem(item), text, 0);
  } else {
    asTitledItem(item).title = text;
  }
  return true;
}

function persistLinearSelectionDeletePath(store: StoreContextModel, context: LinearEditContext, path: string): void {
  if (path == context.containerPath) {
    const pageItem = itemState.get(context.containerVe.displayItem.id);
    if (pageItem != null) {
      serverOrRemote.updateItem(pageItem, store.general.networkStatus);
    }
    return;
  }

  const item = itemState.get(VeFns.veidFromPath(path).itemId);
  if (item != null) {
    serverOrRemote.updateItem(item, store.general.networkStatus);
  }
}

function linearSelectionBoundaryFromRangeBoundary(node: Node, offset: number): LinearSelectionBoundary | null {
  const pathInfo = getEditPathInfoForNode(node);
  if (pathInfo == null || pathInfo.type != EditElementType.Title) { return null; }

  const editingElement = document.getElementById(editPathInfoToDomId(pathInfo));
  if (!(editingElement instanceof HTMLElement)) { return null; }

  return {
    pathInfo,
    offset: getTextOffsetWithinElement(editingElement, node, offset),
  };
}

function maybeBuildLinearSelectionDeleteSpec(store: StoreContextModel, key: string): LinearSelectionDeleteSpec | null {
  if (key != "Backspace" && key != "Delete") { return null; }

  const context = currentLinearEditContext(store);
  if (context == null) { return null; }

  const selection = window.getSelection();
  if (selection == null || selection.rangeCount == 0 || selection.isCollapsed) { return null; }

  const range = selection.getRangeAt(0);
  const start = linearSelectionBoundaryFromRangeBoundary(range.startContainer, range.startOffset);
  const end = linearSelectionBoundaryFromRangeBoundary(range.endContainer, range.endOffset);
  if (start == null || end == null) { return null; }

  const orderedPaths = editablePathsInLinearContainer(context);
  const startIndex = orderedPaths.indexOf(start.pathInfo.path);
  const endIndex = orderedPaths.indexOf(end.pathInfo.path);
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) { return null; }

  for (let i = startIndex; i <= endIndex; ++i) {
    if (!supportsLinearSelectionDeletePath(context, orderedPaths[i], i == startIndex)) {
      return null;
    }
  }

  return {
    context,
    orderedPaths,
    start,
    end,
    startIndex,
    endIndex,
  };
}

function focusAfterLinearSelectionDelete(
  store: StoreContextModel,
  deleteSpec: LinearSelectionDeleteSpec,
  keepStartPath: boolean,
  startCaretPosition: number,
): void {
  arrangeNow(store, "linear-delete-selection");

  if (keepStartPath && focusTextEditPathInfo(store, deleteSpec.start.pathInfo, startCaretPosition)) {
    return;
  }

  const prevPath = deleteSpec.startIndex > 0
    ? deleteSpec.orderedPaths[deleteSpec.startIndex - 1]
    : null;
  if (prevPath != null) {
    const prevText = textForLinearSelectionDeletePath(deleteSpec.context, prevPath);
    if (prevText != null && focusTextEditPathInfo(store, {
      path: prevPath,
      type: EditElementType.Title,
      colNumMaybe: null,
    }, prevText.length)) {
      return;
    }
  }

  const nextPath = deleteSpec.endIndex + 1 < deleteSpec.orderedPaths.length
    ? deleteSpec.orderedPaths[deleteSpec.endIndex + 1]
    : null;
  if (nextPath != null && focusTextEditPathInfo(store, {
    path: nextPath,
    type: EditElementType.Title,
    colNumMaybe: null,
  }, 0)) {
    return;
  }

  store.overlay.setTextEditInfo(store.history, null);
  arrangeNow(store, "linear-delete-selection-exit-edit");
}

function temporaryFocusPathAfterLinearSelectionDelete(
  deleteSpec: LinearSelectionDeleteSpec,
  keepStartPath: boolean,
): string {
  if (keepStartPath) {
    return deleteSpec.start.pathInfo.path;
  }

  if (deleteSpec.startIndex > 0) {
    return deleteSpec.orderedPaths[deleteSpec.startIndex - 1];
  }

  if (deleteSpec.endIndex + 1 < deleteSpec.orderedPaths.length) {
    return deleteSpec.orderedPaths[deleteSpec.endIndex + 1];
  }

  return deleteSpec.context.containerPath;
}

function deleteLinearSelectionMaybe(store: StoreContextModel, deleteSpec: LinearSelectionDeleteSpec): boolean {
  const startPath = deleteSpec.start.pathInfo.path;
  const endPath = deleteSpec.end.pathInfo.path;
  const startText = textForLinearSelectionDeletePath(deleteSpec.context, startPath);
  const endText = textForLinearSelectionDeletePath(deleteSpec.context, endPath);
  if (startText == null || endText == null) { return false; }

  const startOffset = Math.max(0, Math.min(deleteSpec.start.offset, startText.length));
  const endOffset = Math.max(0, Math.min(deleteSpec.end.offset, endText.length));
  const mergedText = startText.substring(0, startOffset) + endText.substring(endOffset);

  const pathsToDelete = deleteSpec.orderedPaths.slice(deleteSpec.startIndex + 1, deleteSpec.endIndex + 1);
  let keepStartPath = true;
  if (startPath != deleteSpec.context.containerPath && mergedText.length == 0) {
    keepStartPath = false;
    pathsToDelete.unshift(startPath);
  } else {
    if (!setTextForLinearSelectionDeletePath(deleteSpec.context, startPath, mergedText)) {
      return false;
    }
    persistLinearSelectionDeletePath(store, deleteSpec.context, startPath);
  }

  // Move focus and edit state off any soon-to-be-deleted note before itemState.delete()
  // triggers reactive reads like the toolbar.
  store.overlay.setTextEditInfo(store.history, null);
  store.history.setFocus(temporaryFocusPathAfterLinearSelectionDelete(deleteSpec, keepStartPath));

  for (const path of pathsToDelete) {
    if (path == deleteSpec.context.containerPath) { continue; }
    const item = itemState.get(VeFns.veidFromPath(path).itemId);
    if (item == null) { continue; }
    itemState.delete(item.id);
    server.deleteItem(item.id, store.general.networkStatus);
  }

  focusAfterLinearSelectionDelete(store, deleteSpec, keepStartPath, startOffset);
  return true;
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

export function splitDocumentTitleToFirstNote(
  store: StoreContextModel,
  documentPageVe: VisualElement,
  titleElement: HTMLElement,
): boolean {
  if (!isPage(documentPageVe.displayItem)) { return false; }
  const page = asPageItem(documentPageVe.displayItem);
  if (page.arrangeAlgorithm != ArrangeAlgorithm.Document ||
      (page.flags & PageFlags.HideDocumentTitle) ||
      page.clientOnly === true ||
      !itemCanAcceptManualChildren(page)) {
    return false;
  }

  const titleText = trimNewline(titleElement.innerText);
  const caretPosition = Math.min(getCaretPosition(titleElement), titleText.length);
  const beforeText = titleText.substring(0, caretPosition);
  const afterText = titleText.substring(caretPosition);

  page.title = beforeText;
  serverOrRemote.updateItem(page, store.general.networkStatus);

  const note = NoteFns.create(
    page.ownerId,
    page.id,
    RelationshipToParent.Child,
    afterText,
    itemState.newOrderingAtBeginningOfChildren(page.id),
  );
  itemState.add(note);
  server.addItem(note, null, store.general.networkStatus);
  arrangeNow(store, "document-title-enter-create-first-note");
  focusItemInLinearContainer(store, VeFns.veToPath(documentPageVe), note.id, 0);
  return true;
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

function clearArrowKeyTracking(): void {
  arrowKeyDown_caretPosition = null;
  arrowKeyDown_element = null;
  arrowKeyDown_pendingBoundaryNavigation = null;
}

function applyLinearBoundaryNavigation(store: StoreContextModel, navigation: PendingBoundaryNavigation): boolean {
  logLinearEdit("keydown-applying-boundary-navigation", {
    currentEditingPath: store.history.getFocusPathMaybe(),
    targetPath: navigation.targetPath,
    targetCaretPosition: navigation.targetCaretPosition,
  });
  arrowKeyDown_pendingBoundaryNavigation = navigation;
  persistCurrentEditTarget(store);
  const didFocus = focusTextEditPathInfo(store, {
    path: navigation.targetPath,
    type: EditElementType.Title,
    colNumMaybe: null,
  }, navigation.targetCaretPosition);
  clearArrowKeyTracking();
  return didFocus;
}

export function textEditSelectionChangeListener(store: StoreContextModel) {
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

  updateNoteTextSelectionInfoFromDom(store, true);
}

export const edit_beforeInputHandler = (store: StoreContextModel, _ev: InputEvent) => {
  const target = activeNoteTextEditTarget(store);
  if (target == null) {
    beforeInputNoteTypingFlags = null;
    return;
  }

  updateNoteTextSelectionInfoFromDom(store, true);
  beforeInputNoteTypingFlags = {
    itemPath: target.itemPath,
    flags: store.overlay.noteTextSelectionInfo.get()?.typingFlags ?? 0,
  };
}

export function toggleActiveNoteInlineMark(store: StoreContextModel, flag: NoteInlineMarkFlags): void {
  const target = activeNoteTextEditTarget(store);
  if (target == null) { return; }

  let selectionInfo = store.overlay.noteTextSelectionInfo.get();
  if (selectionInfo == null || selectionInfo.itemPath != target.itemPath) {
    updateNoteTextSelectionInfoFromDom(store, true);
    selectionInfo = store.overlay.noteTextSelectionInfo.get();
  }
  if (selectionInfo == null || selectionInfo.itemPath != target.itemPath) { return; }

  const item = itemState.get(VeFns.veidFromPath(target.itemPath).itemId);
  if (item == null || !isNote(item)) { return; }
  const note = asNoteItem(item);

  if (selectionInfo.start == selectionInfo.end) {
    const typingFlags = selectionInfo.typingFlags ^ flag;
    store.overlay.noteTextSelectionInfo.set({ ...selectionInfo, typingFlags });
    restoreNoteTextSelection(store, target.itemPath, selectionInfo.start, selectionInfo.end, true);
    store.touchToolbar();
    return;
  }

  note.inlineMarks = toggleNoteInlineMarkFlag(note.inlineMarks, note.title, selectionInfo.start, selectionInfo.end, flag);
  const typingFlags = noteInlineFlagsForRange(note.inlineMarks, note.title, selectionInfo.start, selectionInfo.end);
  store.overlay.noteTextSelectionInfo.set({ ...selectionInfo, typingFlags });
  serverOrRemote.updateItem(note, store.general.networkStatus);
  arrangeNow(store, "toolbar-note-inline-mark");
  restoreNoteTextSelection(store, target.itemPath, selectionInfo.start, selectionInfo.end, false);
}

export const edit_keyUpHandler = (store: StoreContextModel, ev: KeyboardEvent) => {
  if (isArrowKey(ev.key)) {
    keyUp_Arrow(store);
  }
}

const keyUp_Arrow = (store: StoreContextModel) => {
  const pendingBoundaryNavigation = arrowKeyDown_pendingBoundaryNavigation;
  clearArrowKeyTracking();

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
  const currentEditingPath = store.history.getFocusPathMaybe();
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
    logLinearEdit("keyup-boundary-navigation-already-handled", {
      currentEditingPath,
      targetPath: pendingBoundaryNavigation.targetPath,
      targetCaretPosition: pendingBoundaryNavigation.targetCaretPosition,
    });
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
    if (!(textElement instanceof HTMLElement)) { return; }
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
      applyLinearBoundaryNavigation(store, arrowKeyDown_pendingBoundaryNavigation);
    }
    return;
  }

  const linearSelectionDeleteSpec = maybeBuildLinearSelectionDeleteSpec(store, ev.key);
  if (linearSelectionDeleteSpec != null) {
    ev.preventDefault();
    ev.stopPropagation();
    deleteLinearSelectionMaybe(store, linearSelectionDeleteSpec);
    return;
  }

  switch (ev.key) {
    case "Backspace":
      const el = currentCaretElement();
      if (!(el instanceof HTMLElement)) { return; }
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

  if (!isNote(upFocusItem) && !isFile(upFocusItem) && !isText(upFocusItem)) { return; }
  const upTextLength = upFocusItem.title.length;
  if (isNote(upFocusItem)) {
    const upNote = asNoteItem(upFocusItem);
    const initialNote = asNoteItem(initialEditingItem);
    const initialText = asTitledItem(context.editingVe.displayItem).title;
    upNote.inlineMarks = concatNoteInlineMarks(
      upNote.inlineMarks,
      upFocusItem.title,
      initialNote.inlineMarks,
      initialText,
    );
    upNote.urls = concatNoteUrls(
      upNote.urls,
      upFocusItem.title,
      initialNote.urls,
      initialText,
    );
  }
  upFocusItem.title = upFocusItem.title + asTitledItem(context.editingVe.displayItem).title;

  store.history.setFocus(upPath);
  arrangeNow(store, "join-items-focus-up-item");

  server.updateItem(upFocusItem, store.general.networkStatus);
  itemState.delete(initialEditingItem.id);
  server.deleteItem(initialEditingItem.id, store.general.networkStatus);

  if (isComposite(context.containerVe.displayItem)) {
    const compositeItem = asCompositeItem(context.containerVe.displayItem);
    assert(compositeItem.computed_children.length != 0, "composite item does not have any children.");
    if (compositeItem.computed_children.length == 1 && !CompositeFns.hasOwnTitle(compositeItem)) {
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
  if (!visualAncestorPageAcceptsManualChildAdd(context.containerPath)) { return; }

  if (context.editingPath == context.containerPath) {
    const titleElement = document.getElementById(context.editingPath + ":title");
    if (titleElement instanceof HTMLElement &&
      splitDocumentTitleToFirstNote(store, context.containerVe, titleElement)) {
      return;
    }
  }

  const noteVeid = VeFns.veidFromPath(context.editingPath);
  const item = itemState.get(noteVeid.itemId)!;
  if (!isNote(item) && !isFile(item) && !isText(item)) { return; }
  if (isText(item) && finishPendingClipboardTextItem(store, context.editingPath, document.getElementById(context.editingPath + ":title")?.textContent ?? "")) {
    store.overlay.setTextEditInfo(store.history, null, false);
    arrangeNow(store, "clipboard-text-enter-commit");
    return;
  }
  const titledItem = asTitledItem(item);

  const editingDomId = context.editingPath + ":title";
  const textElement = document.getElementById(editingDomId);
  const caretPosition = getCaretPosition(textElement!);

  const beforeText = textElement!.innerText.substring(0, caretPosition);
  const afterText = textElement!.innerText.substring(caretPosition);
  let afterInlineMarks = null;
  let afterUrls = null;
  if (isNote(item)) {
    const splitMarks = splitNoteInlineMarks(asNoteItem(item).inlineMarks, titledItem.title, caretPosition);
    asNoteItem(item).inlineMarks = splitMarks[0];
    afterInlineMarks = splitMarks[1];
    const splitUrls = splitNoteUrls(asNoteItem(item).urls, titledItem.title, caretPosition);
    asNoteItem(item).urls = splitUrls[0];
    afterUrls = splitUrls[1];
  }

  titledItem.title = beforeText;
  if (isNote(item)) {
    NoteFns.ensureTitleUrl(asNoteItem(item));
  }

  serverOrRemote.updateItem(titledItem, store.general.networkStatus);

  const ordering = itemState.newOrderingDirectlyAfterChild(context.containerVe.displayItem.id, VeFns.treeItemFromVeid(noteVeid)!.id);
  const note = NoteFns.create(titledItem.ownerId, context.containerVe.displayItem.id, RelationshipToParent.Child, "", ordering);
  note.title = afterText;
  if (afterInlineMarks != null) {
    note.inlineMarks = afterInlineMarks;
  }
  if (afterUrls != null) {
    note.urls = afterUrls;
  }
  itemState.add(note);
  server.addItem(note, null, store.general.networkStatus);
  arrangeNow(store, "enter-key-create-note");

  focusItemInLinearContainer(store, context.containerPath, note.id, 0);
}

export const edit_inputListener = (store: StoreContextModel, _ev: InputEvent) => {
  const capturedBeforeInputNoteTypingFlags = beforeInputNoteTypingFlags;
  setTimeout(() => {
    if (store.overlay.textEditInfo()) {
      const colNum = store.overlay.textEditInfo()!.colNum;
      const focusItemPath = store.history.getFocusPath();
      const focusItemDomId = colNum == null
        ? focusItemPath + ":title"
        : focusItemPath + ":col" + colNum;
      const el = document.getElementById(focusItemDomId);
      if (!(el instanceof HTMLElement)) { return; }
      const newText = trimNewline(el!.innerText);
      if (!store.overlay.toolbarPopupInfoMaybe.get()) {
        if (store.overlay.textEditInfo()!.itemType == ItemType.Note) {
          let item = asNoteItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          const oldTitle = item.title;
          const typingFlags = capturedBeforeInputNoteTypingFlags != null && capturedBeforeInputNoteTypingFlags.itemPath == focusItemPath
            ? capturedBeforeInputNoteTypingFlags.flags
            : noteInputTypingFlags(store, focusItemPath);
          if (oldTitle != newText) {
            item.inlineMarks = updateNoteInlineMarksForTextChange(item.inlineMarks, oldTitle, newText, typingFlags);
            item.urls = updateNoteUrlsForTextChange(item.urls, oldTitle, newText);
          }
          item.title = newText;
          NoteFns.ensureTitleUrl(item);
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.File) {
          let item = asFileItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Text) {
          let item = asTextItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Password) {
          let item = asPasswordItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.text = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Page) {
          let item = asPageItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Composite) {
          let item = asCompositeItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Image) {
          let item = asImageItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          item.title = newText;
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Table) {
          let item = asTableItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
          if (colNum == null) {
            item.title = newText;
          } else {
            item.tableColumns[colNum].name = newText;
          }
        } else {
          console.warn("input handler for item type " + store.overlay.textEditInfo()!.itemType + " not implemented.");
        }
        if (newText == "") {
          restoreContentEditablePlaceholderIfEmpty(el);
        }
        const caretPosition = newText == "" ? 0 : getCaretPosition(el!);
        arrangeNow(store, "text-edit-input-preserve-caret");
        const el_ = document.getElementById(focusItemDomId);
        if (el_ instanceof HTMLElement) {
          if (document.activeElement !== el_) {
            el_.focus();
          }
          setCaretPosition(el_, caretPosition);
          if (store.overlay.textEditInfo()?.itemType == ItemType.Note) {
            updateNoteTextSelectionInfoFromDom(store, false);
          }
        }
        beforeInputNoteTypingFlags = null;
      }
    }
  }, 0);
}
