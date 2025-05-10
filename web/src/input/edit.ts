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
import { trimNewline } from "../util/string";
import { fullArrange } from "../layout/arrange";
import { VesCache } from "../layout/ves-cache";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { assert, panic } from "../util/lang";
import { FindDirection, findClosest } from "../layout/find";
import { asFileItem, isFile } from "../items/file-item";
import { ItemType } from "../items/base/item";
import { asPositionalItem } from "../items/base/positional-item";
import { asXSizableItem } from "../items/base/x-sizeable-item";
import { asExpressionItem, isExpression } from "../items/expression-item";
import { asPasswordItem, isPassword } from "../items/password-item";
import { isArrowKey } from "../input/key";
import { asTableItem, isTable } from "../items/table-item";
import { currentCaretElement, getCurrentCaretVePath_title as getCurrentCaretVeInfo, getCaretPosition, setCaretPosition, editPathInfoToDomId } from "../util/caret";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { itemState } from "../store/ItemState";
import { VeFns, VisualElement } from "../layout/visual-element";
import { asTitledItem } from "../items/base/titled-item";
import { StoreContextModel } from "../store/StoreProvider";
import { asPageItem } from "../items/page-item";
import { asImageItem } from "../items/image-item";


let arrowKeyDown_caretPosition = null;
let arrowKeyDown_element: HTMLElement | null = null;

export function composite_selectionChangeListener() {
  if (arrowKeyDown_element != null) {
    try {
      getCurrentCaretVeInfo();
    } catch (e) {
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
  arrowKeyDown_caretPosition = null;
  arrowKeyDown_element = null;

  let currentCaretItemInfo;
  try {
    currentCaretItemInfo = getCurrentCaretVeInfo();
  } catch (e) {
    console.log("bad current caret ve path: ", e);
    return;
  }
  const currentEditingPath = store.history.getFocusPath();
  if (currentEditingPath != currentCaretItemInfo.path) {
    serverOrRemote.updateItem(store.history.getFocusItem(), store.general.networkStatus);

    const newEditingDomId = editPathInfoToDomId(currentCaretItemInfo);
    let newEditingTextElement = document.getElementById(newEditingDomId);
    let caretPosition = getCaretPosition(newEditingTextElement!);

    let newVes = VesCache.get(currentCaretItemInfo.path)!;
    let newVe = newVes.get();
    if (isNote(newVe.displayItem)) {
      store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemInfo.path, itemType: ItemType.Note });
    } else if (isFile(newVe.displayItem)) {
      store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemInfo.path, itemType: ItemType.File });
    } else if (isExpression(newVe.displayItem)) {
      store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemInfo.path, itemType: ItemType.Expression });
    } else if (isPassword(newVe.displayItem)) {
      store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemInfo.path, itemType: ItemType.Password });
    } else if (isTable(newVe.displayItem)) {
      store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemInfo.path, itemType: ItemType.Table });
    } else {
      console.warn("arrow key handler for item type " + store.overlay.textEditInfo()!.itemType + " not implemented.");
    }
    // after setting the text edit info, the <a /> (if this is a link) is turned into a <span />
    newEditingTextElement = document.getElementById(newEditingDomId);
    setCaretPosition(newEditingTextElement!, caretPosition);
    newEditingTextElement!.focus();
  }
}

export const edit_keyDownHandler = (store: StoreContextModel, visualElement: VisualElement, ev: KeyboardEvent) => {
  if (isArrowKey(ev.key)) {
    const itemPath = store.overlay.textEditInfo()!.itemPath;
    const editingDomId = itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);
    arrowKeyDown_caretPosition = caretPosition;
    arrowKeyDown_element = textElement;
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

const joinItemsMaybeHandler = (store: StoreContextModel, visualElement: VisualElement) => {
  const editingVe = VesCache.get(store.overlay.textEditInfo()!.itemPath)!.get();
  const initialEditingItem = VeFns.canonicalItem(editingVe);
  if (!isNote(initialEditingItem)) { return; }

  const compositeVe = visualElement;
  const compositeParentPath = VeFns.parentPath(VeFns.veToPath(compositeVe));
  if (!isComposite(compositeVe.displayItem)) { return; }
  const compositeItem = asCompositeItem(compositeVe.displayItem);
  const closestPathUp = findClosest(VeFns.veToPath(editingVe), FindDirection.Up, true, false);
  if (closestPathUp == null) { return; }

  const upVeid = VeFns.veidFromPath(closestPathUp);
  const upFocusItem = asTitledItem(itemState.get(upVeid.itemId)!);

  if (!isNote(upFocusItem) && !isFile(upFocusItem)) { return; }
  const upTextLength = upFocusItem.title.length;
  upFocusItem.title = upFocusItem.title + asTitledItem(editingVe.displayItem).title;
  fullArrange(store);

  server.updateItem(upFocusItem, store.general.networkStatus);
  itemState.delete(initialEditingItem.id);
  server.deleteItem(initialEditingItem.id, store.general.networkStatus);

  assert(compositeItem.computed_children.length != 0, "composite item does not have any children.");
  if (compositeItem.computed_children.length == 1) {
    const posGr = compositeItem.spatialPositionGr;
    const widthGr = compositeItem.spatialWidthGr;
    itemState.moveToNewParent(upFocusItem, compositeItem.parentId, RelationshipToParent.Child);
    asPositionalItem(upFocusItem).spatialPositionGr = posGr;
    asXSizableItem(upFocusItem).spatialWidthGr = widthGr;
    server.updateItem(upFocusItem, store.general.networkStatus);
    itemState.delete(compositeItem.id);
    server.deleteItem(compositeItem.id, store.general.networkStatus);
    fullArrange(store);
    const itemPath = VeFns.addVeidToPath(upVeid, compositeParentPath);
    store.overlay.setTextEditInfo(store.history, { itemPath: itemPath, itemType: upFocusItem.itemType });
    const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    setCaretPosition(textElement!, upTextLength);
    textElement!.focus();
  }
  else {
    fullArrange(store);
    store.overlay.setTextEditInfo(store.history, { itemPath: closestPathUp, itemType: upFocusItem.itemType });
    const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    setCaretPosition(textElement!, upTextLength);
    textElement!.focus();
  }
}

const enterKeyHandler = (store: StoreContextModel, visualElement: VisualElement) => {
  const itemPath = store.overlay.textEditInfo()!.itemPath;
  const noteVeid = VeFns.veidFromPath(itemPath);
  const item = itemState.get(noteVeid.itemId)!;
  if (!isNote(item) && !isFile(item)) { return; }
  const titledItem = asTitledItem(item);

  const editingDomId = itemPath + ":title";
  const textElement = document.getElementById(editingDomId);
  const caretPosition = getCaretPosition(textElement!);

  const beforeText = textElement!.innerText.substring(0, caretPosition);
  const afterText = textElement!.innerText.substring(caretPosition);

  titledItem.title = beforeText;

  serverOrRemote.updateItem(titledItem, store.general.networkStatus);

  const ordering = itemState.newOrderingDirectlyAfterChild(visualElement.displayItem.id, VeFns.canonicalItemFromVeid(noteVeid)!.id);
  const note = NoteFns.create(titledItem.ownerId, visualElement.displayItem.id, RelationshipToParent.Child, "", ordering);
  note.title = afterText;
  itemState.add(note);
  server.addItem(note, null, store.general.networkStatus);
  fullArrange(store);

  const veid = { itemId: note.id, linkIdMaybe: null };
  const newVes = VesCache.findSingle(veid);
  store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(newVes.get()), itemType: ItemType.Note });

  const newEditingPath = store.overlay.textEditInfo()!.itemPath + ":title";
  const newEditingTextElement = document.getElementById(newEditingPath);
  setCaretPosition(newEditingTextElement!, 0);
  textElement!.focus();
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
        } else if (store.overlay.textEditInfo()!.itemType == ItemType.Expression) {
          let item = asExpressionItem(itemState.get(VeFns.veidFromPath(focusItemPath).itemId)!);
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
        fullArrange(store);
        const el_ = document.getElementById(focusItemDomId);
        setCaretPosition(el_!, caretPosition);
      }
    }
  }, 0);
}
