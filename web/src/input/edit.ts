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
} from "../items/note-item";
import { trimNewline, restoreContentEditablePlaceholderIfEmpty } from "../util/string";
import { readEditableText } from "../util/editable_text";
import { arrangeNow } from "../layout/arrange";
import { VesCache } from "../layout/ves-cache";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { panic } from "../util/lang";
import { isFile } from "../items/file-item";
import { isText } from "../items/text-item";
import { ItemType } from "../items/base/item";
import { asPositionalItem } from "../items/base/positional-item";
import { asXSizableItem } from "../items/base/x-sizeable-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { isArrowKey } from "../input/key";
import { isTable } from "../items/table-item";
import { closestCaretPositionToClientPx, EditElementType, type EditPathInfo, editPathInfoToDomId, getCurrentCaretVePath_title as getCurrentCaretVeInfo, getCaretLineRect, getCaretPosition, getEditPathInfoForNode, getTextOffsetWithinElement, setCaretPosition, setDirectionalTextSelection, textSelectionOffsets } from "../util/caret";
import { asCompositeItem, CompositeFns, isComposite } from "../items/composite-item";
import { itemState } from "../store/ItemState";
import { VeFns, VisualElement } from "../layout/visual-element";
import { asTitledItem } from "../items/base/titled-item";
import { StoreContextModel } from "../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { itemCanAcceptManualChildren, NoteFlags, PageFlags } from "../items/base/flags-item";
import { textEditElementId, type TextEditSession } from "./text_edit_session";
import { structuralTextContainerIsEditable, structuralTextNote } from "./structural_text_edit";
import { asContainerItem } from "../items/base/container-item";
import { itemCanEdit, itemCanMove } from "../items/base/capabilities-item";
import { reconcileNoteEditableDom } from "./note_editable_dom";
import { planNoteParagraphSplit } from "./note_paragraph";
import { TransientMessageType } from "../store/StoreProvider_Overlay";


let arrowKeyDown_caretPosition: number | null = null;
let arrowKeyDown_element: HTMLElement | null = null;
let beforeInputNoteTypingFlags: { itemPath: string, flags: number } | null = null;
type PendingBoundaryNavigation = { targetPath: string, targetCaretPosition: number };
type LinearBoundaryNavigationKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
type LinearBoundaryNavigationModifiers = {
  shiftKey: boolean,
  altKey: boolean,
  ctrlKey: boolean,
  metaKey: boolean,
};
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

function visualAncestorPageIsClientOnly(path: string): boolean {
  let currentPath: string | null = path;
  while (currentPath != null && currentPath != "") {
    const currentVe = VesCache.current.readNode(currentPath);
    if (currentVe == null) {
      return false;
    }
    if (isPage(currentVe.displayItem)) {
      const page = asPageItem(currentVe.displayItem);
      return page.clientOnly === true;
    }
    currentPath = VeFns.parentPath(currentPath);
  }
  return false;
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

function restoreNoteTextSelection(store: StoreContextModel, itemPath: string, start: number, end: number, preserveCollapsedTypingFlags: boolean, backward: boolean = false): void {
  const element = document.getElementById(itemPath + ":title");
  if (!(element instanceof HTMLElement)) { return; }
  if (document.activeElement !== element) {
    element.focus();
  }
  setDirectionalTextSelection(element, backward ? end : start, backward ? start : end);
  updateNoteTextSelectionInfoFromDom(store, preserveCollapsedTypingFlags);
}

function persistCurrentEditTarget(store: StoreContextModel) {
  store.textEdit.flushActive();
}

export function commitActiveTextEdit(
  store: StoreContextModel,
  preserveFocus: boolean = false,
  arrangeReason: string = "text-edit-commit",
  arrange: boolean = true,
): boolean {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null) { return false; }

  const element = document.getElementById(textEditElementId(textEditInfo));
  // setTextEditInfo owns the commit, including any final DOM input and pending save.
  store.overlay.setTextEditInfo(store.history, null, preserveFocus);
  store.overlay.toolbarPopupInfoMaybe.set(null);
  if (element?.parentElement) { element.parentElement.scrollLeft = 0; }
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  window.getSelection()?.removeAllRanges();
  if (arrange) { arrangeNow(store, arrangeReason); }
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

function structuralPathsInLinearContainer(context: LinearEditContext): Array<string> {
  const orderedPaths: Array<string> = [];
  if (isPage(context.containerVe.displayItem) &&
    asPageItem(context.containerVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    !(asPageItem(context.containerVe.displayItem).flags & PageFlags.HideDocumentTitle)) {
    orderedPaths.push(context.containerPath);
  }

  const childVes = VesCache.current.readStructuralChildren(context.containerPath);
  const container = itemState.get(context.containerVe.displayItem.id);
  if (container == null) { return []; }
  // Include every model child, even blocks with no editable title or no rendered
  // node. Such blocks must remain boundaries rather than disappear from a range.
  for (const childId of asContainerItem(container).computed_children) {
    const childVe = childVes.find(ve => (ve.actualLinkItemMaybe?.id ?? VeFns.treeItem(ve).id) == childId);
    orderedPaths.push(childVe ? VeFns.veToPath(childVe) : VeFns.addVeidToPath({ itemId: childId, linkIdMaybe: null }, context.containerPath));
  }
  return orderedPaths;
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

function maybeBuildLinearSelectionDeleteSpec(store: StoreContextModel, range: AbstractRange): LinearSelectionDeleteSpec | null {
  const context = currentLinearEditContext(store);
  if (context == null || range.collapsed) { return null; }
  const start = linearSelectionBoundaryFromRangeBoundary(range.startContainer, range.startOffset);
  const end = linearSelectionBoundaryFromRangeBoundary(range.endContainer, range.endOffset);
  if (start == null || end == null) { return null; }

  const orderedPaths = structuralPathsInLinearContainer(context);
  const startIndex = orderedPaths.indexOf(start.pathInfo.path);
  const endIndex = orderedPaths.indexOf(end.pathInfo.path);
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) { return null; }

  for (let i = startIndex; i <= endIndex; ++i) {
    if (structuralTextNote(store, VesCache.current.readNode(orderedPaths[i]), context.containerVe) == null) {
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

const STRUCTURAL_TEXT_BOUNDARY_MESSAGE = "Only adjacent, directly editable local notes without attachments or groups can be joined or deleted together.";

function stopStructuralTextEvent(ev: Event): void {
  ev.preventDefault();
  ev.stopImmediatePropagation();
}

function blockStructuralTextEvent(store: StoreContextModel, ev: Event, text: string): true {
  stopStructuralTextEvent(ev);
  // Pending input rendering must not replace the selection we just protected.
  const session = store.textEdit.activeSession();
  if (session != null) { ++session.inputRevision; }
  clearArrowKeyTracking();
  const message = { text, type: TransientMessageType.Info };
  store.overlay.toolbarTransientMessage.set(message);
  setTimeout(() => {
    if (store.overlay.toolbarTransientMessage.get() === message) {
      store.overlay.toolbarTransientMessage.set(null);
    }
  }, 3000);
  return true;
}

function linearEditorForEvent(store: StoreContextModel, ev: Event): HTMLElement | null {
  const info = store.overlay.textEditInfo();
  if (info == null || !(ev.target instanceof HTMLElement) || !ev.target.isContentEditable ||
      ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) { return null; }
  const element = document.getElementById(textEditElementId(info));
  if (!(element instanceof HTMLElement) ||
      (!element.contains(ev.target) && !ev.target.contains(element))) { return null; }

  // Include nested editors (e.g. table cells) when checking selection boundaries.
  // They cannot participate in a note operation, but their DOM still needs protection.
  let path: string | null = info.itemPath;
  while (path) {
    const ve = VesCache.current.readNode(path);
    if (ve == null) { return null; }
    if (isLinearEditableContainer(ve)) { return element; }
    if (isPage(ve.displayItem)) { return null; }
    path = VeFns.parentPath(path);
  }
  return null;
}

function rangeIsInsideEditor(range: AbstractRange, element: HTMLElement): boolean {
  return nodeIsInsideElement(element, range.startContainer) && nodeIsInsideElement(element, range.endContainer);
}

function guardLinearSelection(
  store: StoreContextModel,
  ev: Event,
  element: HTMLElement,
  ranges: ReadonlyArray<AbstractRange>,
  allowNoteDeletion: boolean,
): boolean {
  if (ranges.length == 1 && rangeIsInsideEditor(ranges[0], element)) { return false; }
  if (ranges.length == 1 && allowNoteDeletion) {
    const spec = maybeBuildLinearSelectionDeleteSpec(store, ranges[0]);
    if (spec != null) {
      stopStructuralTextEvent(ev);
      deleteLinearSelectionMaybe(store, spec);
      return true;
    }
  }
  return blockStructuralTextEvent(store, ev, allowNoteDeletion
    ? STRUCTURAL_TEXT_BOUNDARY_MESSAGE
    : "Edit one item at a time. This selection crosses an item boundary.");
}

function currentSelectionRanges(): Array<Range> {
  const selection = window.getSelection();
  return selection == null ? [] : Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
}

function adjacentStructuralPath(context: LinearEditContext, backward: boolean): string | null {
  const paths = structuralPathsInLinearContainer(context);
  const index = paths.indexOf(context.editingPath);
  return index < 0 ? null : paths[index + (backward ? -1 : 1)] ?? null;
}

function guardLinearBoundaryDeletion(store: StoreContextModel, ev: Event, element: HTMLElement, backward: boolean): boolean {
  const ranges = currentSelectionRanges();
  if (ranges.length != 1 || !ranges[0].collapsed || !rangeIsInsideEditor(ranges[0], element)) { return false; }
  const textLength = readEditableText(element).length;
  const offset = Math.min(textLength, getTextOffsetWithinElement(element, ranges[0].startContainer, ranges[0].startOffset));
  if (backward ? offset > 0 : offset < textLength) { return false; }

  // Never let contenteditable merge DOM blocks, including nested unsupported editors.
  stopStructuralTextEvent(ev);
  const context = currentLinearEditContext(store);
  if (context == null) { return true; }
  const adjacentPath = adjacentStructuralPath(context, backward);
  if (adjacentPath == null) { return true; }
  if (joinItemsMaybeHandler(store, backward)) { return true; }
  return blockStructuralTextEvent(store, ev, STRUCTURAL_TEXT_BOUNDARY_MESSAGE);
}

function guardLinearEnter(store: StoreContextModel, ev: Event): boolean {
  const context = currentLinearEditContext(store);
  const info = store.overlay.textEditInfo();
  if (context != null && info?.colNum == null &&
      ((context.editingPath == context.containerPath && isPage(context.containerVe.displayItem) &&
        structuralTextContainerIsEditable(store, context.containerVe)) ||
       structuralTextNote(store, context.editingVe, context.containerVe) != null)) { return false; }
  // File/text titles are labels: Enter finishes renaming without splitting the asset.
  if (context != null && (isFile(context.editingVe.displayItem) || isText(context.editingVe.displayItem))) {
    stopStructuralTextEvent(ev);
    commitActiveTextEdit(store, true, "linear-title-enter-commit");
    return true;
  }
  return blockStructuralTextEvent(store, ev, "This item cannot be split into paragraphs. Use an editable note without attachments.");
}

/** Capture before local item handlers or native contenteditable can alter structure. */
export function edit_structuralKeyDownGuard(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (edit_compositionKeyGuard(store, ev)) { return true; }
  if (ev.defaultPrevented) { return false; }
  if (ev.key == "Enter") {
    if (ev.shiftKey && edit_replaceNoteSelection(store, ev, "\n")) { return true; }
    if (!ev.shiftKey && exitEmptyNoteList(store, ev)) { return true; }
  }
  const element = linearEditorForEvent(store, ev);
  if (element == null || ev.defaultPrevented) { return false; }
  const deleting = ev.key == "Backspace" || ev.key == "Delete";
  const typing = ev.key.length == 1 && ((!ev.ctrlKey && !ev.metaKey) || ev.getModifierState("AltGraph"));
  if (!deleting && !typing && ev.key != "Enter") { return false; }
  if (guardLinearSelection(store, ev, element, currentSelectionRanges(), deleting)) { return true; }
  if (deleting) { return guardLinearBoundaryDeletion(store, ev, element, ev.key == "Backspace"); }
  return ev.key == "Enter" && guardLinearEnter(store, ev);
}

export function edit_structuralBeforeInputGuard(store: StoreContextModel, ev: InputEvent): void {
  if (ev.defaultPrevented) { return; }
  const composing = ev.isComposing || store.textEdit.activeSession()?.isComposing;
  if (!composing) {
    if (ev.inputType == "insertLineBreak" && edit_replaceNoteSelection(store, ev, "\n")) { return; }
    if (ev.inputType == "insertParagraph" && exitEmptyNoteList(store, ev)) { return; }
  }
  const element = linearEditorForEvent(store, ev);
  if (element == null || ev.defaultPrevented) { return; }
  const deleting = !composing && (ev.inputType == "deleteContentBackward" || ev.inputType == "deleteContentForward" || ev.inputType == "deleteContent");
  if (guardLinearSelection(store, ev, element, currentSelectionRanges(), deleting)) { return; }
  // Word/line deletion and mobile input may target more than the visible selection.
  const targetRanges = ev.getTargetRanges?.() ?? [];
  if (targetRanges.length > 0 && guardLinearSelection(store, ev, element, targetRanges, deleting)) { return; }
  if (composing) { return; }
  if (ev.inputType == "insertFromDrop" || ev.inputType == "deleteByDrag") {
    blockStructuralTextEvent(store, ev, "Move text within one item using cut and paste.");
    return;
  }
  if (ev.inputType.startsWith("delete") && (ev.inputType.endsWith("Backward") || ev.inputType.endsWith("Forward"))) {
    guardLinearBoundaryDeletion(store, ev, element, ev.inputType.endsWith("Backward"));
  } else if (ev.inputType == "insertParagraph" || ev.inputType == "insertLineBreak") {
    if (guardLinearEnter(store, ev)) { return; }
    stopStructuralTextEvent(ev);
    enterKeyHandler(store);
  }
}

export function edit_structuralClipboardGuard(store: StoreContextModel, ev: ClipboardEvent): boolean {
  const element = linearEditorForEvent(store, ev);
  return element != null && guardLinearSelection(store, ev, element, currentSelectionRanges(), false);
}

export function edit_structuralDropGuard(store: StoreContextModel, ev: DragEvent): void {
  if (linearEditorForEvent(store, ev) != null) {
    blockStructuralTextEvent(store, ev, "Move text within one item using cut and paste.");
  }
}

function deleteLinearSelectionMaybe(store: StoreContextModel, deleteSpec: LinearSelectionDeleteSpec): boolean {
  const startPath = deleteSpec.start.pathInfo.path;
  const endPath = deleteSpec.end.pathInfo.path;
  const startNote = structuralTextNote(store, VesCache.current.readNode(startPath), deleteSpec.context.containerVe);
  const endNote = structuralTextNote(store, VesCache.current.readNode(endPath), deleteSpec.context.containerVe);
  if (startNote == null || endNote == null) { return false; }
  // Finish the active session before changing or deleting its model item.
  store.overlay.setTextEditInfo(store.history, null);
  const startText = startNote.title;
  const endText = endNote.title;

  const startOffset = Math.max(0, Math.min(deleteSpec.start.offset, startText.length));
  const endOffset = Math.max(0, Math.min(deleteSpec.end.offset, endText.length));
  const mergedText = startText.substring(0, startOffset) + endText.substring(endOffset);

  const pathsToDelete = deleteSpec.orderedPaths.slice(deleteSpec.startIndex + 1, deleteSpec.endIndex + 1);
  // Keep the first paragraph even when the entire selection is removed. The
  // user can keep typing, and the container never loses its last editing target.
  const prefix = startText.substring(0, startOffset);
  const suffix = endText.substring(endOffset);
  startNote.inlineMarks = concatNoteInlineMarks(
    splitNoteInlineMarks(startNote.inlineMarks, startText, startOffset)[0], prefix,
    splitNoteInlineMarks(endNote.inlineMarks, endText, endOffset)[1], suffix,
  );
  startNote.urls = concatNoteUrls(
    splitNoteUrls(startNote.urls, startText, startOffset)[0], prefix,
    splitNoteUrls(endNote.urls, endText, endOffset)[1], suffix,
  );
  startNote.title = mergedText;
  NoteFns.ensureTitleUrl(startNote);
  store.textEdit.saveItem(startNote, true);

  // Move focus off any soon-to-be-deleted note before reactive reads occur.
  store.history.setFocus(startPath);

  for (const path of pathsToDelete) {
    if (path == deleteSpec.context.containerPath) { continue; }
    const item = itemState.get(VeFns.veidFromPath(path).itemId);
    if (item == null) { continue; }
    itemState.delete(item.id);
    server.deleteItem(item.id, store.general.networkStatus);
  }

  arrangeNow(store, "linear-delete-selection");
  focusTextEditPathInfo(store, deleteSpec.start.pathInfo, startOffset);
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

function isLinearBoundaryNavigationKey(key: string): key is LinearBoundaryNavigationKey {
  return key == "ArrowUp" || key == "ArrowDown" || key == "ArrowLeft" || key == "ArrowRight";
}

function isHorizontalBoundaryNavigationKey(key: LinearBoundaryNavigationKey): boolean {
  return key == "ArrowLeft" || key == "ArrowRight";
}

function linearBoundaryNavigationMovesBackward(key: LinearBoundaryNavigationKey): boolean {
  return key == "ArrowUp" || key == "ArrowLeft";
}

function shouldKeepNativeHorizontalArrowBehavior(
  key: LinearBoundaryNavigationKey,
  modifiers: LinearBoundaryNavigationModifiers,
): boolean {
  return isHorizontalBoundaryNavigationKey(key) &&
    (modifiers.shiftKey || modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey);
}

function currentSelectionIsCollapsed(): boolean {
  const selection = window.getSelection();
  return selection != null && selection.rangeCount > 0 && selection.isCollapsed;
}

function isCaretAtHorizontalBoundary(textElement: HTMLElement, caretPosition: number, key: LinearBoundaryNavigationKey): boolean {
  const textLength = readEditableText(textElement).length;
  const isBoundary = key == "ArrowLeft"
    ? caretPosition <= 0
    : caretPosition >= textLength;
  logLinearEdit("horizontal-boundary-check", {
    key,
    caretPosition,
    textLength,
    isBoundary,
    text: textElement.innerText,
  });
  return isBoundary;
}

function isCaretAtLinearBoundary(textElement: HTMLElement, caretPosition: number, key: LinearBoundaryNavigationKey): boolean {
  if (key == "ArrowUp" || key == "ArrowDown") {
    return isCaretOnBoundaryLine(textElement, caretPosition, key);
  }
  return isCaretAtHorizontalBoundary(textElement, caretPosition, key);
}

function adjacentEditableChildPathInLinearContainer(
  containerVe: VisualElement,
  currentPath: string,
  key: LinearBoundaryNavigationKey,
): string | null {
  const containerPath = VeFns.veToPath(containerVe);
  const childVes = VesCache.current.readStructuralChildren(containerPath);
  const containerHasMirroredTitle = isPage(containerVe.displayItem) &&
    asPageItem(containerVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document &&
    !(asPageItem(containerVe.displayItem).flags & PageFlags.HideDocumentTitle);

  if (currentPath == containerPath) {
    if (linearBoundaryNavigationMovesBackward(key)) { return null; }
    for (let i = 0; i < childVes.length; ++i) {
      if (editableItemType(childVes[i]) == null) { continue; }
      return VeFns.veToPath(childVes[i]);
    }
    return null;
  }

  const currentIndex = childVes.findIndex(ve => VeFns.veToPath(ve) == currentPath);
  if (currentIndex < 0) { return null; }

  const step = linearBoundaryNavigationMovesBackward(key) ? -1 : 1;
  for (let i = currentIndex + step; i >= 0 && i < childVes.length; i += step) {
    const targetVe = childVes[i];
    if (editableItemType(targetVe) == null) { continue; }
    return VeFns.veToPath(targetVe);
  }

  if (containerHasMirroredTitle && linearBoundaryNavigationMovesBackward(key) && currentIndex == 0) {
    return containerPath;
  }

  return null;
}

function adjacentEditableChildPathInCurrentLinearContext(
  context: LinearEditContext,
  key: LinearBoundaryNavigationKey,
): string | null {
  return adjacentEditableChildPathInLinearContainer(context.containerVe, context.editingPath, key);
}

function textLengthForLinearPath(context: LinearEditContext, path: string): number | null {
  if (path == context.containerPath) {
    if (!isPage(context.containerVe.displayItem)) { return null; }
    return asPageItem(context.containerVe.displayItem).title.length;
  }

  const targetVe = VesCache.current.readNode(path);
  if (targetVe == null || editableItemType(targetVe) == null) { return null; }

  const item = itemState.get(VeFns.veidFromPath(path).itemId);
  if (item == null) { return null; }
  if (isPassword(item)) { return asPasswordItem(item).text.length; }
  return asTitledItem(item).title.length;
}

function targetCaretPositionForLinearBoundaryNavigation(
  context: LinearEditContext,
  targetPath: string,
  key: LinearBoundaryNavigationKey,
  textElement: HTMLElement,
  caretPosition: number,
): number {
  if (key == "ArrowLeft") {
    return textLengthForLinearPath(context, targetPath) ?? Number.MAX_SAFE_INTEGER;
  }
  if (key == "ArrowRight") { return 0; }

  const fallbackPosition = key == "ArrowDown"
    ? 0
    : textLengthForLinearPath(context, targetPath) ?? Number.MAX_SAFE_INTEGER;
  const targetElement = document.getElementById(targetPath + ":title");
  if (!(targetElement instanceof HTMLElement) || readEditableText(targetElement) == "") {
    return fallbackPosition;
  }

  const sourceTextLength = textElement.textContent?.length ?? 0;
  const sourceLineRect = getCaretLineRect(textElement, caretPosition);
  const sourceCaretXPx = caretPosition >= sourceTextLength
    ? sourceLineRect.right
    : sourceLineRect.left;
  const targetBoundaryPosition = key == "ArrowDown"
    ? 0
    : targetElement.textContent?.length ?? 0;
  const targetBoundaryLineRect = getCaretLineRect(targetElement, targetBoundaryPosition);

  return closestCaretPositionToClientPx(targetElement, {
    x: sourceCaretXPx,
    y: targetBoundaryLineRect.top + targetBoundaryLineRect.height / 2,
  });
}

function documentEdgeBoundaryCaretPositionMaybe(
  context: LinearEditContext,
  key: LinearBoundaryNavigationKey,
  textElement: HTMLElement,
): number | null {
  if (key != "ArrowUp" && key != "ArrowDown") { return null; }
  if (!isPage(context.containerVe.displayItem) ||
    asPageItem(context.containerVe.displayItem).arrangeAlgorithm != ArrangeAlgorithm.Document ||
    context.editingPath == context.containerPath) {
    return null;
  }

  const childVes = VesCache.current.readStructuralChildren(context.containerPath);
  const currentIndex = childVes.findIndex(ve => VeFns.veToPath(ve) == context.editingPath);
  if (currentIndex < 0) { return null; }
  if (key == "ArrowUp" && currentIndex != 0) { return null; }
  if (key == "ArrowDown" && currentIndex != childVes.length - 1) { return null; }

  return key == "ArrowUp" ? 0 : readEditableText(textElement).length;
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
  const pageItem = itemState.get(documentPageVe.displayItem.id);
  if (pageItem == null || !isPage(pageItem)) { return false; }
  const page = asPageItem(pageItem);
  if (page.arrangeAlgorithm != ArrangeAlgorithm.Document ||
      (page.flags & PageFlags.HideDocumentTitle) ||
      page.clientOnly === true ||
      !structuralTextContainerIsEditable(store, documentPageVe)) {
    return false;
  }

  const titleText = trimNewline(titleElement.innerText);
  const selection = textSelectionOffsets(titleElement);
  if (selection == null || store.textEdit.activeSession()?.isComposing) { return false; }
  const start = Math.min(selection.anchor, selection.focus, titleText.length);
  const end = Math.min(Math.max(selection.anchor, selection.focus), titleText.length);
  const beforeText = titleText.substring(0, start);
  const afterText = titleText.substring(end);

  store.overlay.setTextEditInfo(store.history, null);
  page.title = beforeText;
  store.textEdit.saveItem(page, true);

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
  modifiers: LinearBoundaryNavigationModifiers,
): PendingBoundaryNavigation | null {
  const context = currentLinearEditContext(store);
  if (context == null) {
    logLinearEdit("boundary-navigation-no-linear-parent", {
      key,
      currentPath: store.overlay.textEditInfo()?.itemPath ?? null,
    });
    return null;
  }
  if (!isLinearBoundaryNavigationKey(key)) { return null; }
  if (shouldKeepNativeHorizontalArrowBehavior(key, modifiers)) { return null; }
  if (isHorizontalBoundaryNavigationKey(key) && !currentSelectionIsCollapsed()) { return null; }
  if (!isCaretAtLinearBoundary(textElement, caretPosition, key)) { return null; }

  const targetPath = adjacentEditableChildPathInCurrentLinearContext(context, key);
  if (targetPath == null) {
    const childCount = VesCache.current.readStructuralChildren(context.containerPath).length;
    const fallbackCaretPosition = documentEdgeBoundaryCaretPositionMaybe(context, key, textElement);
    if (fallbackCaretPosition != null) {
      logLinearEdit("prepared-document-edge-boundary-caret-move", {
        key,
        containerPath: context.containerPath,
        currentPath: context.editingPath,
        childCount,
        targetCaretPosition: fallbackCaretPosition,
      });
      return {
        targetPath: context.editingPath,
        targetCaretPosition: fallbackCaretPosition,
      };
    }
    logLinearEdit("no-boundary-target", { key, currentPath: context.editingPath, childCount });
    return null;
  }

  const navigation = {
    targetPath,
    targetCaretPosition: targetCaretPositionForLinearBoundaryNavigation(context, targetPath, key, textElement, caretPosition),
  };
  logLinearEdit("prepared-boundary-navigation", {
    key,
    containerPath: context.containerPath,
    currentPath: context.editingPath,
    targetPath: navigation.targetPath,
    caretPosition,
    targetCaretPosition: navigation.targetCaretPosition,
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
  if (store.overlay.textEditInfo()?.itemPath != navigation.targetPath) {
    persistCurrentEditTarget(store);
  }
  const didFocus = focusTextEditPathInfo(store, {
    path: navigation.targetPath,
    type: EditElementType.Title,
    colNumMaybe: null,
  }, navigation.targetCaretPosition);
  clearArrowKeyTracking();
  return didFocus;
}

export function textEditSelectionChangeListener(store: StoreContextModel) {
  if (store.textEdit.activeSession()?.isComposing) { return; }
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

export const edit_beforeInputHandler = (store: StoreContextModel, ev: InputEvent) => {
  if (ev.isComposing || store.textEdit.activeSession()?.isComposing) { return; }
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
  if (store.textEdit.activeSession()?.isComposing) { return; }
  const target = activeNoteTextEditTarget(store);
  if (target == null) { return; }
  const selection = textSelectionOffsets(target.element);
  const backward = selection != null && selection.anchor > selection.focus;

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
  restoreNoteTextSelection(store, target.itemPath, selectionInfo.start, selectionInfo.end, false, backward);
}

export const edit_keyUpHandler = (store: StoreContextModel, ev: KeyboardEvent) => {
  if (edit_compositionKeyGuard(store, ev)) { return; }
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
  if (ev.defaultPrevented || edit_structuralKeyDownGuard(store, ev)) { return; }
  if (ev.isComposing || ev.keyCode == 229) { return; }
  if (isArrowKey(ev.key)) {
    const itemPath = store.overlay.textEditInfo()!.itemPath;
    const editingDomId = itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    if (!(textElement instanceof HTMLElement)) { return; }
    const caretPosition = getCaretPosition(textElement!);
    arrowKeyDown_caretPosition = caretPosition;
    arrowKeyDown_element = textElement;
    arrowKeyDown_pendingBoundaryNavigation = maybeBuildLinearBoundaryNavigation(store, ev.key, textElement!, caretPosition, {
      shiftKey: ev.shiftKey,
      altKey: ev.altKey,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
    });
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

  switch (ev.key) {
    case "Enter":
      enterKeyHandler(store);
      ev.preventDefault();
      ev.stopPropagation();
      return;
  }
}

const joinItemsMaybeHandler = (store: StoreContextModel, backward: boolean): boolean => {
  const context = currentLinearEditContext(store);
  if (context == null) { return false; }
  const adjacentPath = adjacentStructuralPath(context, backward);
  if (adjacentPath == null) { return false; }
  // Both directions keep the earlier note's identity and paragraph style.
  const leftPath = backward ? adjacentPath : context.editingPath;
  const removedPath = backward ? context.editingPath : adjacentPath;
  const rightNote = structuralTextNote(store, VesCache.current.readNode(removedPath), context.containerVe);
  if (rightNote == null) { return false; }
  const leftNote = structuralTextNote(store, VesCache.current.readNode(leftPath), context.containerVe);
  if (leftNote == null) { return false; }

  store.overlay.setTextEditInfo(store.history, null);
  const joinOffset = leftNote.title.length;
  leftNote.inlineMarks = concatNoteInlineMarks(
    leftNote.inlineMarks, leftNote.title, rightNote.inlineMarks, rightNote.title,
  );
  leftNote.urls = concatNoteUrls(
    leftNote.urls, leftNote.title, rightNote.urls, rightNote.title,
  );
  leftNote.title += rightNote.title;
  NoteFns.ensureTitleUrl(leftNote);

  store.history.setFocus(leftPath);
  store.textEdit.saveItem(leftNote, true);
  itemState.delete(rightNote.id);
  server.deleteItem(rightNote.id, store.general.networkStatus);

  if (isComposite(context.containerVe.displayItem)) {
    const compositeItem = asCompositeItem(itemState.get(context.containerVe.displayItem.id)!);
    const compositeParentPath = VeFns.parentPath(context.containerPath);
    const parentVe = compositeParentPath ? VesCache.current.readNode(compositeParentPath) : null;
    if (compositeItem.computed_children.length == 1 && !CompositeFns.hasOwnTitle(compositeItem) && compositeItem.groupId == null &&
        compositeItem.computed_attachments.length == 0 && itemCanMove(compositeItem) &&
        itemCanMove(context.containerVe.displayItem) &&
        compositeItem.relationshipToParent == RelationshipToParent.Child &&
        parentVe != null && compositeParentPath != null &&
        parentVe.displayItem.id == compositeItem.parentId && structuralTextContainerIsEditable(store, parentVe)) {

      const posGr = compositeItem.spatialPositionGr;
      const widthGr = compositeItem.spatialWidthGr;
      itemState.moveToNewParent(leftNote, compositeItem.parentId, RelationshipToParent.Child, compositeItem.ordering);
      asPositionalItem(leftNote).spatialPositionGr = posGr;

      asXSizableItem(leftNote).spatialWidthGr = widthGr;
      // Queue the parent change now, even if a text autosave is in flight.
      // Deleting the composite before that move reaches the server would fail
      // because the server would still see its surviving child inside it.
      store.textEdit.saveItem(leftNote, false);
      const saveMove = server.updateItem(leftNote, store.general.networkStatus);
      store.history.setFocus(compositeParentPath);
      itemState.delete(compositeItem.id);
      void saveMove.then(() => server.deleteItem(compositeItem.id, store.general.networkStatus))
        .catch(error => console.warn("Failed to persist composite collapse after joining notes:", error));
      arrangeNow(store, "join-items-collapse-composite");
      focusItemInLinearContainer(store, compositeParentPath, leftNote.id, joinOffset);
      return true;
    }
  }

  arrangeNow(store, "join-items-restore-edit-focus");
  focusItemInLinearContainer(store, context.containerPath, leftNote.id, joinOffset);
  return true;
}

const enterKeyHandler = (store: StoreContextModel) => {
  const context = currentLinearEditContext(store);
  if (context == null) { return; }

  if (context.editingPath == context.containerPath) {
    const titleElement = document.getElementById(context.editingPath + ":title");
    if (titleElement instanceof HTMLElement &&
      splitDocumentTitleToFirstNote(store, context.containerVe, titleElement)) {
      return;
    }
  }

  if (visualAncestorPageIsClientOnly(context.containerPath)) { return; }

  const item = structuralTextNote(store, context.editingVe, context.containerVe);
  if (item == null) { return; }
  const textElement = document.getElementById(context.editingPath + ":title");
  if (!(textElement instanceof HTMLElement)) { return; }
  const split = prepareNoteParagraphSplit(store, textElement);
  if (split == null) { return; }

  // Finish the old session while it still owns the unsplit DOM.
  store.overlay.setTextEditInfo(store.history, null);
  item.title = split.beforeText;
  item.inlineMarks = split.beforeInlineMarks;
  item.urls = split.beforeUrls;
  NoteFns.ensureTitleUrl(item);
  store.textEdit.saveItem(item, true);

  const ordering = itemState.newOrderingDirectlyAfterChild(context.containerVe.displayItem.id, item.id);
  const note = NoteFns.create(item.ownerId, context.containerVe.displayItem.id, RelationshipToParent.Child, split.afterText, ordering);
  note.flags = split.continuationFlags;
  note.inlineMarks = split.afterInlineMarks;
  note.urls = split.afterUrls;
  NoteFns.ensureTitleUrl(note);
  itemState.add(note);
  server.addItem(note, null, store.general.networkStatus);
  arrangeNow(store, "enter-key-create-note");

  focusItemInLinearContainer(store, context.containerPath, note.id, 0);
}

function revealCaretHorizontallyIfClipped(el: HTMLElement, caretPosition: number): void {
  const viewport = el.parentElement;
  if (viewport == null || window.getComputedStyle(viewport).whiteSpace != "nowrap") { return; }

  const viewportRect = viewport.getBoundingClientRect();
  if (viewport.clientWidth <= 0 || viewportRect.width <= 0) { return; }

  const caretLineRect = getCaretLineRect(el, caretPosition);
  const textLength = el.textContent?.length ?? 0;
  const caretXPx = caretPosition >= textLength ? caretLineRect.right : caretLineRect.left;
  const scale = viewportRect.width / viewport.clientWidth;
  const insetPx = 2;

  if (caretXPx > viewportRect.right - insetPx) {
    viewport.scrollLeft += (caretXPx - viewportRect.right + insetPx) / scale;
  } else if (caretXPx < viewportRect.left + insetPx) {
    viewport.scrollLeft = Math.max(0, viewport.scrollLeft - (viewportRect.left + insetPx - caretXPx) / scale);
  }
}

function textEditElementForEvent(store: StoreContextModel, ev: Event): HTMLElement | null {
  const info = store.overlay.textEditInfo();
  if (info == null) { return null; }
  const element = document.getElementById(textEditElementId(info));
  if (!(element instanceof HTMLElement) || !(ev.target instanceof Node) ||
      (ev.target !== element && !element.contains(ev.target) &&
       !(ev.target instanceof HTMLElement && ev.target.isContentEditable && ev.target.contains(element)))) { return null; }
  return element;
}

/** Read the ordered selection once, including backward selections, before a
 * structural command changes focus or replaces DOM nodes.
 */
export function prepareNoteParagraphSplit(store: StoreContextModel, element: HTMLElement) {
  const info = store.overlay.textEditInfo();
  if (info?.itemType != ItemType.Note || info.colNum != null ||
      element.id != textEditElementId(info) || store.textEdit.activeSession()?.isComposing) { return null; }
  const ranges = currentSelectionRanges();
  if (ranges.length != 1 || !rangeIsInsideEditor(ranges[0], element)) { return null; }
  const item = itemState.get(VeFns.veidFromPath(info.itemPath).itemId);
  const ve = VesCache.current.readNode(info.itemPath);
  if (item == null || !isNote(item) || !itemCanEdit(item) || ve == null || !itemCanEdit(ve.displayItem)) { return null; }
  store.textEdit.captureInput(element, noteInputTypingFlags(store, info.itemPath));
  return planNoteParagraphSplit(asNoteItem(item),
    getTextOffsetWithinElement(element, ranges[0].startContainer, ranges[0].startOffset),
    getTextOffsetWithinElement(element, ranges[0].endContainer, ranges[0].endOffset));
}

function exitEmptyNoteList(store: StoreContextModel, ev: Event): boolean {
  const element = textEditElementForEvent(store, ev);
  if (element == null) { return false; }
  const split = prepareNoteParagraphSplit(store, element);
  if (split == null || split.note.title != "" ||
      (split.note.flags & (NoteFlags.Bullet1 | NoteFlags.Numbered)) == 0) { return false; }
  stopStructuralTextEvent(ev);
  split.note.flags &= ~(NoteFlags.Bullet1 | NoteFlags.Numbered | NoteFlags.Indent1 | NoteFlags.Indent2);
  store.textEdit.saveItem(split.note, true);
  arrangeNow(store, "note-exit-empty-list");
  const currentElement = document.getElementById(element.id);
  if (currentElement instanceof HTMLElement) { setCaretPosition(currentElement, 0); }
  return true;
}

/** Paste and soft line breaks share an explicit note replacement command. */
export function edit_replaceNoteSelection(store: StoreContextModel, ev: Event, text: string): boolean {
  const element = textEditElementForEvent(store, ev);
  const info = store.overlay.textEditInfo();
  if (element == null || info?.itemType != ItemType.Note || info.colNum != null) { return false; }
  if (store.textEdit.activeSession()?.isComposing) {
    return blockStructuralTextEvent(store, ev, "Finish composing text before replacing the selection.");
  }
  const ranges = currentSelectionRanges();
  if (ranges.length != 1 || !rangeIsInsideEditor(ranges[0], element)) {
    return blockStructuralTextEvent(store, ev, "Replace text within one item at a time.");
  }
  const ve = VesCache.current.readNode(info.itemPath);
  const item = itemState.get(VeFns.veidFromPath(info.itemPath).itemId);
  if (item == null || !isNote(item) || !itemCanEdit(item) || ve == null || !itemCanEdit(ve.displayItem)) {
    return blockStructuralTextEvent(store, ev, "This note is read-only.");
  }

  updateNoteTextSelectionInfoFromDom(store, true);
  const flags = noteInputTypingFlags(store, info.itemPath);
  store.textEdit.captureInput(element, flags);
  const range = ranges[0];
  const start = getTextOffsetWithinElement(element, range.startContainer, range.startOffset);
  const end = getTextOffsetWithinElement(element, range.endContainer, range.endOffset);
  const session = store.textEdit.replaceNoteText(start, end, text, flags);
  if (session == null) {
    return blockStructuralTextEvent(store, ev, "The text selection changed. Select the text and try again.");
  }
  stopStructuralTextEvent(ev);
  beforeInputNoteTypingFlags = null;
  reconcileNoteEditableDom(element, asNoteItem(item));
  setCaretPosition(element, start + text.length);
  updateNoteTextSelectionInfoFromDom(store, false);
  scheduleTextEditArrange(store, session);
  return true;
}

/** Let the browser handle IME keys without running app shortcuts or paragraph commands. */
export function edit_compositionKeyGuard(store: StoreContextModel, ev: KeyboardEvent): boolean {
  if (!(ev.isComposing || ev.keyCode == 229 || store.textEdit.activeSession()?.isComposing) ||
      textEditElementForEvent(store, ev) == null) { return false; }
  clearArrowKeyTracking();
  ev.stopImmediatePropagation();
  return true;
}

export function edit_compositionStartHandler(store: StoreContextModel, ev: CompositionEvent): void {
  const element = textEditElementForEvent(store, ev);
  const info = store.overlay.textEditInfo();
  if (element == null || info == null) { return; }
  clearArrowKeyTracking();
  updateNoteTextSelectionInfoFromDom(store, true);
  store.textEdit.beginComposition(element, noteInputTypingFlags(store, info.itemPath));
  beforeInputNoteTypingFlags = null;
}

export function edit_compositionEndHandler(store: StoreContextModel, ev: CompositionEvent): void {
  const element = textEditElementForEvent(store, ev);
  if (element == null) { return; }
  const session = store.textEdit.endComposition(element);
  beforeInputNoteTypingFlags = null;
  if (session != null) { scheduleTextEditArrange(store, session); }
}

function scheduleTextEditArrange(store: StoreContextModel, session: TextEditSession): void {
  const inputRevision = ++session.inputRevision;
  const textAtInput = session.lastText;
  const editingDomId = textEditElementId(session.info);
  setTimeout(() => {
    if (store.textEdit.activeSession() !== session || session.inputRevision != inputRevision || session.isComposing ||
        store.overlay.toolbarPopupInfoMaybe.get() != null) { return; }
    const currentElement = document.getElementById(editingDomId);
    if (!(currentElement instanceof HTMLElement)) { return; }
    // Read the live selection at render time. Typing may have been followed by
    // a click or Shift+Arrow before this callback; those changes belong to the user.
    const selectionBefore = textSelectionOffsets(currentElement);
    if (selectionBefore == null) { return; }
    const activeElement = document.activeElement;
    if (activeElement !== currentElement && !currentElement.contains(activeElement) &&
        !(activeElement instanceof HTMLElement && activeElement.isContentEditable && activeElement.contains(currentElement))) { return; }
    const item = itemState.get(session.itemId);
    if (item == null) { return; }
    // A split/join may have updated the model before this rendering callback.
    if (session.info.itemType == ItemType.Note && asNoteItem(item).title != textAtInput) { return; }
    if (textAtInput == "" && session.info.itemType != ItemType.Note) {
      restoreContentEditablePlaceholderIfEmpty(currentElement);
    }
    arrangeNow(store, "text-edit-input-preserve-selection");
    if (store.textEdit.activeSession() !== session || session.isComposing) { return; }
    const renderedElement = document.getElementById(editingDomId);
    if (!(renderedElement instanceof HTMLElement)) { return; }
    const anchor = Math.min(selectionBefore.anchor, textAtInput.length);
    const focus = Math.min(selectionBefore.focus, textAtInput.length);
    const selectionAfter = textSelectionOffsets(renderedElement);
    // A stable note host normally needs neither focus nor selection restoration.
    // Keep the fallback for other item editors and deliberate markup changes.
    if (renderedElement !== currentElement) { renderedElement.focus(); }
    if (selectionAfter?.anchor !== anchor || selectionAfter?.focus !== focus) {
      setDirectionalTextSelection(renderedElement, anchor, focus);
    }
    if (anchor == focus) { revealCaretHorizontallyIfClipped(renderedElement, focus); }
    if (session.info.itemType == ItemType.Note) {
      updateNoteTextSelectionInfoFromDom(store, true);
    }
  }, 0);
}

export const edit_inputListener = (store: StoreContextModel, ev: InputEvent, arrange: boolean = true) => {
  const textEditInfo = store.overlay.textEditInfo();
  const el = textEditElementForEvent(store, ev);
  if (textEditInfo == null || el == null) { return; }
  const capturedFlags = beforeInputNoteTypingFlags;
  const typingFlags = capturedFlags?.itemPath == textEditInfo.itemPath
    ? capturedFlags.flags
    : noteInputTypingFlags(store, textEditInfo.itemPath);
  // Also tolerate browsers which expose composing input without compositionstart.
  if (ev.isComposing) { store.textEdit.beginComposition(el, typingFlags); }
  const session = store.textEdit.captureInput(el, typingFlags);
  beforeInputNoteTypingFlags = null;
  if (session == null || session.isComposing || !arrange) { return; }
  scheduleTextEditArrange(store, session);
}
