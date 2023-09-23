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
import { NoteFns, asNoteItem } from "../../items/note-item";
import { server } from "../../server";
import { InfuIconButton } from "../library/InfuIconButton";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { FONT_SIZE_PX, LINE_HEIGHT_PX, NOTE_PADDING_PX } from "../../constants";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { createBooleanSignal } from "../../util/signals";
import { InfoOverlay } from "./InfoOverlay";
import { desktopPxFromMouseEvent, isInside } from "../../util/geometry";
import { NoteFlags } from "../../items/base/flags-item";
import { UrlOverlay } from "./UrlOverlay";
import { itemState } from "../../store/ItemState";


export const TextEditOverlay: Component = () => {
  const desktopStore = useDesktopStore();

  let textElement: HTMLTextAreaElement | undefined;

  const urlOverlayVisible = createBooleanSignal(false);
  const infoOverlayVisible = createBooleanSignal(false);

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(noteVisualElement());
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);
  const noteItemOnInitialize = noteItem();

  const toolboxBoundsPx = () => {
    return ({
      x: noteVeBoundsPx().x + noteVeBoundsPx().w + 10,
      y: noteVeBoundsPx().y - 2,
      w: 360,
      h: 35
    });
  }

  const sizeBl = () => {
    if (noteVisualElement().flags & VisualElementFlags.InsideComposite) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(noteVisualElement().displayItem));
      cloned.spatialWidthGr = asXSizableItem(VeFns.getCanonicalItem(VesCache.get(noteVisualElement().parentPath!)!.get())).spatialWidthGr;
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (noteVisualElement().linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(noteVisualElement().linkItemMaybe!);
    }
    return NoteFns.calcSpatialDimensionsBl(noteItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (noteVeBoundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (noteVeBoundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    const desktopPx = desktopPxFromMouseEvent(ev);
    if (isInside(desktopPx, noteVeBoundsPx()) || isInside(desktopPx, toolboxBoundsPx())) { return; }
    desktopStore.setTextEditOverlayInfo(null);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const keyDownListener = (ev: KeyboardEvent) => {
    if (ev.code == 'Enter') {
      ev.preventDefault();
      return;
    }
  }


  onCleanup(() => {
    if (!deleted) {
      server.updateItem(noteItemOnInitialize);
    }
  });

  onMount(() => {
    textElement?.focus();
  });

  const urlButtonHandler = () => { urlOverlayVisible.set(!urlOverlayVisible.get()); }
  const infoButtonHandler = () => { infoOverlayVisible.set(!infoOverlayVisible.get()); }

  const textAreaMouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
  }

  const textAreaOnInputHandler = () => {
    noteItem().title = textElement!.value;
    arrange(desktopStore);
  }

  const isNormalText = (): boolean => {
    return (
      !(noteItem().flags & NoteFlags.Heading1) && 
      !(noteItem().flags & NoteFlags.Heading2) &&
      !(noteItem().flags & NoteFlags.Heading3) &&
      !(noteItem().flags & NoteFlags.Bullet1)
    );
  }

  const clearStyle = () => {
    noteItem().flags &= ~NoteFlags.Heading1;
    noteItem().flags &= ~NoteFlags.Heading2;
    noteItem().flags &= ~NoteFlags.Heading3;
    noteItem().flags &= ~NoteFlags.Bullet1;
  }

  const selectNormalText = () => { clearStyle(); arrange(desktopStore); }
  const selectHeading1 = () => { clearStyle(); noteItem().flags |= NoteFlags.Heading1; arrange(desktopStore); }
  const selectHeading2 = () => { clearStyle(); noteItem().flags |= NoteFlags.Heading2; arrange(desktopStore); }
  const selectHeading3 = () => { clearStyle(); noteItem().flags |= NoteFlags.Heading3; arrange(desktopStore); }
  const selectBullet1 = () => { clearStyle(); noteItem().flags |= NoteFlags.Bullet1; arrange(desktopStore); }

  const isAlignLeft = () => {
    return (
      !(noteItem().flags & NoteFlags.AlignCenter) && 
      !(noteItem().flags & NoteFlags.AlignJustify) &&
      !(noteItem().flags & NoteFlags.AlignRight)
    );
  }

  const clearAlignment = () => {
    noteItem().flags &= ~NoteFlags.AlignCenter;
    noteItem().flags &= ~NoteFlags.AlignRight;
    noteItem().flags &= ~NoteFlags.AlignJustify;
  }

  const selectAlignLeft = () => { clearAlignment(); arrange(desktopStore); }
  const selectAlignCenter = () => { clearAlignment(); noteItem().flags |= NoteFlags.AlignCenter; arrange(desktopStore); }
  const selectAlignRight = () => { clearAlignment(); noteItem().flags |= NoteFlags.AlignRight; arrange(desktopStore); }
  const selectAlignJustify = () => { clearAlignment(); noteItem().flags |= NoteFlags.AlignJustify; arrange(desktopStore); }

  let deleted = false;

  const deleteButtonHandler = async () => {
    deleted = true;
    await server.deleteItem(noteItem().id); // throws on failure.
    itemState.delete(noteItem().id);
    desktopStore.setTextEditOverlayInfo(null);
    arrange(desktopStore);
  }

  const copyButtonHandler = () => {
    if (noteItem().flags & NoteFlags.ShowCopyIcon) {
      noteItem().flags &= ~NoteFlags.ShowCopyIcon;
    } else {
      noteItem().flags |= NoteFlags.ShowCopyIcon;
    }
    arrange(desktopStore);
  }

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000010;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}
         onKeyDown={keyDownListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <div class="p-[4px]">
          <InfuIconButton icon="font" highlighted={isNormalText()} clickHandler={selectNormalText} />
          <InfuIconButton icon="header-1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="header-2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
          <InfuIconButton icon="header-3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
          <InfuIconButton icon="list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
          <div class="inline-block ml-[12px]"></div>
          <InfuIconButton icon="align-left" highlighted={isAlignLeft()} clickHandler={selectAlignLeft} />
          <InfuIconButton icon="align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
          <InfuIconButton icon="align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
          <InfuIconButton icon="align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
          <div class="inline-block ml-[12px]"></div>
          <InfuIconButton icon="copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
          <InfuIconButton icon="link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
          <InfuIconButton icon="info-circle" highlighted={false} clickHandler={infoButtonHandler} />
          <InfuIconButton icon="trash" highlighted={false} clickHandler={deleteButtonHandler} />
        </div>
      </div>
      <div class={`absolute rounded border`}
           style={`left: ${noteVeBoundsPx().x}px; top: ${noteVeBoundsPx().y}px; width: ${noteVeBoundsPx().w}px; height: ${noteVeBoundsPx().h}px;`}>
        <textarea ref={textElement}
          class="rounded"
          style={`position: absolute; left: ${NOTE_PADDING_PX}px; top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)}px; ` +
                 `width: ${naturalWidthPx()}px; height: ${naturalHeightPx()*heightScale()/widthScale()}px; ` +
                 `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; transform: scale(${textBlockScale()}); ` +
                 `transform-origin: top left; overflow-wrap: break-word; resize: none; outline: none; border: 0; padding: 0;`}
          value={noteItem().title}
          onMouseDown={textAreaMouseDownHandler}
          onInput={textAreaOnInputHandler} />
      </div>
      <Show when={urlOverlayVisible.get()}>
        <UrlOverlay urlOverlayVisible={urlOverlayVisible} />
      </Show>
      <Show when={infoOverlayVisible.get()}>
        <InfoOverlay infoOverlayVisible={infoOverlayVisible} />
      </Show>
    </div>
  );
}
