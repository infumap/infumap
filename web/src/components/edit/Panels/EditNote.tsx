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

import { Component, Show, onCleanup } from "solid-js";
import { server } from "../../../server";
import { asNoteItem, NoteItem } from "../../../items/note-item";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { InfuButton } from "../../library/InfuButton";
import { InfuTextInput } from "../../library/InfuTextInput";
import { itemState } from "../../../store/ItemState";
import { NoteFlags } from "../../../items/base/flags-item";
import { arrange } from "../../../layout/arrange";


export const EditNote: Component<{noteItem: NoteItem, linkedTo: boolean}> = (props: { noteItem: NoteItem, linkedTo: boolean }) => {
  const desktopStore = useDesktopStore();
  let checkElement_copy: HTMLInputElement | undefined;
  let checkElement_heading: HTMLInputElement | undefined;

  const noteId = props.noteItem.id;
  let deleted = false;

  const handleUrlChange = (v: string) => {
    if (!deleted) {
      asNoteItem(itemState.get(noteId)!).url = v;
      arrange(desktopStore);
    }
  };

  const deleteNote = async () => {
    deleted = true;
    await server.deleteItem(noteId); // throws on failure.
    itemState.delete(noteId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.get(noteId)!);
    }
  });

  const changeShowCopy = async () => {
    if (checkElement_copy!.checked) {
      asNoteItem(itemState.get(noteId)!).flags |= NoteFlags.ShowCopyIcon;
    } else {
      asNoteItem(itemState.get(noteId)!).flags &= ~NoteFlags.ShowCopyIcon;
    }
    arrange(desktopStore);
  }

  const changeDisplayAsHeading = async () => {
    if (checkElement_heading!.checked) {
      asNoteItem(itemState.get(noteId)!).flags |= NoteFlags.Heading1;
    } else {
      asNoteItem(itemState.get(noteId)!).flags &= ~NoteFlags.Heading1;
    }
    arrange(desktopStore);
  }

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Url <InfuTextInput value={props.noteItem.url} onChangeOrCleanup={handleUrlChange} /></div>
      <div>
        <input id="copy" name="copy" type="checkbox" ref={checkElement_copy} checked={(props.noteItem.flags & NoteFlags.ShowCopyIcon) ? true : false} onClick={changeShowCopy} />
        <label for="copy">show copy icon</label>
      </div>
      <div>
        <input id="heading" name="heading" type="checkbox" ref={checkElement_heading} checked={(props.noteItem.flags & NoteFlags.Heading1) ? true : false} onClick={changeDisplayAsHeading} />
        <label for="heading">heading</label>
      </div>
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deleteNote} /></div>
      </Show>
    </div>
  );
}
