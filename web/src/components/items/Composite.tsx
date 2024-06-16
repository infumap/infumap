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

import { Component, For, Match, Show, Switch } from "solid-js";
import { VisualElementProps, VisualElement_Desktop } from "../VisualElement";
import { ATTACH_AREA_SIZE_PX, LINE_HEIGHT_PX } from "../../constants";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { itemState } from "../../store/ItemState";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { CompositeFlags } from "../../items/base/flags-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { useStore } from "../../store/StoreProvider";
import { currentCaretElement, getCurrentCaretVePath_title, getCaretPosition, setCaretPosition } from "../../util/caret";
import { server, serverOrRemote } from "../../server";
import { NoteFns, asNoteItem, isNote } from "../../items/note-item";
import { trimNewline } from "../../util/string";
import { fullArrange } from "../../layout/arrange";
import { VesCache } from "../../layout/ves-cache";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { assert, panic } from "../../util/lang";
import { FindDirection, findClosest } from "../../layout/find";
import { asFileItem, isFile } from "../../items/file-item";
import { ItemType } from "../../items/base/item";
import { asPositionalItem } from "../../items/base/positional-item";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { asExpressionItem, isExpression } from "../../items/expression-item";
import { asPasswordItem, isPassword } from "../../items/password-item";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Composite_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const boundsPx = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);

  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
    }
  };

  const showBorder = () => !(asCompositeItem(props.visualElement.displayItem).flags & CompositeFlags.HideBorder);

  const keyUpHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "ArrowDown":
        keyUp_Arrow();
        break;
      case "ArrowUp":
        keyUp_Arrow();
        break;
      case "ArrowLeft":
        keyUp_Arrow();
        break;
      case "ArrowRight":
        keyUp_Arrow();
        break;
    }
  }

  const keyUp_Arrow = () => {
    let currentCaretItemPath;
    try {
      currentCaretItemPath = getCurrentCaretVePath_title();
    } catch (e) {
      console.log("bad current caret ve path", e);
      return;
    }
    const currentEditingPath = store.history.getFocusPath();
    if (currentEditingPath != currentCaretItemPath) {
      serverOrRemote.updateItem(store.history.getFocusItem());

      const newEditingDomId = currentCaretItemPath + ":title";
      let newEditingTextElement = document.getElementById(newEditingDomId);
      let caretPosition = getCaretPosition(newEditingTextElement!);

      let newVes = VesCache.get(currentCaretItemPath)!;
      let newVe = newVes.get();
      if (isNote(newVe.displayItem)) {
        store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemPath, itemType: ItemType.Note });
      } else if (isFile(newVe.displayItem)) {
        store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemPath, itemType: ItemType.File });
      } else if (isExpression(newVe.displayItem)) {
        store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemPath, itemType: ItemType.Expression });
      } else if (isPassword(newVe.displayItem)) {
        store.overlay.setTextEditInfo(store.history, { itemPath: currentCaretItemPath, itemType: ItemType.Password });
      } else {
        console.warn("arrow key handler for item type " + store.overlay.textEditInfo()!.itemType + " not implemented.");
      }
      // after setting the text edit info, the <a /> (if this is a link) is turned into a <span />
      newEditingTextElement = document.getElementById(newEditingDomId);
      setCaretPosition(newEditingTextElement!, caretPosition);
      newEditingTextElement!.focus();
    }
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Backspace":
        const el = currentCaretElement();
        const position = getCaretPosition(el!);
        if (position > 0) { return; }
        ev.preventDefault();
        ev.stopPropagation();
        joinItemsMaybeHandler();
        return;
      case "Enter":
        enterKeyHandler()
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
  }

  const joinItemsMaybeHandler = () => {
    const editingVe = VesCache.get(store.overlay.textEditInfo()!.itemPath)!.get();
    const initialEditingItem = VeFns.canonicalItem(editingVe);
    if (!isNote(initialEditingItem)) { return; }

    const compositeVe = props.visualElement;
    const compositeParentPath = VeFns.parentPath(VeFns.veToPath(compositeVe));
    if (!isComposite(compositeVe.displayItem)) { panic("composite item is not a composite!") }
    const compositeItem = asCompositeItem(compositeVe.displayItem);
    const closestPathUp = findClosest(VeFns.veToPath(editingVe), FindDirection.Up, true, false);
    if (closestPathUp == null) { return; }

    const upVeid = VeFns.veidFromPath(closestPathUp);
    const upFocusItem = asTitledItem(itemState.get(upVeid.itemId)!);
    if (!isNote(upFocusItem)) { return; }
    const upTextLength = upFocusItem.title.length;
    upFocusItem.title = upFocusItem.title + asTitledItem(editingVe.displayItem).title;
    fullArrange(store);

    server.updateItem(upFocusItem);
    itemState.delete(initialEditingItem.id);
    server.deleteItem(initialEditingItem.id);

    assert(compositeItem.computed_children.length != 0, "composite item does not have any children.");
    if (compositeItem.computed_children.length == 1) {
      const posGr = compositeItem.spatialPositionGr;
      const widthGr = compositeItem.spatialWidthGr;
      itemState.moveToNewParent(upFocusItem, compositeItem.parentId, RelationshipToParent.Child);
      asPositionalItem(upFocusItem).spatialPositionGr = posGr;
      asXSizableItem(upFocusItem).spatialWidthGr = widthGr;
      server.updateItem(upFocusItem);
      itemState.delete(compositeItem.id);
      server.deleteItem(compositeItem.id);
      fullArrange(store);
      const itemPath = VeFns.addVeidToPath(upVeid, compositeParentPath);
      store.overlay.setTextEditInfo(store.history, { itemPath: itemPath, itemType: ItemType.Note });
      const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
      const textElement = document.getElementById(editingDomId);
      setCaretPosition(textElement!, upTextLength);
      textElement!.focus();
    }
    else {
      fullArrange(store);
      store.overlay.setTextEditInfo(store.history, { itemPath: closestPathUp, itemType: ItemType.Note });
      const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
      const textElement = document.getElementById(editingDomId);
      setCaretPosition(textElement!, upTextLength);
      textElement!.focus();
    }
  }

  const enterKeyHandler = () => {
    const itemPath = store.overlay.textEditInfo()!.itemPath;
    const noteVeid = VeFns.veidFromPath(itemPath);
    const item = itemState.get(noteVeid.itemId)!;
    if (!isNote(item)) { return; }
    const noteItem = asNoteItem(item);

    const editingDomId = itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);

    const beforeText = textElement!.innerText.substring(0, caretPosition);
    const afterText = textElement!.innerText.substring(caretPosition);

    noteItem.title = beforeText;

    serverOrRemote.updateItem(noteItem);

    const ordering = itemState.newOrderingDirectlyAfterChild(props.visualElement.displayItem.id, VeFns.canonicalItemFromVeid(noteVeid)!.id);
    const note = NoteFns.create(noteItem.ownerId, props.visualElement.displayItem.id, RelationshipToParent.Child, "", ordering);
    note.title = afterText;
    itemState.add(note);
    server.addItem(note, null);
    fullArrange(store);

    const veid = { itemId: note.id, linkIdMaybe: null };
    const newVes = VesCache.findSingle(veid);
    store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(newVes.get()), itemType: ItemType.Note });

    const newEditingPath = store.overlay.textEditInfo()!.itemPath + ":title";
    const newEditingTextElement = document.getElementById(newEditingPath);
    setCaretPosition(newEditingTextElement!, 0);
    textElement!.focus();
  }

  const inputListener = (_ev: InputEvent) => {
    setTimeout(() => {
      const focusItemPath = store.history.getFocusPath();
      const focusItemDomId = focusItemPath + ":title";
      const el = document.getElementById(focusItemDomId);
      if (store.overlay.textEditInfo()) {
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
          } else {
            console.warn("input handler for item type " + store.overlay.textEditInfo()!.itemType + " not implemented.");
          }
          const caretPosition = getCaretPosition(el!);
          fullArrange(store);
          setCaretPosition(el!, caretPosition);
        }
      }
    }, 0);
  }

  return (
    <div class={`absolute border ` +
                `${showBorder() ? "border-slate-700" : "border-transparent"} ` +
                `rounded-sm ` +
                `${showBorder() ? "shadow-lg " : ""}` +
                `bg-white overflow-hidden`}
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                `${VeFns.opacityStyle(props.visualElement)} ${VeFns.zIndexStyle(props.visualElement)} ` +
                `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? "background-color: #eee;" : ""}` +
                `outline: 0px solid transparent;`}
         contentEditable={store.overlay.textEditInfo() != null}
         onKeyUp={keyUpHandler}
         onKeyDown={keyDownHandler}
         onInput={inputListener}>
      <For each={props.visualElement.childrenVes}>{childVe =>
        <VisualElement_Desktop visualElement={childVe.get()} />
      }</For>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: #ff0000;`} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <InfuLinkTriangle />
      </Show>
    </div>
  );
};


export const Composite_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const compositeItem = () => asCompositeItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const leftPx = () => boundsPx().x + oneBlockWidthPx();
  const widthPx = () => boundsPx().w - oneBlockWidthPx();
  const titleText = () => {
    if (compositeItem().computed_children.length == 0) {
      return "[empty]";
    }
    const topItem = itemState.get(compositeItem().computed_children[0])!
    if (isTitledItem(topItem)) {
      return asTitledItem(topItem).title + "...";
    }
    return "[no title]";
  }
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px;`} />
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; ` +
                    `background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIcon = () =>
    <div class="absolute text-center"
         style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <i class={`fas fa-object-group`} />
    </div>;

  const renderText = () =>
    <div class="absolute overflow-hidden whitespace-nowrap text-ellipsis"
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <span>{titleText()}</span>
    </div>;

  const renderExpandIcon = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center text-slate-400"
          style={`left: ${boundsPx().x+boundsPx().w - oneBlockWidthPx()*0.85}px; top: ${boundsPx().y + boundsPx().h*0.15}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale() * 0.8}px; height: ${boundsPx().h / smallScale() * 0.8}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}>
        <i class={`fas ${store.perVe.getIsExpanded(vePath()) ? 'fa-minus' : 'fa-plus'}`} />
      </div>
    </Show>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
      <div class="absolute text-center text-slate-600"
          style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                 `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                 `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIcon()}
      {renderText()}
      {renderExpandIcon()}
      {renderLinkMarkingMaybe()}
    </>
  )
}
