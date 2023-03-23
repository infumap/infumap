/*
  Copyright (C) 2022 The Infumap Authors
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
import { server } from "../../server";
import { asNoteItem, NoteItem } from "../../store/desktop/items/note-item";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { useGeneralStore } from "../../store/GeneralStoreProvider";


export const EditNote: Component<{noteItem: NoteItem}> = (props: {noteItem: NoteItem}) => {
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  let noteId = () => props.noteItem.id;

  const handleTextChange = (v: string) => { desktopStore.updateItem(noteId(), item => asNoteItem(item).title = v); };
  const handleTextChanged = (v: string) => { server.updateItem(desktopStore.getItem(noteId())!); }
  const handleUrlChange = (v: string) => {
    desktopStore.updateItem(noteId(), item => asNoteItem(item).url = v);
    server.updateItem(desktopStore.getItem(noteId())!);
  };

  const deleteNote = async () => {
    await server.deleteItem(noteId()); // throws on failure.
    desktopStore.deleteItem(noteId());
    generalStore.setEditDialogInfo(null);
  }

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Text <InfuTextInput value={props.noteItem.title} onIncrementalChange={handleTextChange} onChange={handleTextChanged} /></div>
      <div class="text-slate-800 text-sm">Url <InfuTextInput value={props.noteItem.url} onChange={handleUrlChange} /></div>
      <div><InfuButton text="delete" onClick={deleteNote} /></div>
    </div>
  );
}
