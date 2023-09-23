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

import { Component } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { VesCache } from "../../layout/ves-cache";
import { VeFns } from "../../layout/visual-element";
import { InfuIconButton } from "../library/InfuIconButton";
import { BooleanSignal } from "../../util/signals";
import { desktopPxFromMouseEvent, isInside } from "../../util/geometry";
import { asNoteItem } from "../../items/note-item";
import { NoteFlags } from "../../items/base/flags-item";
import { arrange } from "../../layout/arrange";


export const StyleSelectOverlay: Component<{styleOverlayVisible: BooleanSignal}> = (props: { styleOverlayVisible: BooleanSignal }) => {
  const desktopStore = useDesktopStore();

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.noteItemPath)!.get();
  const noteVeBoundsPx = () => VeFns.veBoundsRelativeToDesktopPx(noteVisualElement());
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);

  const toolboxBoundsPx = () => {
    return ({
      x: noteVeBoundsPx().x + noteVeBoundsPx().w + 15,
      y: noteVeBoundsPx().y + 3,
      w: 55,
      h: 120
    });
  }

  const mouseDownListener = (ev: MouseEvent) => {
    ev.stopPropagation();
    const desktopPx = desktopPxFromMouseEvent(ev);
    if (isInside(desktopPx, noteVeBoundsPx()) || isInside(desktopPx, toolboxBoundsPx())) { return; }
    props.styleOverlayVisible.set(false);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

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

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <InfuIconButton icon="font" highlighted={isNormalText()} clickHandler={selectNormalText} />
        <InfuIconButton icon="header-1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
        <InfuIconButton icon="header-2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        <InfuIconButton icon="header-3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <InfuIconButton icon="list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
      </div>
    </div>
  );
}
