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

import { Component, Show, onCleanup, onMount } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { NoteFns, NoteItem, asNoteItem } from "../../items/note-item";
import { server } from "../../server";
import { InfuIconButton } from "../library/InfuIconButton";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { createBooleanSignal } from "../../util/signals";
import { BoundingBox, isInside } from "../../util/geometry";
import { CompositeFlags, NoteFlags } from "../../items/base/flags-item";
import { UrlOverlay } from "./UrlOverlay";
import { itemState } from "../../store/ItemState";
import { CompositeFns, CompositeItem, asCompositeItem, isComposite } from "../../items/composite-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { CursorEventState } from "../../mouse/state";
import { FindDirection, findClosest } from "../../layout/find";
import { getTextStyleForNote, measureLineCount } from "../../layout/text";
import { newOrdering } from "../../util/ordering";
import { asPositionalItem } from "../../items/base/positional-item";
import { useUserStore } from "../../store/UserStoreProvider";
import { TableFns, asTableItem } from "../../items/table-item";
import { MOUSE_RIGHT } from "../../mouse/mouse_down";
import { assert } from "../../util/lang";
import { asContainerItem } from "../../items/base/container-item";


// TODO (MEDIUM): don't create items on the server until it is certain that they are needed.
let justCreatedNoteMaybe: NoteItem | null = null;
let justCreatedCompositeMaybe: CompositeItem | null = null;

export const TextEditOverlay: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  let textElement: HTMLTextAreaElement | undefined;

  const urlOverlayVisible = createBooleanSignal(false);
  const infoOverlayVisible = createBooleanSignal(false);

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(desktopStore, noteVisualElement());
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

  const toolboxBoundsPx = () => {
    if (compositeItemMaybe() != null) {
      const compositeVeMaybe = compositeVisualElementMaybe()!;
      const compositeVeBoundsPx = VeFns.veBoundsRelativeToDesktopPx(desktopStore, compositeVeMaybe);
      return ({
        x: compositeVeBoundsPx.x - 5,
        y: compositeVeBoundsPx.y - 45,
        w: 390,
        h: 35
      });
    } else {
      return ({
        x: noteVeBoundsPx().x - 5,
        y: noteVeBoundsPx().y - 45,
        w: 390,
        h: 35
      });
    }
  };

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
    justCreatedNoteMaybe = null;
    justCreatedCompositeMaybe = null;
    ev.stopPropagation();
    CursorEventState.setFromMouseEvent(ev);
    const desktopPx = CursorEventState.getLastestDesktopPx();
    if (isInside(desktopPx, noteVeBoundsPx()) || isInside(desktopPx, toolboxBoundsPx())) { return; }
    await server.updateItem(noteVisualElement().displayItem);
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    CursorEventState.setFromMouseEvent(ev);
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  onCleanup(() => {
    if (!deleted && userStore.getUserMaybe() != null) {
      server.updateItem(noteItemOnInitialize);
      if (compositeItemOnInitializeMaybe != null) {
        server.updateItem(compositeItemOnInitializeMaybe);
      }
    }
  });

  onMount(() => {
    textElement?.focus();
  });

  const urlButtonHandler = () => { urlOverlayVisible.set(!urlOverlayVisible.get()); }

  const infoButtonHandler = () => {
    // TODO (HIGH): multiple ids for the various items: link, composite, item.
    infoOverlayVisible.set(!infoOverlayVisible.get());
  }

  const textAreaMouseDownHandler = async (ev: MouseEvent) => {
    ev.stopPropagation();
    if (ev.button == MOUSE_RIGHT) {
      await server.updateItem(noteVisualElement().displayItem);
      desktopStore.setTextEditOverlayInfo(null);
    }
  };

  const textAreaOnInputHandler = () => {
    noteItem().title = textElement!.value;
    arrange(desktopStore);
  };

  const selectNormalText = () => { NoteFns.clearTextStyleFlags(noteItem()); arrange(desktopStore); };
  const selectHeading1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading1; arrange(desktopStore); };
  const selectHeading2 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading2; arrange(desktopStore); };
  const selectHeading3 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading3; arrange(desktopStore); };
  const selectBullet1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Bullet1; arrange(desktopStore); };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(noteItem()); arrange(desktopStore); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignCenter; arrange(desktopStore); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignRight; arrange(desktopStore); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignJustify; arrange(desktopStore); };

  let deleted = false;

  const deleteButtonHandler = async (): Promise<void> => {
    if (compositeItemMaybe() != null) {
      console.log("TODO: delete composite");
      // TODO (HIGH)
    } else {
      deleted = true;
      await server.deleteItem(noteItem().id); // throws on failure.
      itemState.delete(noteItem().id);
      desktopStore.setTextEditOverlayInfo(null);
      arrange(desktopStore);
    }
  };

  const copyButtonHandler = (): void => {
    if (noteItem().flags & NoteFlags.ShowCopyIcon) {
      noteItem().flags &= ~NoteFlags.ShowCopyIcon;
    } else {
      noteItem().flags |= NoteFlags.ShowCopyIcon;
    }
    arrange(desktopStore);
  };

  const borderButtonHandler = (): void => {
    if (compositeItemMaybe() != null) {
      if (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) {
        compositeItemMaybe()!.flags &= ~CompositeFlags.HideBorder;
      } else {
        compositeItemMaybe()!.flags |= CompositeFlags.HideBorder;
      }
    } else {
      if (noteItem().flags & NoteFlags.HideBorder) {
        noteItem().flags &= ~NoteFlags.HideBorder;
      } else {
        noteItem().flags |= NoteFlags.HideBorder;
      }
    }
    arrange(desktopStore);
  };

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

    justCreatedNoteMaybe = null;
    justCreatedCompositeMaybe = null;
  };

  const keyDown_Down = (): void => {
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return; }
    if (textElement!.selectionEnd != noteItem().title.length) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Down, true);
    if (closest == null) { return; }
    desktopStore.setTextEditOverlayInfo({ noteItemPath: closest });
  };

  const keyDown_Up = (): void => {
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return; }
    if (textElement!.selectionStart != 0) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true);
    if (closest == null) { return; }
    desktopStore.setTextEditOverlayInfo({ noteItemPath: closest });
  };

  const keyDown_Backspace = async (ev: KeyboardEvent): Promise<void> => {
    if (userStore.getUserMaybe() == null) { return; }
    if (noteItem().title != "") { return; }
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return; }
    const closest = findClosest(VeFns.veToPath(ve), FindDirection.Up, true);
    if (closest == null) { return; }
    ev.preventDefault();
    desktopStore.setTextEditOverlayInfo({ noteItemPath: closest });
    const canonicalId = VeFns.canonicalItem(ve).id;
    deleted = true;
    itemState.delete(canonicalId);
    await server.deleteItem(canonicalId);
    arrange(desktopStore);
  };

  const keyDown_Enter = async (ev: KeyboardEvent): Promise<void> => {
    if (userStore.getUserMaybe() == null) { return; }
    ev.preventDefault();
    const ve = noteVisualElement();
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (ve.flags & VisualElementFlags.InsideTable) {
      await server.updateItem(ve.displayItem);
      desktopStore.setTextEditOverlayInfo(null);
      arrange(desktopStore);

    } else if (isComposite(parentVe.displayItem)) {

      if (justCreatedNoteMaybe != null) {
        itemState.delete(justCreatedNoteMaybe.id);
        server.deleteItem(justCreatedNoteMaybe.id);
        if (justCreatedCompositeMaybe != null) {
          assert(justCreatedCompositeMaybe!.computed_children.length == 1, "unexpected number of new composite child elements");
          const originalNote = itemState.get(justCreatedCompositeMaybe!.computed_children[0])!;
          itemState.moveToNewParent(originalNote, justCreatedCompositeMaybe.parentId, justCreatedCompositeMaybe.relationshipToParent, justCreatedCompositeMaybe.ordering);
          server.updateItem(originalNote);
          deleted = true;
          itemState.delete(justCreatedCompositeMaybe.id);
          server.deleteItem(justCreatedCompositeMaybe.id);
        }
        desktopStore.setTextEditOverlayInfo(null);
        arrange(desktopStore);
        justCreatedCompositeMaybe = null;
        justCreatedNoteMaybe = null;
        return;
      }

      noteItem().title = textElement!.value;
      await server.updateItem(ve.displayItem);
      const ordering = itemState.newOrderingDirectlyAfterChild(parentVe.displayItem.id, VeFns.canonicalItem(ve).id);
      const note = NoteFns.create(ve.displayItem.ownerId, parentVe.displayItem.id, RelationshipToParent.Child, "", ordering);
      itemState.add(note);
      await server.addItem(note, null);
      const parent = asContainerItem(itemState.get(parentVe.displayItem.id)!);
      if (parent.computed_children[parent.computed_children.length-1] == note.id) {
        justCreatedNoteMaybe = note;
      }
      arrange(desktopStore);
      const noteItemPath = VeFns.addVeidToPath(VeFns.veidFromItems(note, null), ve.parentPath!!);
      desktopStore.setTextEditOverlayInfo({ noteItemPath });

    } else {
      assert(justCreatedNoteMaybe == null, "not expecting note to have been just created");

      // if the note item is in a link, create the new composite under the item's (as opposed to the link item's) parent.
      const spatialPositionGr = asPositionalItem(ve.displayItem).spatialPositionGr;
      const spatialWidthGr = asXSizableItem(ve.displayItem).spatialWidthGr;
      const composite = CompositeFns.create(ve.displayItem.ownerId, ve.displayItem.parentId, ve.displayItem.relationshipToParent, ve.displayItem.ordering);
      composite.spatialPositionGr = spatialPositionGr;
      composite.spatialWidthGr = spatialWidthGr;
      itemState.add(composite);
      await server.addItem(composite, null);
      justCreatedCompositeMaybe = composite;
      itemState.moveToNewParent(ve.displayItem, composite.id, RelationshipToParent.Child, newOrdering());
      await server.updateItem(ve.displayItem);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      itemState.add(note);
      await server.addItem(note, null);
      justCreatedNoteMaybe = note;

      desktopStore.setTextEditOverlayInfo(null);
      arrange(desktopStore);
      const newVes = VesCache.findSingle(VeFns.veidFromItems(note, null));
      desktopStore.setTextEditOverlayInfo({ noteItemPath: VeFns.veToPath(newVes.get()) });
    }
  };

  const style = () => getTextStyleForNote(noteItem().flags);

  const infoCount = (): number => {
    let count = 1;
    const ve = noteVisualElement();
    if (ve.linkItemMaybe != null) { count += 1; }
    const parentVe = VesCache.get(ve.parentPath!)!.get();
    if (isComposite(parentVe.displayItem)) { count += 1; }
    return count;
  }

  const infoBoxBoundsPx = (): BoundingBox => {
    const tbBoundsPx = toolboxBoundsPx();
    tbBoundsPx.x += 5;
    tbBoundsPx.y += 5;
    tbBoundsPx.h = infoCount() * 35;
    tbBoundsPx.w += 35;
    return tbBoundsPx;
  }

  const isInTable = (): boolean => {
    return VeFns.isInTable(noteVisualElement());
  }

  const borderVisible = (): boolean => {
    if (compositeItemMaybe() != null) {
      return (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) ? false : true;
    }
    return (noteItem().flags & NoteFlags.HideBorder) ? false : true;
  }

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(noteItem().id); }
  const linkItemIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + noteItem().id); }
  const copyLinkIdClickHandler = (): void => { navigator.clipboard.writeText(noteVisualElement().linkItemMaybe!.id); }
  const linkLinkIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + noteVisualElement().linkItemMaybe!.id); }
  const copyCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(compositeItemMaybe()!.id); }
  const linkCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + compositeItemMaybe()!.id); }

  // determined by trial and error to be the minimum amount needed to be added
  // to a textarea to prevent it from scrolling, given the same text layout as
  // the rendered item. TODO (LOW): this could probably be avoided with some
  // more careful reasoning.
  const HACK_ADJUST_TEXTAREA_HEIGHT = 2.5;

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010; z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <div class="p-[4px]">
          <Show when={userStore.getUserMaybe() != null}>
            <InfuIconButton icon="font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
            <InfuIconButton icon="header-1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
            <InfuIconButton icon="header-2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
            <InfuIconButton icon="header-3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
            <InfuIconButton icon="list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
            <div class="inline-block ml-[12px]"></div>
            <InfuIconButton icon="align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
            <InfuIconButton icon="align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
            <InfuIconButton icon="align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
            <InfuIconButton icon="align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
            <div class="inline-block ml-[12px]"></div>
            <InfuIconButton icon="link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
            <Show when={isInTable()}>
              <InfuIconButton icon="copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
            </Show>
            <InfuIconButton icon="square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
          </Show>
          <InfuIconButton icon={`info-circle-${infoCount()}`} highlighted={false} clickHandler={infoButtonHandler} />
          <Show when={userStore.getUserMaybe() != null}>
            <InfuIconButton icon="trash" highlighted={false} clickHandler={deleteButtonHandler} />
          </Show>
        </div>
      </div>
      <div class={`absolute rounded border`}
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
        <textarea ref={textElement}
          class="rounded overflow-hidden resize-none whitespace-pre-wrap"
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
          disabled={userStore.getUserMaybe() == null}
          onMouseDown={textAreaMouseDownHandler}
          onInput={textAreaOnInputHandler} />
      </div>
      <Show when={urlOverlayVisible.get()}>
        <UrlOverlay urlOverlayVisible={urlOverlayVisible} />
      </Show>
      <Show when={infoOverlayVisible.get()}>
        <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
            style={`left: ${infoBoxBoundsPx().x}px; top: ${infoBoxBoundsPx().y}px; width: ${infoBoxBoundsPx().w}px; height: ${infoBoxBoundsPx().h}px`}>
          <Show when={compositeItemMaybe() != null}>
            <div class="pl-[8px] pr-[8px] pt-[8px]">
              <div class="text-slate-800 text-sm">
                <div class="text-slate-400 w-[85px] inline-block">Composite</div>
                <span class="font-mono text-slate-400">{`${compositeItemMaybe()!.id}`}</span>
                <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyCompositeIdClickHandler} />
                <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkCompositeIdClickHandler} />
              </div>
            </div>
          </Show>
          <Show when={noteVisualElement().linkItemMaybe != null}>
            <div class="pl-[8px] pr-[8px] pt-[8px]">
              <div class="text-slate-800 text-sm">
                <div class="text-slate-400 w-[85px] inline-block">Link</div>
                <span class="font-mono text-slate-400">{`${noteVisualElement()!.linkItemMaybe!.id}`}</span>
                <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyLinkIdClickHandler} />
                <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkLinkIdClickHandler} />
              </div>
            </div>
          </Show>
          <div class="p-[8px]">
            <div class="text-slate-800 text-sm">
              <div class="text-slate-400 w-[85px] inline-block">Item</div>
              <span class="font-mono text-slate-400">{`${noteItem().id}`}</span>
              <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyItemIdClickHandler} />
              <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkItemIdClickHandler} />
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
