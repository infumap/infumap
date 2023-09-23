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


export const AlignmentSelectOverlay: Component<{alignmentOverlayVisible: BooleanSignal}> = (props: { alignmentOverlayVisible: BooleanSignal }) => {
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
    props.alignmentOverlayVisible.set(false);
  };

  const mouseMoveListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

  const mouseUpListener = (ev: MouseEvent) => {
    ev.stopPropagation();
  };

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

  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #00000000;`}
         onmousedown={mouseDownListener}
         onmousemove={mouseMoveListener}
         onmouseup={mouseUpListener}>
      <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
           style={`left: ${toolboxBoundsPx().x}px; top: ${toolboxBoundsPx().y}px; width: ${toolboxBoundsPx().w}px; height: ${toolboxBoundsPx().h}px`}>
        <InfuIconButton icon="align-left" highlighted={isAlignLeft()} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
      </div>
    </div>
  );
}
