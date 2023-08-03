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

import { Component, onCleanup } from "solid-js";
import { server } from "../../server";
import { asNoteItem, NoteItem } from "../../items/note-item";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { InfuTextArea } from "../library/InfuTextArea";
import { arrange } from "../../layout/arrange";
import { itemState } from "../../store/ItemState";
import { ItemFlagsType } from "../../items/base/flags-item";


export const EditNote: Component<{noteItem: NoteItem}> = (props: {noteItem: NoteItem}) => {
  const desktopStore = useDesktopStore();
  let checkElement_copy: HTMLInputElement | undefined;

  const noteId = props.noteItem.id;
  let deleted = false;

  const handleTextInput = (v: string) => {
    asNoteItem(itemState.getItem(noteId)!).title = v;
    arrange(desktopStore);
  };

  const handleUrlChange = (v: string) => {
    if (!deleted) {
      asNoteItem(itemState.getItem(noteId)!).url = v;
      arrange(desktopStore);
    }
  };

  const deleteNote = async () => {
    deleted = true;
    await server.deleteItem(noteId); // throws on failure.
    itemState.deleteItem(noteId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.getItem(noteId)!);
    }
  });

  const changeShowCopy = async () => {
    if (checkElement_copy!.checked) {
      asNoteItem(itemState.getItem(noteId)!).flags |= ItemFlagsType.ShowCopyIcon;
    } else {
      asNoteItem(itemState.getItem(noteId)!).flags &= ~ItemFlagsType.ShowCopyIcon;
    }
    arrange(desktopStore);
  }

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Text <InfuTextArea focus={true} value={props.noteItem.title} onInput={handleTextInput} /></div>
      <div class="text-slate-800 text-sm">Url <InfuTextInput value={props.noteItem.url} onChangeOrCleanup={handleUrlChange} /></div>
      <div>
        <input id="header" name="header" type="checkbox" ref={checkElement_copy} checked={(props.noteItem.flags & ItemFlagsType.ShowCopyIcon) == ItemFlagsType.ShowCopyIcon ? true : false} onClick={changeShowCopy} />
        <label for="header">show copy icon in table</label>
      </div>
      <div><InfuButton text="delete" onClick={deleteNote} /></div>
    </div>
  );
}
