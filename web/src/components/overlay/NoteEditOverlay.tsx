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

import { Component, onCleanup, onMount } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { NoteFns, NoteItem, asNoteItem } from "../../items/note-item";
import { server } from "../../server";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { Vector, isInside, vectorSubtract } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { CompositeFns, CompositeItem, asCompositeItem, isComposite } from "../../items/composite-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { CursorEventState } from "../../input/state";
import { FindDirection, findClosest } from "../../layout/find";
import { getTextStyleForNote, measureLineCount } from "../../layout/text";
import { newOrdering } from "../../util/ordering";
import { asPositionalItem } from "../../items/base/positional-item";
import { TableFns, asTableItem } from "../../items/table-item";
import { MOUSE_LEFT, MOUSE_RIGHT, mouseDownHandler } from "../../input/mouse_down";
import { assert } from "../../util/lang";
import { asContainerItem } from "../../items/base/container-item";
import getCaretCoordinates from 'textarea-caret';


// TODO (LOW): don't create items on the server until it is certain that they are needed.
let justCreatedNoteItemMaybe: NoteItem | null = null;
let justCreatedCompositeItemMaybe: CompositeItem | null = null;

export const NoteEditOverlay: Component = () => {
  const store = useStore();

  let textElement: HTMLTextAreaElement | undefined;

  const noteVisualElement = () => VesCache.get(store.overlay.noteEditOverlayInfo.get()!.itemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDestkopPx(store, noteVisualElement());
  const editBoxBoundsPx = () => {
    if (noteVisualElement()!.flags & VisualElementFlags.InsideTable) {
      const sBl = sizeBl();
      const nbPx = noteVeBoundsPx();
      return ({
        x: nbPx.x, y: nbPx.y,
        w: nbPx.w, h: nbPx.h * sBl.h,
      });
    }
    return noteVeBoundsPx();
  };
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);
  const noteItemOnInitialize = noteItem();

  const compositeVisualElementMaybe = () => {
    const parentVe = VesCache.get(noteVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };
  const compositeItemOnInitializeMaybe = compositeItemMaybe();

  const sizeBl = () => {
    const noteVe = noteVisualElement()!;
    if (noteVe.flags & VisualElementFlags.InsideTable) {
      let tableVe;
      if (noteVe.col == 0) {
        tableVe = VesCache.get(noteVe.parentPath!)!.get();
      } else {
        const itemVe = VesCache.get(noteVisualElement().parentPath!)!.get();
        tableVe = VesCache.get(itemVe.parentPath!)!.get();
      }
      const tableItem = asTableItem(tableVe.displayItem);
      const widthBl = TableFns.columnWidthBl(tableItem, noteVe.col!);
      let lineCount = measureLineCount(noteItem().title, widthBl, noteItem().flags);
      if (lineCount < 1) { lineCount = 1; }
      return ({ w: widthBl, h: lineCount });
    }

    if (noteVe.flags & VisualElementFlags.InsideComposite) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(noteVisualElement().displayItem));
      cloned.spatialWidthGr = asXSizableItem(VeFns.canonicalItem(VesCache.get(noteVisualElement().parentPath!)!.get())).spatialWidthGr;
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }

    if (noteVe.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(noteVisualElement().linkItemMaybe!);
    }

    return NoteFns.calcSpatialDimensionsBl(noteItem());
  };

  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (editBoxBoundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (editBoxBoundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const mouseDownListener = async (ev: MouseEvent) => {
    justCreatedNoteItemMaybe = null;
    justCreatedCompositeItemMaybe = null;
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    const desktopPx = CursorEventState.getLatestDesktopPx();
    if (isInside(desktopPx, noteVeBoundsPx())) { return; }

    if (store.user.getUserMaybe() != null && noteItem().ownerId == store.user.getUser().userId) {
      server.updateItem(noteItem());
    }
    store.overlay.noteEditOverlayInfo.set(null);
    arrange(store); // input focus changed.

    if (ev.button == MOUSE_LEFT) {
      mouseDownHandler(store, MOUSE_LEFT);
    }
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  onCleanup(() => {
    if (!deleted && store.user.getUserMaybe() != null && noteItemOnInitialize.ownerId == store.user.getUser().userId) {
      server.updateItem(noteItemOnInitialize);
      if (compositeItemOnInitializeMaybe != null) {
        server.updateItem(compositeItemOnInitializeMaybe);
      }
    }
  });

  onMount(() => {
    const mouseClientPosPx = CursorEventState.getLatestClientPx();
    const r = textElement!.getBoundingClientRect();
    const teTopLeftPx: Vector = { x: r.x, y: r.y };
    const posInTb = vectorSubtract(mouseClientPosPx, teTopLeftPx);
    let closestDist = 10000000.0;
    let closestIdx = 1;
    for (let i=1; i<=textElement!.value.length; ++i) {
      const coords = getCaretCoordinates(textElement!, i);
      if (posInTb.y < coords.top || posInTb.y > coords.top + coords.height) { continue; }
      const distX = (coords.left - posInTb.x) * (coords.left - posInTb.x);
      if (distX < closestDist) {
        closestDist = distX;
        closestIdx = i;
      }
    }
    textElement!.selectionStart = closestIdx;
    textElement!.selectionEnd = closestIdx;
    textElement!.focus();
  });

  const textAreaMouseDownHandler = async (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      if (store.user.getUserMaybe() != null && noteItemOnInitialize.ownerId == store.user.getUser().userId) {
        server.updateItem(noteItem());
        store.overlay.noteEditOverlayInfo.set(null);
      }
    }
  };

  const textAreaOnInputHandler = () => {
    noteItem().title = textElement!.value;
    arrange(store);
  };


  let deleted = false;

  const keyDownListener = (ev: KeyboardEvent): void => {
    if (ev.code == "Enter") {
      keyDown_Enter(ev);
      return;
    }

    switch (ev.code) {
      case "Backspace":
        keyDown_Backspace(ev);
        break;
      case "ArrowDown":
        keyDown_Down();
        break;
      case "ArrowUp":
        keyDown_Up();
        break;
    }

    justCreatedNoteItemMaybe = null;
    justCreatedCompositeItemMaybe = null;
  };

  const keyDown_Down = (): void => {
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return; }
    const endCaretCoords = getCaretCoordinates(textElement!, textElement!.value.length);
    const caretCoords = getCaretCoordinates(textElement!, textElement!.selectionStart);
    if (caretCoords.top < endCaretCoords.top) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Down, true);
    if (closest == null) { return; }
    store.overlay.noteEditOverlayInfo.set({ itemPath: closest });
  };

  const keyDown_Up = (): void => {
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return; }
    const startCaretCoords = getCaretCoordinates(textElement!, 0);
    const caretCoords = getCaretCoordinates(textElement!, textElement!.selectionStart);
    if (caretCoords.top > startCaretCoords.top) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true);
    if (closest == null) { return; }
    store.overlay.noteEditOverlayInfo.set({ itemPath: closest });
  };

  const keyDown_Backspace = async (ev: KeyboardEvent): Promise<void> => {
    if (store.user.getUserMaybe() == null || noteItemOnInitialize.ownerId != store.user.getUser().userId) { return; }
    if (noteItem().title != "") { return; }

    // maybe delete note item.
    const ve = noteVisualElement();
    let compositeVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(compositeVe.displayItem)) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true);
    if (closest == null) { return; }

    // definitely delete note item.
    ev.preventDefault();
    store.overlay.noteEditOverlayInfo.set({ itemPath: closest });
    const canonicalId = VeFns.canonicalItem(ve).id;
    deleted = true;
    itemState.delete(canonicalId);
    await server.deleteItem(canonicalId);
    arrange(store);

    justCreatedCompositeItemMaybe = null;
    justCreatedNoteItemMaybe = null;

    // maybe delete composite item and move note to parent.
    compositeVe = VesCache.get(ve.parentPath!)!.get();
    assert(isComposite(compositeVe.displayItem), "parentVe is not a composite.");
    const compositeItem = asCompositeItem(compositeVe.displayItem);
    if (compositeItem.computed_children.length > 1) { return; }

    // definitely delete composite item and move note to parent.
    assert(compositeItem.computed_children.length == 1, "composite has other than one child.");
    const keepNoteId = compositeItem.computed_children[0];
    const keepNote = itemState.get(keepNoteId)!;
    const canonicalCompositeItem = VeFns.canonicalItem(compositeVe);
    const posGr = asPositionalItem(canonicalCompositeItem).spatialPositionGr;
    const compositePageId = canonicalCompositeItem.parentId;
    store.overlay.noteEditOverlayInfo.set(null);
    setTimeout(() => {
      itemState.moveToNewParent(keepNote, compositePageId, canonicalCompositeItem.relationshipToParent, canonicalCompositeItem.ordering);
      asPositionalItem(keepNote).spatialPositionGr = posGr;
      server.updateItem(keepNote);
      itemState.delete(compositeVe.displayItem.id);
      server.deleteItem(compositeVe.displayItem.id);
      arrange(store);
      store.overlay.noteEditOverlayInfo.set({ itemPath: VeFns.addVeidToPath(VeFns.veidFromId(keepNoteId), compositeVe.parentPath!) });
    }, 0);
  };

  const keyDown_Enter = async (ev: KeyboardEvent): Promise<void> => {
    if (store.user.getUserMaybe() == null || noteItemOnInitialize.ownerId != store.user.getUser().userId) { return; }
    ev.preventDefault();
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();

    if (ve.flags & VisualElementFlags.InsideTable || noteVisualElement().linkItemMaybe != null) {
      server.updateItem(ve.displayItem);
      store.overlay.noteEditOverlayInfo.set(null);
      arrange(store);

    } else if (isComposite(parentVe.displayItem)) {

      if (justCreatedNoteItemMaybe != null) {
        itemState.delete(justCreatedNoteItemMaybe.id);
        server.deleteItem(justCreatedNoteItemMaybe.id);
        if (justCreatedCompositeItemMaybe != null) {
          assert(justCreatedCompositeItemMaybe!.computed_children.length == 1, "unexpected number of new composite child elements");
          const originalNote = itemState.get(justCreatedCompositeItemMaybe!.computed_children[0])!;
          itemState.moveToNewParent(originalNote, justCreatedCompositeItemMaybe.parentId, justCreatedCompositeItemMaybe.relationshipToParent, justCreatedCompositeItemMaybe.ordering);
          server.updateItem(originalNote);
          deleted = true;
          itemState.delete(justCreatedCompositeItemMaybe.id);
          server.deleteItem(justCreatedCompositeItemMaybe.id);
        } else if (asContainerItem(parentVe.displayItem).computed_children.length == 1) {
          console.log("TODO (HIGH): delete composite.");
        }
        store.overlay.noteEditOverlayInfo.set(null);
        arrange(store);
        justCreatedCompositeItemMaybe = null;
        justCreatedNoteItemMaybe = null;
        return;
      }

      noteItem().title = textElement!.value;
      server.updateItem(ve.displayItem);
      const ordering = itemState.newOrderingDirectlyAfterChild(parentVe.displayItem.id, VeFns.canonicalItem(ve).id);
      const note = NoteFns.create(ve.displayItem.ownerId, parentVe.displayItem.id, RelationshipToParent.Child, "", ordering);
      itemState.add(note);
      server.addItem(note, null);
      const parent = asContainerItem(itemState.get(parentVe.displayItem.id)!);
      if (parent.computed_children[parent.computed_children.length-1] == note.id) {
        justCreatedNoteItemMaybe = note;
      }
      arrange(store);
      const itemPath = VeFns.addVeidToPath(VeFns.veidFromItems(note, null), ve.parentPath!!);
      store.overlay.noteEditOverlayInfo.set({ itemPath });

    } else {
      assert(justCreatedNoteItemMaybe == null, "not expecting note to have been just created");

      // if the note item is in a link, create the new composite under the item's (as opposed to the link item's) parent.
      const spatialPositionGr = asPositionalItem(ve.displayItem).spatialPositionGr;
      const spatialWidthGr = asXSizableItem(ve.displayItem).spatialWidthGr;
      const composite = CompositeFns.create(ve.displayItem.ownerId, ve.displayItem.parentId, ve.displayItem.relationshipToParent, ve.displayItem.ordering);
      composite.spatialPositionGr = spatialPositionGr;
      composite.spatialWidthGr = spatialWidthGr;
      itemState.add(composite);
      server.addItem(composite, null);
      justCreatedCompositeItemMaybe = composite;
      itemState.moveToNewParent(ve.displayItem, composite.id, RelationshipToParent.Child, newOrdering());
      server.updateItem(ve.displayItem);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      itemState.add(note);
      server.addItem(note, null);
      justCreatedNoteItemMaybe = note;

      store.overlay.noteEditOverlayInfo.set(null);
      arrange(store);
      const newVes = VesCache.findSingle(VeFns.veidFromItems(note, null));
      store.overlay.noteEditOverlayInfo.set({ itemPath: VeFns.veToPath(newVes.get()) });
    }
  };

  const style = () => getTextStyleForNote(noteItem().flags);

  // determined by trial and error to be the minimum amount needed to be added
  // to a textarea to prevent it from scrolling, given the same text layout as
  // the rendered item. TODO (LOW): this could probably be avoided with some
  // more careful reasoning.
  const HACK_ADJUST_TEXTAREA_HEIGHT = 2.5;

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <div class={`absolute rounded border`}
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
        <textarea ref={textElement}
                  class={`rounded overflow-hidden resize-none whitespace-pre-wrap ${style().isCode ? 'font-mono' : ''} ${style().alignClass}`}
                  style={`position: absolute; ` +
                         `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                         `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4) * textBlockScale()}px; ` +
                         `width: ${naturalWidthPx()}px; ` +
                         `height: ${naturalHeightPx() * heightScale()/widthScale() + HACK_ADJUST_TEXTAREA_HEIGHT * style().lineHeightMultiplier}px;` +
                         `font-size: ${style().fontSize}px; ` +
                         `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * style().lineHeightMultiplier}px; ` +
                         `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                         `overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;` +
                         `${style().isBold ? ' font-weight: bold; ' : ""}`}
                  value={noteItem().title}
                  disabled={store.user.getUserMaybe() == null || store.user.getUser().userId != noteItem().ownerId}
                  onMouseDown={textAreaMouseDownHandler}
                  onInput={textAreaOnInputHandler} />
      </div>
    </div>
  );
}
